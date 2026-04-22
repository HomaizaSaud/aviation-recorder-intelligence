const express = require('express');

const {
  createPresignedUpload,
  createPresignedDownload,
  deleteObject,
} = require('../services/storage');
const {
  validatePresignPayload,
  validateDownloadPayload,
  validateDeletePayload,
} = require('../utils/validate-upload');

const router = express.Router();

router.post('/presign', async (req, res, next) => {
  try {
    const options = validatePresignPayload(req.body);
    const result = await createPresignedUpload(options);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/download', async (req, res, next) => {
  try {
    const options = validateDownloadPayload(req.body);
    const result = await createPresignedDownload(options);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/delete', async (req, res, next) => {
  try {
    const options = validateDeletePayload(req.body);
    await deleteObject(options);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;