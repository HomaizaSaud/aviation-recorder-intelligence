const { randomUUID } = require('crypto');

const pool = require('../db/pool');

const toJsonbParameter = (value, fallback = {}) => {
  if (value === undefined || value === null) {
    return JSON.stringify(fallback);
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return JSON.stringify(fallback);
};

const mapRunRow = (row) => ({
  runId: row.run_id,
  caseId: row.case_id,
  createdAt: row.created_at ? row.created_at.toISOString() : null,
  createdBy: row.created_by || null,
  modelName: row.model_name,
  detectionSettings: row.detection_settings || {},
  output: row.output || {},
  summary: row.summary || {},
  charts: row.charts || {},
});

const createFdrAnalysisRun = async ({
  caseId,
  createdBy,
  modelName,
  detectionSettings,
  output,
  summary,
  charts,
}) => {
  const runId = randomUUID();
  const query = `
    INSERT INTO fdr_analysis_runs (
      run_id,
      case_id,
      created_by,
      model_name,
      detection_settings,
      output,
      summary,
      charts
    )
    VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
    RETURNING *
  `;

  const values = [
    runId,
    caseId,
    toJsonbParameter(createdBy, {}),
    modelName,
    toJsonbParameter(detectionSettings, {}),
    toJsonbParameter(output, {}),
    toJsonbParameter(summary, {}),
    toJsonbParameter(charts, {}),
  ];

  const { rows } = await pool.query(query, values);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapRunRow(rows[0]);
};

const getLatestFdrAnalysisRun = async (caseId) => {
  const { rows } = await pool.query(
    `SELECT *
     FROM fdr_analysis_runs
     WHERE case_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [caseId],
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapRunRow(rows[0]);
};

const getFdrAnalysisRunById = async (caseId, runId) => {
  const { rows } = await pool.query(
    `SELECT *
     FROM fdr_analysis_runs
     WHERE case_id = $1 AND run_id = $2
     LIMIT 1`,
    [caseId, runId],
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapRunRow(rows[0]);
};

const getLatestFdrAnalysisRuns = async (caseIds) => {
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    return new Map();
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (case_id) *
     FROM fdr_analysis_runs
     WHERE case_id = ANY($1::int[])
     ORDER BY case_id, created_at DESC, id DESC`,
    [caseIds],
  );

  const latestRuns = new Map();
  (rows || []).forEach((row) => {
    if (!row || row.case_id === undefined || row.case_id === null) {
      return;
    }
    latestRuns.set(row.case_id, mapRunRow(row));
  });

  return latestRuns;
};

module.exports = {
  createFdrAnalysisRun,
  getFdrAnalysisRunById,
  getLatestFdrAnalysisRun,
  getLatestFdrAnalysisRuns,
};
