const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { findCaseByNumber, updateCaseCvrPipeline } = require('./cases');
const { createPresignedDownload, deleteObject, downloadObjectAsBuffer, uploadObjectBuffer } = require('./storage');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PYTHON_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'denoise.py');
const TRANSCRIBE_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'transcribe.py');
const TRANSCRIBE_DIARIZE_SCRIPT = path.resolve(
  __dirname,
  '../../..',
  'python_model',
  'transcribe_diarization.py',
);
const EVENT_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'event_detection.py');
const ROLE_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'role_identification.py');
const CHANNEL_SEPARATION_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'channel_separation.py');
const OUTPUT_ROOT = path.resolve(__dirname, '../../cvr_outputs');
const OUTPUT_BUCKET = process.env.MINIO_BUCKET || 'fdr-cvr-data';

const CVR_STEP_NAMES = ['events', 'denoise', 'channels', 'transcription', 'roles', 'emotion'];

const buildOutputPrefix = ({ caseId, caseNumber, runId }) => {
  const safeCaseId = String(caseId || caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeRunId = String(runId || 'run-unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `cases/${safeCaseId}/runs/${safeRunId}/cvr`;
};
const buildDenoisePrefix = (caseNumber) => {
  const safeCaseNumber = String(caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `cases/${safeCaseNumber}/cvr/denoised`;
};
const buildCaseCvrPrefix = (caseNumber) => {
  const safeCaseNumber = String(caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `cases/${safeCaseNumber}/cvr`;
};
const execFileAsync = promisify(execFile);

// Conda envs put CUDA DLLs (e.g. nvrtc-builtins) in dirs that are only on PATH
// after `conda activate`. We spawn python.exe directly, so add them ourselves.
const PYTHON_ENV_DIR = path.dirname(PYTHON_BIN);
const PYTHON_DLL_DIRS = [
  PYTHON_ENV_DIR,
  path.join(PYTHON_ENV_DIR, 'bin'),
  path.join(PYTHON_ENV_DIR, 'Library', 'bin'),
  path.join(PYTHON_ENV_DIR, 'Library', 'mingw-w64', 'bin'),
  path.join(PYTHON_ENV_DIR, 'Library', 'usr', 'bin'),
  path.join(PYTHON_ENV_DIR, 'Scripts'),
];
const buildPythonSpawnEnv = () => ({
  ...process.env,
  PATH: [...PYTHON_DLL_DIRS, process.env.PATH].join(path.delimiter),
});

const normalizeMethod = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'traditional';
  }

  if (['facebook_denoiser'].includes(normalized)) {
    return normalized;
  }

  const error = new Error(`Unsupported denoise method: ${value}`);
  error.status = 400;
  throw error;
};

const findCvrAttachment = (caseData) => {
  const attachments = Array.isArray(caseData.attachments) ? caseData.attachments : [];
  const cvrAttachments = attachments.filter((item) => (item?.type || '').toUpperCase() === 'CVR');
  if (cvrAttachments.length === 0) {
    return null;
  }

  const channelPriority = ['general', 'channel-1', 'channel-2', 'channel-3', 'channel-4'];
  for (let i = 0; i < channelPriority.length; i += 1) {
    const channelId = channelPriority[i];
    const match = cvrAttachments.find(
      (item) =>
        item?.channel === channelId ||
        item?.channelId === channelId ||
        String(item?.channelLabel || '').toLowerCase().includes(channelId.replace('-', ' ')),
    );
    if (match) {
      return match;
    }
  }

  return cvrAttachments[0];
};

const resolveSourceAttachment = (caseData, sourceObjectKey) => {
  if (!sourceObjectKey) {
    return findCvrAttachment(caseData);
  }

  const attachments = Array.isArray(caseData.attachments) ? caseData.attachments : [];
  return attachments.find(
    (item) =>
      (item?.type || '').toUpperCase() === 'CVR' && item?.storage?.objectKey === sourceObjectKey,
  );
};

const buildOriginalCachePath = async (caseNumber, objectKey) => {
  const safeCaseNumber = String(caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeKey = String(objectKey || 'original')
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .slice(0, 180);
  const cacheDir = path.join(OUTPUT_ROOT, safeCaseNumber, 'original');
  await fs.mkdir(cacheDir, { recursive: true });
  return path.join(cacheDir, safeKey);
};

const loadOriginalAudioBuffer = async (caseNumber, attachment) => {
  if (!attachment || !attachment.storage || !attachment.storage.objectKey) {
    const error = new Error('No CVR attachment found for this case.');
    error.status = 404;
    throw error;
  }

  const cachePath = await buildOriginalCachePath(caseNumber, attachment.storage.objectKey);

  try {
    const buffer = await downloadObjectAsBuffer({
      bucket: attachment.storage.bucket,
      objectKey: attachment.storage.objectKey,
    });
    try {
      await fs.writeFile(cachePath, buffer);
    } catch (_error) {
      // ignore cache write failures
    }
    return buffer;
  } catch (_error) {
    try {
      return await fs.readFile(cachePath);
    } catch (error) {
      const wrapped = new Error('CVR audio file not found. Please re-upload the file.');
      wrapped.status = 404;
      wrapped.cause = error;
      throw wrapped;
    }
  }
};

const ensureOutputDirectory = async (caseNumber, runId, stepName) => {
  const safeCaseNumber = String(caseNumber || '').replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeRunId = String(runId || 'run-unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeStep = String(stepName || 'misc').replace(/[^a-zA-Z0-9-_]/g, '_');
  const outputDir = path.join(OUTPUT_ROOT, safeCaseNumber, safeRunId, safeStep);
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
};

const buildRunId = (providedRunId) => {
  const trimmed = String(providedRunId || '').trim();
  if (trimmed) {
    return trimmed.replace(/[^a-zA-Z0-9-_]/g, '_');
  }
  return `cvr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const buildBaseCvrPipeline = (existingPipeline = {}, runId) => {
  const nextSteps = { ...(existingPipeline.steps || {}) };
  CVR_STEP_NAMES.forEach((stepName) => {
    if (!nextSteps[stepName]) {
      nextSteps[stepName] = {
        status: stepName === 'emotion' ? 'unavailable' : 'pending',
        updatedAt: new Date().toISOString(),
      };
    }
  });

  return {
    version: existingPipeline.version || 2,
    runId: runId || existingPipeline.runId || null,
    current: existingPipeline.current || 'events',
    stepOrder: CVR_STEP_NAMES,
    steps: nextSteps,
  };
};

const persistStepRunning = async ({ caseData, stepName, runId, startedAt, user }) => {
  const existingPipeline = caseData?.analyses?.cvr?.pipeline || {};
  const nextPipeline = buildBaseCvrPipeline(existingPipeline, runId);
  nextPipeline.current = stepName;
  nextPipeline.steps[stepName] = {
    ...(nextPipeline.steps[stepName] || {}),
    status: 'running',
    startedAt,
    updatedAt: startedAt,
  };

  const updatedCase = await updateCaseCvrPipeline(caseData.caseNumber, nextPipeline, { user });
  return {
    pipeline: updatedCase?.analyses?.cvr?.pipeline || nextPipeline,
    caseData: updatedCase || caseData,
  };
};

const persistStepFailure = async ({ caseData, stepName, runId, startedAt, error, user }) => {
  const failedAt = new Date().toISOString();
  const existingPipeline = caseData?.analyses?.cvr?.pipeline || {};
  const nextPipeline = buildBaseCvrPipeline(existingPipeline, runId);
  nextPipeline.current = stepName;
  nextPipeline.steps[stepName] = {
    ...(nextPipeline.steps[stepName] || {}),
    status: 'failed',
    startedAt: startedAt || nextPipeline.steps?.[stepName]?.startedAt || failedAt,
    updatedAt: failedAt,
    completedAt: failedAt,
    error: String(error?.message || 'Step failed.'),
    errorMessage: String(error?.message || 'Step failed.'),
  };

  const updatedCase = await updateCaseCvrPipeline(caseData.caseNumber, nextPipeline, { user });
  return {
    pipeline: updatedCase?.analyses?.cvr?.pipeline || nextPipeline,
    caseData: updatedCase || caseData,
  };
};

const persistStepMetadata = async ({ caseData, stepName, runId, startedAt, completedAt, output, user }) => {
  const existingPipeline = caseData?.analyses?.cvr?.pipeline || {};
  const nextPipeline = buildBaseCvrPipeline(existingPipeline, runId);
  nextPipeline.steps[stepName] = {
    ...(nextPipeline.steps[stepName] || {}),
    status: 'completed',
    startedAt,
    completedAt,
    updatedAt: completedAt,
    output,
  };

  const updatedCase = await updateCaseCvrPipeline(caseData.caseNumber, nextPipeline, { user });
  return {
    pipeline: updatedCase?.analyses?.cvr?.pipeline || nextPipeline,
    caseData: updatedCase || caseData,
  };
};

const runPythonDenoise = async ({ inputPath, outputPath, method }) => {
  try {
    await execFileAsync(
      PYTHON_BIN,
      [PYTHON_SCRIPT, '--input', inputPath, '--output', outputPath, '--method', method],
      { timeout: 1000 * 60 * 20, env: buildPythonSpawnEnv() },
    );
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    if (message) {
      const pythonError = new Error(message);
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const formatPythonErrorMessage = (rawMessage = '') => {
  if (process.env.DEBUG_PYTHON_ERRORS === '1') {
    return rawMessage || 'Transcription failed.';
  }
  if (!rawMessage) {
    return '';
  }
  if (rawMessage.includes('PYANNOTE_TOKEN')) {
    return 'Speaker diarization requires a HuggingFace token. Set PYANNOTE_TOKEN and retry.';
  }
  const lines = rawMessage.split('\n').map((line) => line.trim()).filter(Boolean);
  const errorLine =
    lines.find((line) => line.startsWith('RuntimeError:')) ||
    lines.find((line) => line.startsWith('Error:')) ||
    lines.find((line) => line.includes('Exception')) ||
    lines.find((line) => line.toLowerCase().includes('error'));
  if (errorLine) {
    const cleaned = errorLine.replace(/^RuntimeError:\s*/, '').trim();
    return cleaned || 'Transcription failed.';
  }
  const tracebackIndex = rawMessage.lastIndexOf('Traceback');
  if (tracebackIndex !== -1) {
    const tail = rawMessage.slice(tracebackIndex).split('\n').filter(Boolean);
    const lastLine = tail[tail.length - 1] || '';
    const cleaned = lastLine.replace(/^RuntimeError:\s*/, '').trim();
    return cleaned || 'Transcription failed.';
  }
  return 'Transcription failed.';
};

const runPythonTranscription = async ({
  inputPath,
  outputPath,
  model,
  modelType,
  useTimestamps,
  diarization,
}) => {
  const scriptToUse = diarization ? TRANSCRIBE_DIARIZE_SCRIPT : TRANSCRIBE_SCRIPT;
  const args = [scriptToUse, inputPath, '--output', outputPath];
  if (model) {
    args.push('--model', model);
  }
  if (modelType) {
    args.push('--model-type', modelType);
  }
  if (useTimestamps === false) {
    args.push('--no-timestamps');
  }
  if (process.env.DIARIZATION_DEVICE) {
    args.push('--device', process.env.DIARIZATION_DEVICE);
  }

  try {
    await execFileAsync(PYTHON_BIN, args, { timeout: 1000 * 60 * 60, env: buildPythonSpawnEnv() });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    if (message) {
      const pythonError = new Error(formatPythonErrorMessage(message));
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const buildTranscriptName = (caseNumber, model) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeModel = String(model || 'whisper-large-v3').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `${caseNumber}-cvr-transcript-${safeModel}-${timestamp}`;
};

const buildRoleName = (caseNumber, model) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeModel = String(model || 'ollama').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `${caseNumber}-cvr-roles-${safeModel}-${timestamp}`;
};

const buildEventName = (caseNumber) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${caseNumber}-cvr-events-${timestamp}`;
};

const resolveTranscriptionInput = async (caseData, caseNumber, runId) => {
  const pipeline = caseData?.analyses?.cvr?.pipeline;
  const denoiseStep = pipeline?.steps?.denoise;
  const denoiseOutputId = denoiseStep?.output?.outputId;
  if (denoiseStep?.status === 'completed' && denoiseOutputId) {
    const denoisedObjectKey = denoiseStep?.output?.artifacts?.audioWav?.storage?.objectKey;
    return {
      bucket: OUTPUT_BUCKET,
      objectKey: denoisedObjectKey || `${buildDenoisePrefix(caseNumber)}/${denoiseOutputId}`,
      source: 'denoised',
    };
  }

  let cvrAttachment = findCvrAttachment(caseData);
  if (!cvrAttachment || !cvrAttachment.storage || !cvrAttachment.storage.objectKey) {
    const error = new Error('No CVR attachment found for this case.');
    error.status = 404;
    throw error;
  }

  return {
    bucket: cvrAttachment.storage.bucket,
    objectKey: cvrAttachment.storage.objectKey,
    source: 'original',
  };
};

const resolveOriginalInput = (caseData, options = {}) => {
  const cvrAttachment = resolveSourceAttachment(caseData, options.sourceObjectKey);
  if (!cvrAttachment || !cvrAttachment.storage || !cvrAttachment.storage.objectKey) {
    const error = new Error(options.sourceObjectKey
      ? 'Requested CVR source audio was not found for this case.'
      : 'No CVR attachment found for this case.');
    error.status = 404;
    throw error;
  }
  return {
    bucket: cvrAttachment.storage.bucket,
    objectKey: cvrAttachment.storage.objectKey,
    source: 'original',
  };
};

const buildOutputName = (caseNumber, method) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${caseNumber}-cvr-denoise-${method}-${timestamp}.wav`;
};

const denoiseCvrForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const cvrAttachment = resolveSourceAttachment(caseData, options.sourceObjectKey);
  if (!cvrAttachment || !cvrAttachment.storage || !cvrAttachment.storage.objectKey) {
    const error = new Error(options.sourceObjectKey
      ? 'Requested CVR source audio was not found for this case.'
      : 'No CVR attachment found for this case.');
    error.status = 404;
    throw error;
  }

  const method = normalizeMethod(options.method);
  const startedAt = new Date().toISOString();
  const runId = buildRunId(options.runId || caseData?.analyses?.cvr?.pipeline?.runId);
  const user = options.user;
  const runningPersist = await persistStepRunning({ caseData, stepName: 'denoise', runId, startedAt, user });
  const pipelineCaseData = runningPersist.caseData || caseData;
  let fileBuffer;
  try {
    fileBuffer = await loadOriginalAudioBuffer(caseNumber, cvrAttachment);
  } catch (error) {
    await persistStepFailure({
      caseData: pipelineCaseData,
      stepName: 'denoise',
      runId,
      startedAt,
      error: new Error('missing_file'),
      user,
    });
    const wrapped = new Error('CVR audio file not found. Please re-upload the file.');
    wrapped.status = 404;
    throw wrapped;
  }

  const extension = path.extname(cvrAttachment.storage.objectKey || '') || '.wav';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-denoise-'));
  const tempInputPath = path.join(tempDir, `cvr-input${extension}`);

  const outputDir = await ensureOutputDirectory(caseNumber, runId, 'denoise');
  const outputName = buildOutputName(caseNumber, method);
  const outputPath = path.join(outputDir, outputName);
  const outputObjectKey = `${buildDenoisePrefix(caseNumber)}/${outputName}`;
  try {
    await fs.writeFile(tempInputPath, fileBuffer);
    await runPythonDenoise({ inputPath: tempInputPath, outputPath, method });
    const outputBuffer = await fs.readFile(outputPath);
    const uploaded = await uploadObjectBuffer({
      bucket: OUTPUT_BUCKET,
      objectKey: outputObjectKey,
      body: outputBuffer,
      contentType: 'audio/wav',
    });
    const presigned = await createPresignedDownload({
      bucket: uploaded.bucket,
      objectKey: uploaded.objectKey,
      fileName: outputName,
      contentType: 'audio/wav',
    });

    const completedAt = new Date().toISOString();
    const output = {
      caseNumber,
      runId,
      method,
      outputId: outputName,
      storage: uploaded,
      minioDownloadUrl: presigned.downloadUrl,
      downloadUrl: `/api/cases/${encodeURIComponent(caseNumber)}/cvr/denoise/${encodeURIComponent(
        outputName,
      )}`,
      artifacts: {
        audioWav: {
          storage: uploaded,
          minioDownloadUrl: presigned.downloadUrl,
          apiDownloadUrl: `/api/cases/${encodeURIComponent(caseNumber)}/cvr/denoise/${encodeURIComponent(outputName)}`,
        },
      },
      summaryStats: {
        outputDurationSeconds: null,
      },
    };

    const persisted = await persistStepMetadata({
      caseData: pipelineCaseData,
      stepName: 'denoise',
      runId,
      startedAt,
      completedAt,
      output,
      user,
    });

    return {
      ...output,
      pipeline: persisted.pipeline,
    };
  } catch (error) {
    await persistStepFailure({ caseData: pipelineCaseData, stepName: 'denoise', runId, startedAt, error, user });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const resolveDenoiseOutputPath = async (caseNumber, outputId) => {
  const safeOutputId = path.basename(outputId || '');
  if (!safeOutputId || safeOutputId !== outputId) {
    const error = new Error('Invalid output identifier.');
    error.status = 400;
    throw error;
  }

  const caseRoot = path.join(OUTPUT_ROOT, String(caseNumber || '').replace(/[^a-zA-Z0-9-_]/g, '_'));
  let outputPath = path.join(caseRoot, safeOutputId);

  const locateNestedOutput = async () => {
    try {
      const runDirs = await fs.readdir(caseRoot, { withFileTypes: true });
      for (let i = 0; i < runDirs.length; i += 1) {
        const runDir = runDirs[i];
        if (!runDir.isDirectory()) {
          continue;
        }
        const candidate = path.join(caseRoot, runDir.name, 'denoise', safeOutputId);
        try {
          const stats = await fs.stat(candidate);
          if (stats.isFile()) {
            return candidate;
          }
        } catch (_error) {
          // continue search
        }
      }
    } catch (_error) {
      return null;
    }
    return null;
  };

  try {
    const stats = await fs.stat(outputPath);
    if (!stats.isFile()) {
      throw new Error('Not a file');
    }
  } catch (_error) {
    const nestedMatch = await locateNestedOutput();
    if (!nestedMatch) {
      const error = new Error('Denoised output not found.');
      error.status = 404;
      throw error;
    }
    outputPath = nestedMatch;
  }

  return outputPath;
};

const transcribeCvrForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const model = options.model || 'openai/whisper-large-v3';
  const modelType = options.modelType || 'transformers';
  const diarization = Boolean(options.diarization);
  const useTimestamps = diarization ? true : options.useTimestamps !== false;
  const requestedSource = String(options.source || '').trim().toLowerCase();
  const startedAt = new Date().toISOString();
  const runId = buildRunId(options.runId || caseData?.analyses?.cvr?.pipeline?.runId);
  const user = options.user;
  const runningPersist = await persistStepRunning({
    caseData,
    stepName: 'transcription',
    runId,
    startedAt,
    user,
  });
  const pipelineCaseData = runningPersist.caseData || caseData;
  const denoiseStep = pipelineCaseData?.analyses?.cvr?.pipeline?.steps?.denoise;

  let inputTarget;
  let allowFallback = true;
  if (requestedSource === 'original') {
    inputTarget = resolveOriginalInput(caseData, options);
    allowFallback = false;
  } else if (requestedSource === 'denoised') {
    const pipeline = pipelineCaseData?.analyses?.cvr?.pipeline;
    const denoiseStep = pipeline?.steps?.denoise;
    if (denoiseStep?.status !== 'completed' || !denoiseStep?.output?.outputId) {
      const error = new Error('No denoised output is available for this case.');
      error.status = 400;
      throw error;
    }
    inputTarget = await resolveTranscriptionInput(pipelineCaseData, caseNumber, runId);
    allowFallback = false;
  } else {
    inputTarget = await resolveTranscriptionInput(pipelineCaseData, caseNumber, runId);
  }
  let fileBuffer;
  if (inputTarget.source === 'denoised') {
    try {
      const outputPath = await resolveDenoiseOutputPath(caseNumber, denoiseStep?.output?.outputId);
      fileBuffer = await fs.readFile(outputPath);
    } catch (_error) {
      // fall through to object storage or original fallback
    }
  }

  if (!fileBuffer) {
    if (inputTarget.source === 'original') {
      const attachment = resolveSourceAttachment(pipelineCaseData, options.sourceObjectKey);
      try {
        fileBuffer = await loadOriginalAudioBuffer(caseNumber, attachment);
      } catch (error) {
        await persistStepFailure({
          caseData: pipelineCaseData,
          stepName: 'transcription',
          runId,
          startedAt,
          error: new Error('missing_file'),
          user,
        });
        const wrapped = new Error('CVR audio file not found. Please re-upload the file.');
        wrapped.status = 404;
        throw wrapped;
      }
    } else {
      try {
        fileBuffer = await downloadObjectAsBuffer({
          bucket: inputTarget.bucket,
          objectKey: inputTarget.objectKey,
        });
      } catch (error) {
        if (inputTarget.source === 'denoised') {
          if (allowFallback) {
            inputTarget = resolveOriginalInput(pipelineCaseData, options);
            const attachment = resolveSourceAttachment(pipelineCaseData, options.sourceObjectKey);
            fileBuffer = await loadOriginalAudioBuffer(caseNumber, attachment);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-transcribe-'));
  const tempInputPath = path.join(tempDir, 'cvr-input.wav');
  const outputDir = await ensureOutputDirectory(caseNumber, runId, 'transcription');
  const outputName = buildTranscriptName(caseNumber, model);
  const jsonOutputName = `${outputName}.json`;
  const txtOutputName = `${outputName}.txt`;
  const outputPath = path.join(outputDir, jsonOutputName);
  const outputPrefix = buildCaseCvrPrefix(caseNumber);
  const outputObjectKey = `${outputPrefix}/transcripts/${jsonOutputName}`;
  const textObjectKey = `${outputPrefix}/transcripts/${txtOutputName}`;

  try {
    await fs.writeFile(tempInputPath, fileBuffer);
    await runPythonTranscription({
      inputPath: tempInputPath,
      outputPath,
      model,
      modelType,
      useTimestamps,
      diarization,
    });

    const resultRaw = await fs.readFile(outputPath, 'utf8');
    const resultJson = JSON.parse(resultRaw);
    const firstResult = Array.isArray(resultJson) ? resultJson[0] : resultJson;
    const transcriptText = firstResult?.transcription || '';
    const diarizationResult = firstResult?.diarization || null;
    const diarizedTranscript = firstResult?.diarized_transcript || null;
    const diarizationError = firstResult?.diarization_error || null;

    const outputBuffer = await fs.readFile(outputPath);
    const uploaded = await uploadObjectBuffer({
      bucket: OUTPUT_BUCKET,
      objectKey: outputObjectKey,
      body: outputBuffer,
      contentType: 'application/json',
    });

    const txtOutputPath = path.join(outputDir, txtOutputName);
    await fs.writeFile(txtOutputPath, transcriptText, 'utf8');
    await uploadObjectBuffer({
      bucket: OUTPUT_BUCKET,
      objectKey: textObjectKey,
      body: await fs.readFile(txtOutputPath),
      contentType: 'text/plain; charset=utf-8',
    });

    const completedAt = new Date().toISOString();
    const output = {
      caseNumber,
      runId,
      model,
      modelType,
      source: inputTarget.source,
      transcriptText,
      diarization: diarizationResult,
      diarizedTranscript,
      diarizationError,
      storage: uploaded,
      textObjectKey,
      artifacts: {
        transcriptJson: {
          storage: uploaded,
        },
        transcriptText: {
          storage: { bucket: OUTPUT_BUCKET, objectKey: textObjectKey },
        },
      },
      summaryStats: {
        transcriptLength: transcriptText.length,
        diarizedSegments: Array.isArray(diarizedTranscript) ? diarizedTranscript.length : 0,
        speakersCount: Array.isArray(diarizationResult)
          ? new Set(diarizationResult.map((item) => item?.speaker).filter(Boolean)).size
          : 0,
      },
    };

    const persisted = await persistStepMetadata({
      caseData: pipelineCaseData,
      stepName: 'transcription',
      runId,
      startedAt,
      completedAt,
      output,
      user,
    });

    return {
      ...output,
      pipeline: persisted.pipeline,
    };
  } catch (error) {
    await persistStepFailure({
      caseData: pipelineCaseData,
      stepName: 'transcription',
      runId,
      startedAt,
      error,
      user,
    });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const runPythonRoleIdentification = async ({ inputPath, outputPath, model, ollamaUrl }) => {
  const args = [ROLE_SCRIPT, '--input', inputPath, '--output', outputPath];
  if (model) {
    args.push('--model', model);
  }
  if (ollamaUrl) {
    args.push('--ollama-url', ollamaUrl);
  }

  try {
    await execFileAsync(PYTHON_BIN, args, { timeout: 1000 * 60 * 10, env: buildPythonSpawnEnv() });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    if (message) {
      const pythonError = new Error(formatPythonErrorMessage(message));
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const runPythonEventDetection = async ({ inputPath, outputPath, methods, threshold }) => {
  const args = [EVENT_SCRIPT, inputPath, '--output', outputPath];
  if (Array.isArray(methods) && methods.length > 0) {
    args.push('--methods', ...methods);
  }
  if (threshold != null) {
    args.push('--threshold', String(threshold));
  }

  try {
    await execFileAsync(PYTHON_BIN, args, { timeout: 1000 * 60 * 20, env: buildPythonSpawnEnv() });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    if (message) {
      const pythonError = new Error(formatPythonErrorMessage(message));
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const runPythonChannelSeparation = async ({ inputPath, outputDir, manifestPath }) => {
  const args = [
    CHANNEL_SEPARATION_SCRIPT,
    inputPath,
    '--output-dir',
    outputDir,
    '--manifest',
    manifestPath,
  ];

  try {
    await execFileAsync(PYTHON_BIN, args, { timeout: 1000 * 60 * 20, env: buildPythonSpawnEnv() });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    if (message) {
      const pythonError = new Error(formatPythonErrorMessage(message));
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const resolveLatestTranscript = async (caseNumber) => {
  const caseRoot = path.join(OUTPUT_ROOT, String(caseNumber || '').replace(/[^a-zA-Z0-9-_]/g, '_'));
  const candidates = [];

  const legacyDir = caseRoot;
  try {
    const legacyEntries = await fs.readdir(legacyDir);
    legacyEntries
      .filter((name) => name.includes('-cvr-transcript-') && name.endsWith('.json'))
      .forEach((name) => candidates.push(path.join(legacyDir, name)));
  } catch (_error) {
    // ignore legacy layout misses
  }

  try {
    const runDirs = await fs.readdir(caseRoot, { withFileTypes: true });
    for (let i = 0; i < runDirs.length; i += 1) {
      const runDir = runDirs[i];
      if (!runDir.isDirectory()) {
        continue;
      }
      const transcriptionDir = path.join(caseRoot, runDir.name, 'transcription');
      try {
        const entries = await fs.readdir(transcriptionDir);
        entries
          .filter((name) => name.includes('-cvr-transcript-') && name.endsWith('.json'))
          .forEach((name) => candidates.push(path.join(transcriptionDir, name)));
      } catch (_error) {
        // ignore missing run transcription directories
      }
    }
  } catch (_error) {
    // no run directories
  }

  if (candidates.length === 0) {
    return null;
  }
  const withStats = await Promise.all(
    candidates.map(async (filePath) => ({
      filePath,
      stat: await fs.stat(filePath),
    })),
  );
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return withStats[0].filePath;
};

const buildUtterancesFromTranscript = (result) => {
  if (!result) {
    return [];
  }
  if (Array.isArray(result.utterances) && result.utterances.length > 0) {
    return result.utterances;
  }
  const diarized = result.diarized_transcript || result.diarizedTranscript;
  if (Array.isArray(diarized) && diarized.length > 0) {
    return diarized.map((segment) => ({
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    }));
  }
  return [];
};

const identifyCvrRolesForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const model = options.model || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  const ollamaUrl = options.ollamaUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
  const startedAt = new Date().toISOString();
  const runId = buildRunId(options.runId || caseData?.analyses?.cvr?.pipeline?.runId);
  const user = options.user;
  const runningPersist = await persistStepRunning({ caseData, stepName: 'roles', runId, startedAt, user });
  const pipelineCaseData = runningPersist.caseData || caseData;

  let transcriptResult = null;
  const pipeline = pipelineCaseData?.analyses?.cvr?.pipeline;
  const pipelineOutput = pipeline?.steps?.transcription?.output;
  if (pipelineOutput) {
    transcriptResult = pipelineOutput;
  } else {
    const latestTranscript = await resolveLatestTranscript(caseNumber);
    if (latestTranscript) {
      const raw = await fs.readFile(latestTranscript, 'utf8');
      const json = JSON.parse(raw);
      transcriptResult = Array.isArray(json) ? json[0] : json;
    }
  }

  const utterances = buildUtterancesFromTranscript(transcriptResult);
  if (!utterances.length) {
    const error = new Error('No diarized transcript is available for role identification.');
    error.status = 400;
    throw error;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-roles-'));
  const inputPath = path.join(tempDir, 'roles-input.json');
  const outputDir = await ensureOutputDirectory(caseNumber, runId, 'roles');
  const outputName = `${buildRoleName(caseNumber, model)}.json`;
  const outputPath = path.join(outputDir, outputName);
  const outputObjectKey = `${buildCaseCvrPrefix(caseNumber)}/roles/${outputName}`;

  try {
    await fs.writeFile(inputPath, JSON.stringify({ utterances }, null, 2));
    await runPythonRoleIdentification({ inputPath, outputPath, model, ollamaUrl });

    const raw = await fs.readFile(outputPath, 'utf8');
    const result = JSON.parse(raw);

    await uploadObjectBuffer({
      bucket: OUTPUT_BUCKET,
      objectKey: outputObjectKey,
      body: await fs.readFile(outputPath),
      contentType: 'application/json',
    });

    const completedAt = new Date().toISOString();
    const output = {
      caseNumber,
      runId,
      model,
      summary: 'Role identification completed.',
      speakerRoles: result.speaker_roles || {},
      utterances: result.utterances || utterances,
      storage: { bucket: OUTPUT_BUCKET, objectKey: outputObjectKey },
      artifacts: {
        rolesJson: {
          storage: { bucket: OUTPUT_BUCKET, objectKey: outputObjectKey },
        },
      },
      summaryStats: {
        speakersCount: Object.keys(result.speaker_roles || {}).length,
      },
    };

    const persisted = await persistStepMetadata({
      caseData: pipelineCaseData,
      stepName: 'roles',
      runId,
      startedAt,
      completedAt,
      output,
      user,
    });

    return {
      ...output,
      pipeline: persisted.pipeline,
    };
  } catch (error) {
    await persistStepFailure({ caseData: pipelineCaseData, stepName: 'roles', runId, startedAt, error, user });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const detectCvrEventsForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const cvrAttachment = resolveSourceAttachment(caseData, options.sourceObjectKey);
  const inputTarget = resolveOriginalInput(caseData, options);
  const startedAt = new Date().toISOString();
  const runId = buildRunId(options.runId || caseData?.analyses?.cvr?.pipeline?.runId);
  const user = options.user;
  const runningPersist = await persistStepRunning({ caseData, stepName: 'events', runId, startedAt, user });
  const pipelineCaseData = runningPersist.caseData || caseData;
  let fileBuffer;
  try {
    fileBuffer = await loadOriginalAudioBuffer(caseNumber, cvrAttachment);
  } catch (error) {
    await persistStepFailure({
      caseData: pipelineCaseData,
      stepName: 'events',
      runId,
      startedAt,
      error: new Error('missing_file'),
      user,
    });
    const wrapped = new Error('CVR audio file not found. Please re-upload the file.');
    wrapped.status = 404;
    throw wrapped;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-events-'));
  const tempInputPath = path.join(tempDir, 'cvr-input.wav');
  const outputDir = await ensureOutputDirectory(caseNumber, runId, 'events');
  const outputName = `${buildEventName(caseNumber)}.json`;
  const outputPath = path.join(outputDir, outputName);
  const outputObjectKey = `${buildCaseCvrPrefix(caseNumber)}/events/${outputName}`;

  try {
    await fs.writeFile(tempInputPath, fileBuffer);
    await runPythonEventDetection({
      inputPath: tempInputPath,
      outputPath,
      methods: options.methods,
      threshold: options.threshold,
    });

    const raw = await fs.readFile(outputPath, 'utf8');
    const events = JSON.parse(raw);

    await uploadObjectBuffer({
      bucket: OUTPUT_BUCKET,
      objectKey: outputObjectKey,
      body: await fs.readFile(outputPath),
      contentType: 'application/json',
    });

    const completedAt = new Date().toISOString();
    const output = {
      caseNumber,
      runId,
      events,
      storage: { bucket: OUTPUT_BUCKET, objectKey: outputObjectKey },
      artifacts: {
        eventsJson: {
          storage: { bucket: OUTPUT_BUCKET, objectKey: outputObjectKey },
        },
      },
      summaryStats: {
        eventsCount: Array.isArray(events) ? events.length : 0,
      },
    };

    const persisted = await persistStepMetadata({
      caseData: pipelineCaseData,
      stepName: 'events',
      runId,
      startedAt,
      completedAt,
      output,
      user,
    });

    return {
      ...output,
      pipeline: persisted.pipeline,
    };
  } catch (error) {
    await persistStepFailure({ caseData: pipelineCaseData, stepName: 'events', runId, startedAt, error, user });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const buildChannelSeparationPrefix = (caseNumber) => {
  const safeCaseNumber = String(caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `cases/${safeCaseNumber}/cvr/channels`;
};

const separateCvrChannelsForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const cvrAttachment = resolveSourceAttachment(caseData, options.sourceObjectKey);
  const startedAt = new Date().toISOString();
  const runId = buildRunId(options.runId || caseData?.analyses?.cvr?.pipeline?.runId);
  const user = options.user;
  const runningPersist = await persistStepRunning({ caseData, stepName: 'channels', runId, startedAt, user });
  const pipelineCaseData = runningPersist.caseData || caseData;
  let fileBuffer;
  try {
    fileBuffer = await loadOriginalAudioBuffer(caseNumber, cvrAttachment);
  } catch (error) {
    await persistStepFailure({
      caseData: pipelineCaseData,
      stepName: 'channels',
      runId,
      startedAt,
      error: new Error('missing_file'),
      user,
    });
    const wrapped = new Error('CVR audio file not found. Please re-upload the file.');
    wrapped.status = 404;
    throw wrapped;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-channels-'));
  const tempInputPath = path.join(tempDir, 'cvr-input.wav');
  const tempOutputDir = path.join(tempDir, 'clips');
  const manifestPath = path.join(tempDir, 'manifest.json');
  const outputDir = await ensureOutputDirectory(caseNumber, runId, 'channels');
  const outputPrefix = buildChannelSeparationPrefix(caseNumber);

  try {
    await fs.writeFile(tempInputPath, fileBuffer);
    await runPythonChannelSeparation({
      inputPath: tempInputPath,
      outputDir: tempOutputDir,
      manifestPath,
    });

    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const rawChannels = Array.isArray(manifest.channels) ? manifest.channels : [];

    const channels = [];
    for (const channel of rawChannels) {
      const clipPath = path.join(tempOutputDir, channel.filename);
      const clipBuffer = await fs.readFile(clipPath);
      const persistedClipPath = path.join(outputDir, channel.filename);
      await fs.writeFile(persistedClipPath, clipBuffer);

      const objectKey = `${outputPrefix}/${channel.filename}`;
      const uploaded = await uploadObjectBuffer({
        bucket: OUTPUT_BUCKET,
        objectKey,
        body: clipBuffer,
        contentType: 'audio/wav',
      });
      const presigned = await createPresignedDownload({
        bucket: uploaded.bucket,
        objectKey: uploaded.objectKey,
        fileName: channel.filename,
        contentType: 'audio/wav',
      });

      channels.push({
        speaker: channel.speaker,
        duration: channel.duration,
        segments: channel.segments,
        storage: uploaded,
        downloadUrl: presigned.downloadUrl,
      });
    }

    const completedAt = new Date().toISOString();
    const output = {
      caseNumber,
      runId,
      channels,
      summaryStats: {
        speakerCount: channels.length,
      },
    };

    const persisted = await persistStepMetadata({
      caseData: pipelineCaseData,
      stepName: 'channels',
      runId,
      startedAt,
      completedAt,
      output,
      user,
    });

    return {
      ...output,
      pipeline: persisted.pipeline,
    };
  } catch (error) {
    await persistStepFailure({ caseData: pipelineCaseData, stepName: 'channels', runId, startedAt, error, user });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const deleteLocalOutput = async (caseNumber, outputId) => {
  try {
    const outputPath = await resolveDenoiseOutputPath(caseNumber, outputId);
    await fs.rm(outputPath, { force: true });
  } catch (_error) {
    // ignore local delete failures
  }
};

const deleteDenoiseOutputForCase = async (caseNumber, outputId) => {
  const safeOutputId = path.basename(outputId || '');
  if (!safeOutputId || safeOutputId !== outputId) {
    const error = new Error('Invalid output identifier.');
    error.status = 400;
    throw error;
  }

  const caseData = await findCaseByNumber(caseNumber);
  const runId = caseData?.analyses?.cvr?.pipeline?.runId;

  await deleteLocalOutput(caseNumber, safeOutputId);
  const possibleKeys = [
    `${buildDenoisePrefix(caseNumber)}/${safeOutputId}`,
    `${buildOutputPrefix({ caseId: caseData?.id, caseNumber, runId })}/denoise/${safeOutputId}`,
  ];
  await Promise.all(
    possibleKeys.map((objectKey) =>
      deleteObject({
        bucket: OUTPUT_BUCKET,
        objectKey,
      }).catch(() => null),
    ),
  );

  return { caseNumber, outputId: safeOutputId, deleted: true };
};

module.exports = {
  denoiseCvrForCase,
  resolveDenoiseOutputPath,
  transcribeCvrForCase,
  identifyCvrRolesForCase,
  detectCvrEventsForCase,
  separateCvrChannelsForCase,
  deleteDenoiseOutputForCase,
};
