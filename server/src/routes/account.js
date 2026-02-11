const express = require('express');
const { updateUserProfile, updateUserPassword, findUserById } = require('../services/users');
const { hashPassword, verifyPassword } = require('../utils/password');

const router = express.Router();

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.patch('/me', async (req, res, next) => {
  try {
    const allowedFields = ['firstName', 'lastName', 'organization', 'jobTitle', 'phone'];
    const updates = {};

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        const value = req.body[field];
        updates[field] = typeof value === 'string' ? value : '';
      }
    });

    const updated = await updateUserProfile(req.user.id, updates);

    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
      res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' });
      return;
    }

    const user = await findUserById(req.user.id);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const matches = verifyPassword(currentPassword, user.passwordHash);

    if (!matches) {
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }

    const passwordHash = hashPassword(newPassword);
    await updateUserPassword(user.id, passwordHash);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;

