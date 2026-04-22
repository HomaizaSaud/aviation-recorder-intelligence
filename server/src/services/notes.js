const pool = require('../db/pool');

const mapDbRowToNote = (row) => ({
  id: row.id,
  caseId: row.case_id,
  module: row.module,
  relatedRunId: row.related_run_id,
  author: row.author || {},
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const listNotesByCaseId = async (caseId, { module, relatedRunId } = {}) => {
  const values = [caseId];
  let query = 'SELECT * FROM notes WHERE case_id = $1';

  if (module) {
    values.push(module);
    query += ` AND LOWER(module) = LOWER($${values.length})`;
  }

  if (relatedRunId !== undefined) {
    if (relatedRunId === null) {
      query += ' AND related_run_id IS NULL';
    } else {
      values.push(relatedRunId);
      query += ` AND related_run_id = $${values.length}`;
    }
  }

  query += ' ORDER BY created_at DESC';

  const { rows } = await pool.query(query, values);
  return rows.map(mapDbRowToNote);
};

const findNoteById = async (caseId, noteId) => {
  const { rows } = await pool.query(
    'SELECT * FROM notes WHERE case_id = $1 AND id = $2',
    [caseId, noteId],
  );

  if (rows.length === 0) {
    return null;
  }

  return mapDbRowToNote(rows[0]);
};

const createNote = async ({
  caseId,
  module,
  relatedRunId,
  author,
  content,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO notes (
      case_id,
      module,
      related_run_id,
      author,
      content
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [caseId, module, relatedRunId, author, content],
  );

  return mapDbRowToNote(rows[0]);
};

const updateNote = async ({ caseId, noteId, content }) => {
  const { rows } = await pool.query(
    `UPDATE notes
     SET content = $1, updated_at = NOW()
     WHERE case_id = $2 AND id = $3
     RETURNING *`,
    [content, caseId, noteId],
  );

  if (rows.length === 0) {
    return null;
  }

  return mapDbRowToNote(rows[0]);
};

const deleteNote = async ({ caseId, noteId }) => {
  const { rows } = await pool.query(
    'DELETE FROM notes WHERE case_id = $1 AND id = $2 RETURNING *',
    [caseId, noteId],
  );

  if (rows.length === 0) {
    return null;
  }

  return mapDbRowToNote(rows[0]);
};

const countNotesByCaseId = async (caseId) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM notes WHERE case_id = $1', [
    caseId,
  ]);
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  return Number.parseInt(rows[0].count, 10) || 0;
};

module.exports = {
  listNotesByCaseId,
  findNoteById,
  createNote,
  updateNote,
  deleteNote,
  countNotesByCaseId,
};
