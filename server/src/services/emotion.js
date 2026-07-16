const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { findCaseByNumber } = require('./cases');
const { downloadObjectAsBuffer } = require('./storage');
const { resolveDenoiseOutputPath } = require('./cvr');

const resolvePythonBin = () => {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }

  const candidates = [
    path.join(__dirname, '../../../python_model/venv/bin/python'),
    path.join(__dirname, '../../../python_model/venv/bin/python3'),
    path.join(__dirname, '../../../python_model/venv/Scripts/python.exe'),
    'python3',
    'python',
  ];

  return candidates[0];
};

const PYTHON_BIN = resolvePythonBin();
const EMOTION_SCRIPT = path.resolve(__dirname, '../../..', 'python_model', 'emotion_detection.py');
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
const OUTPUT_ROOT = path.resolve(__dirname, '../../cvr_outputs');
const OUTPUT_BUCKET = process.env.MINIO_BUCKET || 'fdr-cvr-data';
const buildDenoisePrefix = (caseNumber) => {
  const safeCaseNumber = String(caseNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
  return `cases/${safeCaseNumber}/cvr/denoised`;
};

console.log('🐍 PYTHON_BIN:', PYTHON_BIN);
console.log('📜 EMOTION_SCRIPT:', EMOTION_SCRIPT);

const findCvrAttachment = (caseData) => {
  const attachments = Array.isArray(caseData.attachments) ? caseData.attachments : [];
  return attachments.find((item) => (item?.type || '').toUpperCase() === 'CVR');
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error('Failed to parse emotion detection output.');
    wrapped.status = 500;
    throw wrapped;
  }
};

const runEmotionDetection = async (audioPath, backend = 'wavlm') => {
  try {
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      [EMOTION_SCRIPT, '--audio', audioPath, '--backend', backend],
      {
        timeout: 1000 * 60 * 5,
        env: buildPythonSpawnEnv(),
      },
    );
    return parseJson(stdout);
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    console.error('❌ Emotion detection stderr:', stderr || '(empty)');
    console.error('❌ Emotion detection stdout:', stdout || '(empty)');
    console.error('❌ Emotion detection error:', error?.message || error);
    const message = [stderr, stdout].filter(Boolean).join('\n') || 'Emotion detection failed.';
    const wrapped = new Error(message);
    wrapped.status = 400;
    throw wrapped;
  }
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
    const err = new Error('No CVR attachment found for this case.');
    err.status = 404;
    throw err;
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
      const wrapped = new Error('Unable to access CVR audio from object storage or local cache.');
      wrapped.status = 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }
};

const detectEmotionForCase = async (caseNumber, options = {}) => {
    console.log({ message: '🎤 Starting emotion detection for case', caseNumber: String(caseNumber) });
  
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const err = new Error('Case not found');
    err.status = 404;
    throw err;
  }

  const cvrAttachment = findCvrAttachment(caseData);
  console.log('📎 CVR attachment found:', cvrAttachment);
  
  if (!cvrAttachment || !cvrAttachment.storage || !cvrAttachment.storage.objectKey) {
    const err = new Error('No CVR attachment found for this case.');
    err.status = 404;
    throw err;
  }

  const { bucket, objectKey } = cvrAttachment.storage;
  const pipeline = caseData?.analyses?.cvr?.pipeline;
  const denoiseStep = pipeline?.steps?.denoise;
  
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvr-emotion-'));
  const tempAudioPath = path.join(tempDir, 'cvr-audio.wav');

  try {
    let buffer;
    let source = 'original';

    if (denoiseStep?.status === 'completed' && denoiseStep?.output?.outputId) {
      source = 'denoised';
      const outputId = denoiseStep.output.outputId;
      try {
        const outputPath = await resolveDenoiseOutputPath(caseNumber, outputId);
        buffer = await fs.readFile(outputPath);
      } catch (_error) {
        const denoiseObjectKey =
          denoiseStep?.output?.artifacts?.audioWav?.storage?.objectKey ||
          `${buildDenoisePrefix(caseNumber)}/${outputId}`;
        try {
          console.log('📦 Downloading denoised audio from MinIO:', {
            bucket: OUTPUT_BUCKET,
            objectKey: denoiseObjectKey,
          });
          buffer = await downloadObjectAsBuffer({ bucket: OUTPUT_BUCKET, objectKey: denoiseObjectKey });
        } catch (error) {
          console.warn('⚠️ Denoised audio unavailable, falling back to original.', error?.message || error);
          source = 'original';
        }
      }
    }

    if (!buffer) {
      console.log('📦 Downloading original audio from MinIO (with local cache fallback):', { bucket, objectKey });
      buffer = await loadOriginalAudioBuffer(caseNumber, cvrAttachment);
    }
    await fs.writeFile(tempAudioPath, buffer);
    
    const backend = options.backend || 'wavlm';
    console.log('🐍 Running Python emotion detection...', { backend });
    const result = await runEmotionDetection(tempAudioPath, backend);
    console.log('✅ Emotion result:', result);

    return {
      caseNumber,
      source: {
        type: source,
        bucket,
        objectKey,
      },
      emotion: result,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

module.exports = {
  detectEmotionForCase,
};
