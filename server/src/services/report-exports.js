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

const mapExportRow = (row) => ({
  exportId: row.export_id,
  caseId: row.case_id,
  createdAt: row.created_at ? row.created_at.toISOString() : null,
  createdBy: row.created_by || null,
  format: row.format,
  filename: row.filename,
  storageBucket: row.storage_bucket || null,
  storagePath: row.storage_path || null,
  storageUrl: row.storage_url || null,
  linkedRunId: row.linked_run_id || null,
});

const getCaseIdByNumber = async (caseNumber) => {
  const { rows } = await pool.query('SELECT id FROM cases WHERE case_number = $1', [caseNumber]);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0].id;
};

const createReportExport = async ({
  caseId,
  createdBy,
  format,
  filename,
  storageBucket,
  storagePath,
  storageUrl,
  linkedRunId,
}) => {
  const exportId = randomUUID();
  const query = `
    INSERT INTO report_exports (
      export_id,
      case_id,
      created_by,
      format,
      filename,
      storage_bucket,
      storage_path,
      storage_url,
      linked_run_id
    )
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `;

  const values = [
    exportId,
    caseId,
    toJsonbParameter(createdBy, {}),
    format,
    filename,
    storageBucket || null,
    storagePath || null,
    storageUrl || null,
    linkedRunId || null,
  ];

  const { rows } = await pool.query(query, values);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapExportRow(rows[0]);
};

const listReportExportsByCaseId = async (caseId, limit = 5) => {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const { rows } = await pool.query(
    `SELECT *
     FROM report_exports
     WHERE case_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [caseId, normalizedLimit],
  );

  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.map(mapExportRow);
};

const findReportExportById = async ({ caseId, exportId }) => {
  const { rows } = await pool.query(
    `SELECT *
     FROM report_exports
     WHERE case_id = $1
       AND export_id = $2
     LIMIT 1`,
    [caseId, exportId],
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapExportRow(rows[0]);
};

const deleteReportExportById = async ({ caseId, exportId }) => {
  const { rows } = await pool.query(
    `DELETE FROM report_exports
     WHERE case_id = $1
       AND export_id = $2
     RETURNING *`,
    [caseId, exportId],
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapExportRow(rows[0]);
};

module.exports = {
  getCaseIdByNumber,
  createReportExport,
  listReportExportsByCaseId,
  findReportExportById,
  deleteReportExportById,
};
