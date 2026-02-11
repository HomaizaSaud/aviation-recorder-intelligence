const { verifyToken } = require('../utils/token');
const { findUserById, sanitizeUser } = require('../services/users');

const extractToken = (authorizationHeader = '') => {
  if (!authorizationHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return authorizationHeader.slice(7).trim();
};

const requireAuth = async (req, res, next) => {
  const token = extractToken(req.headers.authorization || '');

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyToken(token);
    const user = await findUserById(payload.sub);

    if (!user) {
      res.status(401).json({ error: 'Invalid authentication token' });
      return;
    }

    req.user = sanitizeUser(user);
    req.authenticatedUser = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    res.status(401).json({ error: 'Invalid authentication token' });
  }
};

module.exports = requireAuth;
