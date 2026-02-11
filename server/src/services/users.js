const pool = require('../db/pool');

const mapDbRowToUser = (row) => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  firstName: row.first_name,
  lastName: row.last_name,
  organization: row.organization,
  jobTitle: row.job_title,
  phone: row.phone,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sanitizeUser = (user) => {
  if (!user) {
    return null;
  }

  const { passwordHash, ...rest } = user;
  return rest;
};

const findUserByEmail = async (email) => {
  const normalizedEmail = email?.toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);

  if (rows.length === 0) {
    return null;
  }

  return mapDbRowToUser(rows[0]);
};

const findUserById = async (id) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);

  if (rows.length === 0) {
    return null;
  }

  return mapDbRowToUser(rows[0]);
};

const createUser = async ({ email, passwordHash, firstName = '', lastName = '', organization = '', jobTitle = '', phone = '' }) => {
  const normalizedEmail = email.toLowerCase();
  const { rows } = await pool.query(
    `INSERT INTO users (
      email,
      password_hash,
      first_name,
      last_name,
      organization,
      job_title,
      phone
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [normalizedEmail, passwordHash, firstName, lastName, organization, jobTitle, phone],
  );

  return sanitizeUser(mapDbRowToUser(rows[0]));
};

const updateUserProfile = async (id, updates = {}) => {
  const fields = ['first_name', 'last_name', 'organization', 'job_title', 'phone'];
  const values = [];
  const setStatements = [];

  fields.forEach((column) => {
    const camelKey = column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(updates, camelKey)) {
      setStatements.push(`${column} = $${setStatements.length + 1}`);
      values.push(updates[camelKey] ?? '');
    }
  });

  if (setStatements.length === 0) {
    const current = await findUserById(id);
    return sanitizeUser(current);
  }

  const query = `
    UPDATE users
    SET ${setStatements.join(', ')}, updated_at = NOW()
    WHERE id = $${setStatements.length + 1}
    RETURNING *
  `;

  values.push(id);

  const { rows } = await pool.query(query, values);

  if (rows.length === 0) {
    return null;
  }

  return sanitizeUser(mapDbRowToUser(rows[0]));
};

const updateUserPassword = async (id, passwordHash) => {
  const { rows } = await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [passwordHash, id],
  );

  if (rows.length === 0) {
    return null;
  }

  return sanitizeUser(mapDbRowToUser(rows[0]));
};

module.exports = {
  createUser,
  findUserByEmail,
  findUserById,
  updateUserProfile,
  updateUserPassword,
  sanitizeUser,
};

