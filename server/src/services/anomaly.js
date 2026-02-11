const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const {
  findCaseByNumber,
  updateCaseFdrAnalysis,
  updateCaseFdrAnalysisStatus,
} = require('./cases');
const { createFdrAnalysisRun } = require('./fdr-analysis-runs');
const { downloadObjectAsBuffer } = require('./storage');
const fdrParameterMap = require('../config/fdr-parameter-map');

const MODEL_FEATURES = [
  'GPS Altitude',
  'Pressure Altitude',
  'Indicated Airspeed',
  'Ground Speed',
  'True Airspeed',
  'Vertical Speed',
  'Pitch',
  'Roll',
  'Magnetic Heading',
  'RPM Left',
  'RPM Right',
  'Fuel Flow 1',
  'Outside Air Temperature',
  'Latitude',
  'Longitude',
];

const FEATURE_TO_CSV_HEADER = MODEL_FEATURES.reduce((acc, feature) => {
  const metadata = Object.values(fdrParameterMap).find((entry) => entry.label === feature);
  acc[feature] = metadata?.csvKey || feature;
  return acc;
}, {});

const TIMESTAMP_FIELDS = ['GPS Date & Time', 'Session Time', 'System Time'];
const ANALYSIS_VERSION = '1.0';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PYTHON_MODULE = 'services.fdr_anomaly.run_detect';
const PYTHON_CWD = path.resolve(__dirname, '../../..');
const execFileAsync = promisify(execFile);

const parseCsv = (text) => {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines.length === 0) {
    const error = new Error('FDR file is empty or missing.');
    error.status = 400;
    throw error;
  }

  const headers = lines.shift().split(',').map((header) => header.trim());
  const rows = lines.map((line) => {
    const values = line.split(',');
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] !== undefined ? values[index].trim() : '';
    });
    return record;
  });

  return { headers, rows };
};

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value)
    .trim()
    .replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

const percentile = (values, percentileRank) => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentileRank;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
};

const calculateColumnStatsZScore = (headers, rows) => {
  const stats = {};

  headers.forEach((header) => {
    const numericValues = rows
      .map((row) => toNumber(row[header]))
      .filter((value) => !Number.isNaN(value));

    if (numericValues.length === 0) {
      return;
    }

    console.log('[anomaly] numeric column:', header, 'count:', numericValues.length);

    const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
    const variance =
      numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numericValues.length;
    const stdDev = Math.sqrt(variance);
    const threshold = 3 * stdDev;

    stats[header] = {
      mean,
      stdDev,
      lowerBound: mean - threshold,
      upperBound: mean + threshold,
    };
  });

  return stats;
};

const detectAnomaliesZScore = (headers, rows, stats) => {
  const anomalies = [];

  rows.forEach((row, index) => {
    let isAnomalous = false;
    const numericValues = {};
    const triggeredParameters = [];

    headers.forEach((header) => {
      const value = toNumber(row[header]);
      const columnStats = stats[header];

      if (!columnStats || Number.isNaN(value)) {
        return;
      }

      numericValues[header] = value;
      const { stdDev, mean, lowerBound, upperBound } = columnStats;

      if (stdDev === 0 ? value !== mean : value < lowerBound || value > upperBound) {
        isAnomalous = true;
        triggeredParameters.push(header);
      }
    });

    if (isAnomalous) {
      anomalies.push({ rowIndex: index, values: numericValues, parameters: triggeredParameters, row });
    }
  });

  return anomalies;
};

const calculateColumnStatsIqr = (headers, rows) => {
  const stats = {};

  headers.forEach((header) => {
    const numericValues = rows
      .map((row) => toNumber(row[header]))
      .filter((value) => !Number.isNaN(value));

    if (numericValues.length === 0) {
      return;
    }

    console.log('[anomaly] numeric column:', header, 'count:', numericValues.length);

    const q1 = percentile(numericValues, 0.25);
    const q3 = percentile(numericValues, 0.75);
    if (q1 === null || q3 === null) {
      return;
    }

    const iqr = q3 - q1;
    const fence = 1.5 * iqr;

    stats[header] = {
      q1,
      q3,
      iqr,
      lowerBound: q1 - fence,
      upperBound: q3 + fence,
    };
  });

  return stats;
};

const detectAnomaliesIqr = (headers, rows, stats) => {
  const anomalies = [];

  rows.forEach((row, index) => {
    let isAnomalous = false;
    const numericValues = {};
    const triggeredParameters = [];

    headers.forEach((header) => {
      const value = toNumber(row[header]);
      const columnStats = stats[header];

      if (!columnStats || Number.isNaN(value)) {
        return;
      }

      numericValues[header] = value;
      const { lowerBound, upperBound } = columnStats;

      if (value < lowerBound || value > upperBound) {
        isAnomalous = true;
        triggeredParameters.push(header);
      }
    });

    if (isAnomalous) {
      anomalies.push({ rowIndex: index, values: numericValues, parameters: triggeredParameters, row });
    }
  });

  return anomalies;
};

const findFdrAttachment = (caseData) => {
  const attachments = Array.isArray(caseData.attachments) ? caseData.attachments : [];
  return attachments.find((item) => (item?.type || '').toUpperCase() === 'FDR');
};

const normalizeAlgorithm = (algorithmName) => {
  const normalized = typeof algorithmName === 'string' ? algorithmName.toLowerCase() : '';
  switch (normalized) {
    case 'iqr':
    case 'isolation_forest':
    case 'zscore':
      return normalized;
    default:
      return 'zscore';
  }
};

