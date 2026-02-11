export const ANALYSIS_STATUS_STATES = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

export const normalizeAnalysisStatus = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (['not started', 'not_started', 'not-started', 'notstarted'].includes(normalized)) {
    return ANALYSIS_STATUS_STATES.NOT_STARTED;
  }

  if (['completed', 'complete', 'analyzed', 'finished', 'success', 'succeeded'].some(
    (value) => normalized.includes(value),
  )) {
    return ANALYSIS_STATUS_STATES.COMPLETED;
  }

  if (['running', 'started', 'in progress', 'analysis started'].some((value) => normalized.includes(value))) {
    return ANALYSIS_STATUS_STATES.RUNNING;
  }

  if (['failed', 'error'].some((value) => normalized.includes(value))) {
    return ANALYSIS_STATUS_STATES.FAILED;
  }

  return ANALYSIS_STATUS_STATES.NOT_STARTED;
};

export const getAnalysisStatusStyles = (status) => {
  const state = normalizeAnalysisStatus(status);
  switch (state) {
    case ANALYSIS_STATUS_STATES.COMPLETED:
      return 'bg-emerald-100 text-emerald-700';
    case ANALYSIS_STATUS_STATES.RUNNING:
      return 'bg-amber-100 text-amber-700';
    case ANALYSIS_STATUS_STATES.FAILED:
      return 'bg-rose-100 text-rose-700';
    default:
      return 'bg-gray-100 text-gray-500 border border-gray-200';
  }
};
