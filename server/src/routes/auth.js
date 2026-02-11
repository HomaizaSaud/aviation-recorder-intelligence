const express = require('express');
const { createUser, findUserByEmail, sanitizeUser } = require('../services/users');
const { createToken } = require('../utils/token');
const { hashPassword, verifyPassword } = require('../utils/password');

const router = express.Router();

const validateEmail = (email) => typeof email === 'string' && email.includes('@');
const validatePassword = (password) => typeof password === 'string' && password.length >= 8;

router.post('/signup', async (req, res, next) => {
  try {
    const {
      email,
      password,
      firstName = '',
      lastName = '',
      organization = '',
      jobTitle = '',
      phone = '',
    } = req.body || {};

    if (!validateEmail(email) || !validatePassword(password)) {
      res.status(400).json({ error: 'Email and password are required. Password must be at least 8 characters.' });
      return;
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const passwordHash = hashPassword(password);
    const user = await createUser({
      email,
      passwordHash,
      firstName,
      lastName,
      organization,
      jobTitle,
      phone,
    });

    const token = createToken(user);

    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!validateEmail(email) || typeof password !== 'string') {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const user = await findUserByEmail(email);

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const passwordMatches = verifyPassword(password, user.passwordHash);

    if (!passwordMatches) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = createToken(user);

    res.json({ token, user: sanitizeUser(user) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

