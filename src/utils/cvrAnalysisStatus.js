const CVR_STEPS = ['events', 'denoise', 'transcription', 'roles', 'emotion'];

const STEP_STATES = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

export const CVR_STATUSES = {
  NO_DATA: 'No Data',
  READY_FOR_ANALYSIS: 'Ready for Analysis',
  RUNNING: 'Running',
  ANALYZED: 'Analyzed',
  FAILED: 'Failed',
};

const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const attachmentHasData = (attachments = [], targetType) =>
  attachments.some((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return false;
    }

    if (normalize(attachment.type) !== normalize(targetType)) {
      return false;
    }

    if (normalize(attachment.status) === 'pending') {
      return false;
    }

    if (attachment.storage && (attachment.storage.objectKey || attachment.storage.key)) {
      return true;
    }

    if (typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > 0) {
      return true;
    }

    return Boolean(attachment.name);
  });

const normalizeStepState = (status) => {
  const value = normalize(status);

  if (!value || ['pending', 'idle', 'not started', 'not_started'].includes(value)) {
    return STEP_STATES.NOT_STARTED;
  }

  if (['running', 'in progress', 'in_progress', 'started', 'queued', 'processing'].includes(value)) {
    return STEP_STATES.RUNNING;
  }

  if (['done', 'complete', 'completed', 'success', 'succeeded', 'finished'].includes(value)) {
    return STEP_STATES.DONE;
  }

  if (['failed', 'failure', 'error', 'errored', 'timeout'].includes(value)) {
    return STEP_STATES.FAILED;
  }

  return STEP_STATES.NOT_STARTED;
};

export const computeCvrStatus = (caseRecord = {}) => {
  const hasCvrUpload = attachmentHasData(caseRecord.attachments || [], 'CVR');
  const cvr = caseRecord?.analyses?.cvr || {};
  const pipeline = cvr?.pipeline || {};
  const steps = pipeline?.steps || {};
  const explicitStepStatuses = pipeline?.stepStatuses || cvr?.stepStatuses || {};

  const stepStatuses = CVR_STEPS.reduce((acc, key) => {
    acc[key] = normalizeStepState(explicitStepStatuses[key] || steps?.[key]?.status);
    return acc;
  }, {});

  if (!hasCvrUpload) {
    return { status: CVR_STATUSES.NO_DATA, stepStatuses };
  }

  return { status: computeOverallCvrStatus(stepStatuses), stepStatuses };
};

export const computeOverallCvrStatus = (stepStatuses = {}) => {
  const statuses = Object.values(stepStatuses);
  const started = statuses.filter((status) => status !== STEP_STATES.NOT_STARTED).length;

  if (started === 0) {
    return CVR_STATUSES.READY_FOR_ANALYSIS;
  }

  const completed = statuses.filter((status) => status === STEP_STATES.DONE).length;
  const failed = statuses.filter((status) => status === STEP_STATES.FAILED).length;

  if (completed === CVR_STEPS.length) {
    return CVR_STATUSES.ANALYZED;
  }

  if (completed >= 1) {
    return CVR_STATUSES.RUNNING;
  }

  if (failed === CVR_STEPS.length) {
    return CVR_STATUSES.FAILED;
  }

  return CVR_STATUSES.RUNNING;
};
