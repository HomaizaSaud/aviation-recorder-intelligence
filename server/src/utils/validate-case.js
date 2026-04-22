const validateCasePayload = (payload = {}) => {
  const missing = [];

  if (!payload.caseNumber) {
    missing.push('caseNumber');
  }

  if (!payload.caseName) {
    missing.push('caseName');
  }

  if (!payload.investigator || !payload.investigator.name) {
    missing.push('investigator.name');
  }

  if (!payload.owner) {
    missing.push('owner');
  }

  if (!payload.status) {
    missing.push('status');
  }

  if (!payload.module) {
    missing.push('module');
  }

  if (missing.length > 0) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  return payload;
};

module.exports = {
  validateCasePayload,
};
