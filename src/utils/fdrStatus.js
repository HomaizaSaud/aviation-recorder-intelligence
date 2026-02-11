import { FDR_ANALYSIS_STATUS_LABELS } from './statusLabels';

export const FDR_ANALYSIS_STATUSES = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

const STATUS_STYLES = {
  [FDR_ANALYSIS_STATUSES.NOT_STARTED]: 'bg-gray-100 text-gray-500 border border-gray-200',
  [FDR_ANALYSIS_STATUSES.RUNNING]: 'bg-amber-100 text-amber-700',
  [FDR_ANALYSIS_STATUSES.COMPLETED]: 'bg-emerald-100 text-emerald-700',
  [FDR_ANALYSIS_STATUSES.FAILED]: 'bg-rose-100 text-rose-700',
};

export const normalizeFdrAnalysisStatus = (status) => {
  if (typeof status !== 'string') {
    return FDR_ANALYSIS_STATUSES.NOT_STARTED;
  }

  const normalized = status.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(FDR_ANALYSIS_STATUSES, normalized)) {
    return FDR_ANALYSIS_STATUSES[normalized];
  }

  return FDR_ANALYSIS_STATUSES.NOT_STARTED;
};

export const getFdrAnalysisStatusLabel = (status) =>
  FDR_ANALYSIS_STATUS_LABELS[normalizeFdrAnalysisStatus(status)] ||
  FDR_ANALYSIS_STATUS_LABELS[FDR_ANALYSIS_STATUSES.NOT_STARTED];

export const getFdrAnalysisStatusStyles = (status) =>
  STATUS_STYLES[normalizeFdrAnalysisStatus(status)] || STATUS_STYLES[FDR_ANALYSIS_STATUSES.NOT_STARTED];
