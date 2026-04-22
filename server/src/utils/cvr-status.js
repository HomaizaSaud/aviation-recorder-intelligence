const CVR_PIPELINE_STEP_KEYS = ['events', 'denoise', 'transcription', 'roles', 'emotion'];

const CVR_STEP_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

const CVR_STATUS = {
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

const normalizeStepStatus = (rawStatus) => {
  const value = normalize(rawStatus);

  if (!value || ['pending', 'idle', 'not_started', 'not started'].includes(value)) {
    return CVR_STEP_STATUS.NOT_STARTED;
  }

  if (
    ['running', 'in_progress', 'in progress', 'started', 'processing', 'queued'].includes(value)
  ) {
    return CVR_STEP_STATUS.RUNNING;
  }

  if (
    ['done', 'complete', 'completed', 'success', 'succeeded', 'finished'].includes(value)
  ) {
    return CVR_STEP_STATUS.DONE;
  }

  if (['failed', 'failure', 'error', 'errored', 'timeout'].includes(value)) {
    return CVR_STEP_STATUS.FAILED;
  }

  return CVR_STEP_STATUS.NOT_STARTED;
};

const computeCvrStepStatuses = (pipeline = {}) => {
  const explicitStepStatuses =
    pipeline && typeof pipeline === 'object' && pipeline.stepStatuses && typeof pipeline.stepStatuses === 'object'
      ? pipeline.stepStatuses
      : null;
  const steps = pipeline && typeof pipeline === 'object' && pipeline.steps && typeof pipeline.steps === 'object'
    ? pipeline.steps
    : {};

  return CVR_PIPELINE_STEP_KEYS.reduce((acc, stepKey) => {
    const sourceStatus = explicitStepStatuses?.[stepKey] || steps?.[stepKey]?.status;
    acc[stepKey] = normalizeStepStatus(sourceStatus);
    return acc;
  }, {});
};

const computeCvrStatus = ({ hasCvrUpload, pipeline } = {}) => {
  if (!hasCvrUpload) {
    return { status: CVR_STATUS.NO_DATA, stepStatuses: computeCvrStepStatuses(pipeline) };
  }

  const stepStatuses = computeCvrStepStatuses(pipeline);
  return { status: computeOverallCvrStatus(stepStatuses), stepStatuses };
};

const computeOverallCvrStatus = (stepStatuses = {}) => {
  const statuses = Object.values(stepStatuses);
  const started = statuses.filter((value) => value !== CVR_STEP_STATUS.NOT_STARTED).length;

  if (started === 0) {
    return CVR_STATUS.READY_FOR_ANALYSIS;
  }

  const completed = statuses.filter((value) => value === CVR_STEP_STATUS.DONE).length;
  const failed = statuses.filter((value) => value === CVR_STEP_STATUS.FAILED).length;

  if (completed === CVR_PIPELINE_STEP_KEYS.length) {
    return CVR_STATUS.ANALYZED;
  }

  if (completed >= 1) {
    return CVR_STATUS.RUNNING;
  }

  if (failed === CVR_PIPELINE_STEP_KEYS.length) {
    return CVR_STATUS.FAILED;
  }

  return CVR_STATUS.RUNNING;
};

const computeCvrStatusFromCase = (caseData = {}) => {
  const hasCvrUpload = attachmentHasData(caseData.attachments || [], 'CVR');
  const cvrAnalysis = caseData?.analyses?.cvr || {};
  const { status, stepStatuses } = computeCvrStatus({
    hasCvrUpload,
    pipeline: cvrAnalysis.pipeline,
  });

  return {
    status,
    stepStatuses,
    hasCvrUpload,
  };
};

module.exports = {
  CVR_PIPELINE_STEP_KEYS,
  CVR_STEP_STATUS,
  CVR_STATUS,
  normalizeStepStatus,
  computeCvrStepStatuses,
  computeOverallCvrStatus,
  computeCvrStatus,
  computeCvrStatusFromCase,
};
