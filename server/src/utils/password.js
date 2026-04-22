const crypto = require('crypto');

const ITERATIONS = parseInt(process.env.PASSWORD_ITERATIONS || '100000', 10);
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return `${salt}:${derivedKey}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }

  const [salt, key] = storedHash.split(':');
  const derivedKey = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');

  const keyBuffer = Buffer.from(key, 'hex');
  const derivedBuffer = Buffer.from(derivedKey, 'hex');

  if (keyBuffer.length !== derivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
};

module.exports = {
  hashPassword,
  verifyPassword,
};