const getAlgorithmHandlers = (algorithmName) => {
  switch (algorithmName) {
    case 'iqr':
      return {
        calculateColumnStats: calculateColumnStatsIqr,
        detectAnomalies: detectAnomaliesIqr,
      };
    case 'isolation_forest':
      return {
        calculateColumnStats: calculateColumnStatsZScore,
        detectAnomalies: detectAnomaliesZScore,
      };
    case 'zscore':
    default:
      return {
        calculateColumnStats: calculateColumnStatsZScore,
        detectAnomalies: detectAnomaliesZScore,
      };
  }
};

const toCsvHeader = (parameterKey) => {
  const normalizedKey = typeof parameterKey === 'string' ? parameterKey.trim() : '';
  if (!normalizedKey) {
    return '';
  }

  const metadata = fdrParameterMap[normalizedKey.toUpperCase()];
  return metadata?.csvKey || normalizedKey;
};

const parsePythonErrorMessage = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  const match = combined.match(/Error:\s*(.+)/i);
  return match?.[1]?.trim() || '';
};

const runPythonDetection = async (filePath) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      ['-m', PYTHON_MODULE, filePath],
      {
        cwd: PYTHON_CWD,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 10,
      },
    );
    if (stderr) {
      console.error('[anomaly] python stderr:', stderr);
    }
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.stderr) {
      console.error('[anomaly] python stderr:', error.stderr);
    }
    const message = parsePythonErrorMessage(error);
    if (message) {
      const pythonError = new Error(message);
      pythonError.status = 400;
      throw pythonError;
    }
    throw error;
  }
};

const analyzeFdrForCase = async (caseNumber, options = {}) => {
  const caseData = await findCaseByNumber(caseNumber);
  if (!caseData) {
    const error = new Error('Case not found');
    error.status = 404;
    throw error;
  }

  const fdrAttachment = findFdrAttachment(caseData);
  if (!fdrAttachment || !fdrAttachment.storage || !fdrAttachment.storage.objectKey) {
    const error = new Error('No FDR attachment found for this case.');
    error.status = 404;
    throw error;
  }

  await updateCaseFdrAnalysisStatus(caseNumber, 'RUNNING');

  const fileBuffer = await downloadObjectAsBuffer({
    bucket: fdrAttachment.storage.bucket,
    objectKey: fdrAttachment.storage.objectKey,
  });

  const extension = path.extname(fdrAttachment.storage.objectKey || '') || '.csv';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fdr-anomaly-'));
  const tempFilePath = path.join(tempDir, `fdr${extension}`);

  const createdBy = (() => {
    const user = options.user;
    if (!user) {
      return null;
    }
    const nameParts = [user.firstName, user.lastName].filter(Boolean);
    const name = nameParts.join(' ').trim();
    return {
      id: user.id,
      name: name || user.email,
      email: user.email,
    };
  })();

  try {
    await fs.writeFile(tempFilePath, fileBuffer);
    const analysis = await runPythonDetection(tempFilePath);
    const payload = {
      ...analysis,
      analysis_version: analysis?.analysis_version || ANALYSIS_VERSION,
    };
    const summary = analysis?.summary || {};
    const detectionSettings = {
      window_size: summary.window_size ?? null,
      stride: summary.stride ?? null,
      threshold_percentile: summary.threshold_percentile ?? null,
      parameters_used_count: summary.n_params_used ?? null,
    };
    const runOutput = {
      analysis_version: payload.analysis_version,
      summary: analysis?.summary || {},
      segments: analysis?.segments || [],
      timeline: analysis?.timeline || null,
    };
    const runSummary = {
      total_rows_reviewed: summary.n_rows ?? null,
      flagged_rows: summary.flaggedRowCount ?? summary.flagged_row_count ?? null,
      flagged_percent: summary.flaggedPercent ?? summary.flagged_percent ?? null,
      segments_found: summary.segments_found ?? null,
    };
    const runCharts = {
      timeline: analysis?.timeline || null,
    };
    const runRecord = await createFdrAnalysisRun({
      caseId: caseData.id,
      createdBy,
      modelName: 'behavioral_autoencoder',
      detectionSettings,
      output: runOutput,
      summary: runSummary,
      charts: runCharts,
    });
    if (runRecord) {
      payload.run_metadata = {
        runId: runRecord.runId,
        createdAt: runRecord.createdAt,
        createdBy: runRecord.createdBy,
        modelName: runRecord.modelName,
      };
    }
    await updateCaseFdrAnalysis(caseNumber, payload, {
      status: 'COMPLETED',
      lastRunId: runRecord?.runId,
      lastRunAt: runRecord?.createdAt || new Date().toISOString(),
    });
    return payload;
  } catch (error) {
    const failedAt = new Date().toISOString();
    let failedRun = null;
    try {
      failedRun = await createFdrAnalysisRun({
        caseId: caseData.id,
        createdBy,
        modelName: 'behavioral_autoencoder',
        detectionSettings: {},
        output: { error: error?.message || 'Anomaly detection failed.' },
        summary: { status: 'failed' },
        charts: {},
      });
    } catch (runError) {
      console.error('[anomaly] unable to record failed run', runError);
    }
    await updateCaseFdrAnalysisStatus(
      caseNumber,
      'FAILED',
      failedRun?.runId || null,
      failedRun?.createdAt || failedAt,
    );
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

module.exports = {
  analyzeFdrForCase,
};
