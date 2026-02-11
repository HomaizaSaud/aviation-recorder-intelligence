const SUPPORTED_ATTACHMENT_TYPES = new Set(['FDR', 'CVR']);

const sanitizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const validatePresignPayload = (payload = {}) => {
  const caseNumber = sanitizeString(payload.caseNumber);
  const attachmentType = sanitizeString(payload.attachmentType).toUpperCase();
  const fileName = sanitizeString(payload.fileName);
  const channel = sanitizeString(payload.channel);
  const contentType = sanitizeString(payload.contentType) || 'application/octet-stream';

  const errors = [];

  if (!caseNumber) {
    errors.push('caseNumber is required.');
  }

  if (!fileName) {
    errors.push('fileName is required.');
  }

  if (!attachmentType || !SUPPORTED_ATTACHMENT_TYPES.has(attachmentType)) {
    errors.push('attachmentType must be either "FDR" or "CVR".');
  }

  if (contentType.length > 120) {
    errors.push('contentType must be 120 characters or fewer.');
  }

  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.status = 400;
    throw error;
  }

  return {
    caseNumber,
    attachmentType,
    fileName,
    contentType,
    channel,
  };
};

const validateDownloadPayload = (payload = {}) => {
  const objectKey = sanitizeString(payload.objectKey);
  const bucket = sanitizeString(payload.bucket);
  const fileName = sanitizeString(payload.fileName);
  const contentType = sanitizeString(payload.contentType);

  const errors = [];

  if (!objectKey) {
    errors.push('objectKey is required.');
  }

  if (contentType && contentType.length > 120) {
    errors.push('contentType must be 120 characters or fewer.');
  }

  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.status = 400;
    throw error;
  }

  return {
    objectKey,
    bucket,
    fileName,
    contentType,
  };
};

const validateDeletePayload = (payload = {}) => {
  const objectKey = sanitizeString(payload.objectKey);
  const bucket = sanitizeString(payload.bucket);

  const errors = [];

  if (!objectKey) {
    errors.push('objectKey is required.');
  }

  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.status = 400;
    throw error;
  }

  return {
    objectKey,
    bucket,
  };
};

module.exports = {
  validatePresignPayload,
  validateDownloadPayload,
  validateDeletePayload,
};
