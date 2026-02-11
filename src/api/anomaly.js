import request from './client';

const EXCLUDED_PARAMETERS = new Set([
  'time',
  'timestamp',
  'datetime',
  'recorded_at',
  'recordedAt',
  'TIME',
  'Session Time',
  'System Time',
  'GPS Date & Time',
]);
const ANALYSIS_VERSION = '1.0';

const toNumeric = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const calculateMean = (values = []) =>
  values.reduce((sum, value) => sum + value, 0) / (values.length || 1);

const calculateStd = (values = []) => {
  if (!values.length) return 0;

  const mean = calculateMean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length || 1);

  return Math.sqrt(variance);
};

const collectNumericParameters = (rows = []) => {
  const keys = new Set();

  rows.forEach((row) => {
    if (!row || typeof row !== 'object') {
      return;
    }

    Object.entries(row).forEach(([key, value]) => {
      if (EXCLUDED_PARAMETERS.has(key)) {
        return;
      }

      if (toNumeric(value) !== null) {
        keys.add(key);
      }
    });
  });

  return Array.from(keys);
};

const detectAnomaliesLocally = (rows = []) => {
  if (!rows.length) {
    return null;
  }

  const usedParameters = collectNumericParameters(rows);

  console.debug('[Anomaly] Executing local detection', {
    parameterCount: usedParameters.length,
  });

  const anomalyRows = new Set();
  const parameterCounts = {};
  const rowParameterHits = {};

  usedParameters.forEach((parameter) => {
    const valueEntries = rows
      .map((row, index) => ({ value: toNumeric(row[parameter]), index }))
      .filter(({ value }) => value !== null);
    const values = valueEntries.map(({ value }) => value);

    if (!values.length) {
      parameterCounts[parameter] = 0;
      return;
    }

    const mean = calculateMean(values);
    const std = calculateStd(values) || 1;
    const lower = mean - 2 * std;
    const upper = mean + 2 * std;
    let count = 0;

    valueEntries.forEach(({ value, index }) => {
      if (value < lower || value > upper) {
        anomalyRows.add(index);
        count += 1;
        rowParameterHits[index] = rowParameterHits[index] || new Set();
        rowParameterHits[index].add(parameter);
      }
    });
    parameterCounts[parameter] = count;
  });

  const rawHitCount = Object.values(parameterCounts).reduce(
    (sum, count) => sum + (count || 0),
    0,
  );

  console.debug('[Anomaly] Local filter summary', {
    rawAnomalyCount: rawHitCount,
    uniqueRowCount: anomalyRows.size,
  });

  const anomalies = Array.from(anomalyRows).map((rowIndex) => {
    const row = rows[rowIndex] || {};
    const sessionTime = typeof row.sessionTime === 'number' ? row.sessionTime : row.time;
    const triggeredParameters = rowParameterHits[rowIndex]
      ? Array.from(rowParameterHits[rowIndex])
      : [];
    return {
      id: `row-${rowIndex}`,
      rowIndex,
      time: sessionTime ?? rowIndex,
      parameter:
        triggeredParameters[0] ||
        usedParameters.find(
          (param) => row[param] !== undefined && toNumeric(row[param]) !== null,
        ),
      parameters: triggeredParameters,
      severity: 'Moderate',
      values: row,
    };
  });

  const sortedRows = [...rows].sort((a, b) => {
    const timeA = typeof a.sessionTime === 'number' ? a.sessionTime : toNumeric(a.time) ?? 0;
    const timeB = typeof b.sessionTime === 'number' ? b.sessionTime : toNumeric(b.time) ?? 0;
    return timeA - timeB;
  });

  return {
    analysis_version: ANALYSIS_VERSION,
    summary: {
      n_rows: rows.length,
      n_params_used: usedParameters.length,
      segments_found: anomalies.length,
      top_parameters: Object.entries(parameterCounts).map(([parameter, count]) => ({
        parameter,
        count,
      })),
      flaggedRowCount: anomalyRows.size,
      flaggedPercent: rows.length
        ? Number(((anomalyRows.size / rows.length) * 100).toFixed(4))
        : 0,
      window_size: null,
      stride: null,
      threshold_percentile: null,
    },
    segments: anomalies.map((entry) => ({
      start_time: entry.time ?? entry.rowIndex,
      end_time: entry.time ?? entry.rowIndex,
      severity: 'low',
      score_peak: 0,
      top_drivers: (entry.parameters || []).slice(0, 5).map((parameter) => ({
        parameter,
        error: 0,
      })),
      explanation:
        'Review recommended. Unusual behavior pattern compared to learned normal behavior for this flight.',
    })),
    timeline: {
      time: sortedRows.map((row, index) => {
        const sessionTime = typeof row.sessionTime === 'number' ? row.sessionTime : toNumeric(row.time);
        return Number.isFinite(sessionTime) ? sessionTime : index;
      }),
      score: rows.map(() => 0),
    },
  };
};

export const runFdrAnomalyDetection = async (caseId, { rows = [] } = {}) => {
  const payload = {};

  console.debug('[Anomaly] Starting detection run', {
    caseId,
    parameterCount: 'all',
  });

  try {
    const response = await request(`/cases/${caseId}/fdr/analyze`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (response) {
      console.debug('[Anomaly] Received API anomaly response', {
        anomalyCount:
          response.summary?.segments_found ||
          (Array.isArray(response.segments) ? response.segments.length : null),
      });
      return response;
    }
  } catch (error) {
    console.debug('[Anomaly] API detection unavailable, evaluating local fallback', {
      message: error?.message,
      status: error?.status,
    });
    if (!rows.length) {
      const message =
        error?.message || 'Unable to run anomaly detection for this case.';
      const wrappedError = new Error(message);
      wrappedError.status = error?.status;
      throw wrappedError;
    }
  }

  const localResult = detectAnomaliesLocally(rows);

  if (localResult) {
    console.debug('[Anomaly] Returning local detection result', {
      anomalyCount: localResult.summary?.segments_found,
    });
    return localResult;
  }

  const fallbackError = new Error(
    'Unable to run anomaly detection for this case.',
  );
  throw fallbackError;
};

export default runFdrAnomalyDetection;
