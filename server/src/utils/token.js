const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'development-secret';

const parseExpiresIn = (value = '1h') => {
  if (typeof value === 'number') {
    return value;
  }

  const match = /^([0-9]+)([smhd])$/.exec(value.trim());
  if (!match) {
    return 60 * 60 * 1000; // default 1 hour
  }

  const [, amountStr, unit] = match;
  const amount = parseInt(amountStr, 10);

  switch (unit) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
};

const EXPIRATION_MS = parseExpiresIn(process.env.JWT_EXPIRES_IN || '1h');

const base64UrlEncode = (value) => Buffer.from(value).toString('base64url');
const base64UrlDecode = (value) => Buffer.from(value, 'base64url').toString('utf8');

const createToken = (user) => {
  const payload = {
    sub: user.id,
    iat: Date.now(),
    exp: Date.now() + EXPIRATION_MS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');

  return `${encodedPayload}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    const error = new Error('Invalid token');
    error.name = 'JsonWebTokenError';
    throw error;
  }

  const [encodedPayload, signature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');

  const signatureBuffer = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expectedSignature, 'base64url');

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    const error = new Error('Invalid token signature');
    error.name = 'JsonWebTokenError';
    throw error;
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload));

  if (payload.exp && Date.now() > payload.exp) {
    const error = new Error('Token expired');
    error.name = 'TokenExpiredError';
    throw error;
  }

  return payload;
};

module.exports = {
  createToken,
  verifyToken,
};

