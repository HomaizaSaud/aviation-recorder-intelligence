const fs = require('fs/promises');
const path = require('path');

const pool = require('./pool');

let initialized = false;

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');

const splitSqlStatements = (sql) => {
  const statements = [];
  let current = '';
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  const advance = (amount = 1) => {
    current += sql.slice(index, index + amount);
    index += amount;
  };

  while (index < sql.length) {
    const char = sql[index];
    const nextChar = sql[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }

      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !dollarTag) {
      if (char === '-' && nextChar === '-') {
        inLineComment = true;
        index += 2;
        continue;
      }

      if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        index += 2;
        continue;
      }
    }

    if (!inDoubleQuote && !dollarTag && char === "'" && sql[index - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      advance();
      continue;
    }

    if (!inSingleQuote && !dollarTag && char === '"' && sql[index - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      advance();
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (!dollarTag && char === '$') {
        const match = sql.slice(index).match(/^\$[a-zA-Z0-9_]*\$/);
        if (match) {
          dollarTag = match[0];
          advance(dollarTag.length);
          continue;
        }
      } else if (dollarTag && sql.startsWith(dollarTag, index)) {
        advance(dollarTag.length);
        dollarTag = null;
        continue;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && !dollarTag && char === ';') {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }

      current = '';
      index += 1;
      continue;
    }

    advance();
  }

  const finalStatement = current.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }

  return statements;
};

const formatStatementForError = (statement) => {
  const singleLine = statement.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 120) {
    return singleLine;
  }

  return `${singleLine.slice(0, 117)}...`;
};

const ensureRequiredTables = async (client, statements) => {
  const requiredTables = ['cases', 'users'];

  const createStatements = new Map();
  statements.forEach((statement) => {
    const match = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
    if (match) {
      const tableName = match[1];
      if (!createStatements.has(tableName)) {
        createStatements.set(tableName, statement);
      }
    }
  });

  for (const table of requiredTables) {
    const { rows } = await client.query('SELECT to_regclass($1) AS oid', [`public.${table}`]);
    const tableExists = Boolean(rows?.[0]?.oid);

    if (tableExists) {
      continue;
    }

    const createStatement = createStatements.get(table);
    if (!createStatement) {
      throw new Error(`Unable to locate CREATE TABLE statement for required table "${table}".`);
    }

    try {
      await client.query(createStatement);
    } catch (error) {
      const snippet = formatStatementForError(createStatement);
      throw new Error(`Failed to create required table "${table}": ${error.message} (statement: ${snippet})`, {
        cause: error,
      });
    }
  }
};

const initializeDatabase = async () => {
  if (initialized) {
    return;
  }

  const client = await pool.connect();

  try {
    const schema = await fs.readFile(schemaPath, 'utf8');
    const statements = splitSqlStatements(schema);

    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (error) {
        const snippet = formatStatementForError(statement);
        throw new Error(`Failed to execute schema statement: ${error.message} (statement: ${snippet})`, {
          cause: error,
        });
      }
    }

    await ensureRequiredTables(client, statements);

    initialized = true;
  } finally {
    client.release();
  }
};

module.exports = initializeDatabase;
module.exports.splitSqlStatements = splitSqlStatements;