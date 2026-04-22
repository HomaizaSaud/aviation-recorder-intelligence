import {
  ANALYSIS_STATUS_STATES,
  getAnalysisStatusStyles,
  normalizeAnalysisStatus,
} from './analysisStatus';
import { getCaseDataAvailability } from './analysisAvailability';
import {
  FDR_ANALYSIS_STATUSES,
  getFdrAnalysisStatusLabel,
  getFdrAnalysisStatusStyles,
  normalizeFdrAnalysisStatus,
} from './fdrStatus';
import { CASE_STATUS_LABELS, CASE_STATUS_ORDER, CASE_STATUS_VALUES } from './statusLabels';
import { computeCvrStatus as computeCaseCvrStatus, CVR_STATUSES } from './cvrAnalysisStatus';

export { CASE_STATUS_VALUES };

export const CASE_STATUS_OPTIONS = CASE_STATUS_ORDER.map((status) => CASE_STATUS_LABELS[status]);
export const DATA_UPLOAD_OPTIONS = [
  'All Data Uploaded',
  'CVR Uploaded',
  'FDR Uploaded',
  'No Data Uploaded',
];

export const WORKFLOW_STATUS_OPTIONS = [
  'Not Started',
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.READY_FOR_ANALYSIS],
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.ANALYSIS_RUNNING],
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.ANALYSIS_FAILED],
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.FDR_ANALYZED],
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.CVR_ANALYZED],
  CASE_STATUS_LABELS[CASE_STATUS_VALUES.CORRELATION_DONE],
];

export const CASE_STATUS_STYLES = {
  [CASE_STATUS_VALUES.NO_DATA]: 'bg-gray-100 text-gray-500 border border-gray-200',
  [CASE_STATUS_VALUES.FDR_UPLOADED]: 'bg-sky-100 text-sky-700',
  [CASE_STATUS_VALUES.CVR_UPLOADED]: 'bg-sky-100 text-sky-700',
  [CASE_STATUS_VALUES.READY_FOR_ANALYSIS]: 'bg-indigo-100 text-indigo-700',
  [CASE_STATUS_VALUES.ANALYSIS_RUNNING]: 'bg-amber-100 text-amber-700',
  [CASE_STATUS_VALUES.ANALYSIS_FAILED]: 'bg-rose-100 text-rose-700',
  [CASE_STATUS_VALUES.FDR_ANALYZED]: 'bg-emerald-100 text-emerald-700',
  [CASE_STATUS_VALUES.CVR_ANALYZED]: 'bg-emerald-100 text-emerald-700',
  [CASE_STATUS_VALUES.CORRELATION_DONE]: 'bg-emerald-100 text-emerald-700',
};

const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const statusIndicates = (status, indicators = []) =>
  Boolean(status) && indicators.includes(normalize(status));

const RUNNING_STATUSES = [
  'analysis in progress',
  'analysis started',
  'in progress',
  'running',
  'started',
  'analysis paused',
  'paused',
  'queued',
  'pending',
];

const SUCCESS_STATUSES = [
  'completed',
  'complete',
  'success',
  'succeeded',
  'analyzed',
  'finished',
  'correlate analyzed',
  'correlation analyzed',
];

const FAILED_STATUSES = ['failed', 'failure', 'error', 'errored', 'timeout'];

export const normalizeCaseStatus = (status) => {
  const raw = typeof status === 'string' ? status.trim() : '';
  if (!raw) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.NO_DATA];
  }

  const lower = raw.toLowerCase();
  const matchByValue = Object.values(CASE_STATUS_VALUES).find(
    (value) => value.toLowerCase() === lower,
  );
  if (matchByValue) {
    return CASE_STATUS_LABELS[matchByValue];
  }

  const matchByLabel = Object.values(CASE_STATUS_LABELS).find(
    (label) => label.toLowerCase() === lower,
  );
  if (matchByLabel) {
    return matchByLabel;
  }

  return raw;
};

export const resolveCaseStatusLabel = (caseRecord = {}) => {
  if (!caseRecord || typeof caseRecord !== 'object') {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.NO_DATA];
  }

  if (caseRecord.computedStatusLabel) {
    return caseRecord.computedStatusLabel;
  }

  if (caseRecord.computedStatus && CASE_STATUS_LABELS[caseRecord.computedStatus]) {
    return CASE_STATUS_LABELS[caseRecord.computedStatus];
  }

  if (caseRecord.status) {
    return normalizeCaseStatus(caseRecord.status);
  }

  return CASE_STATUS_LABELS[CASE_STATUS_VALUES.NO_DATA];
};

export const normalizeCaseRecord = (caseRecord) => {
  if (!caseRecord || typeof caseRecord !== 'object') {
    return caseRecord;
  }

  return {
    ...caseRecord,
    status: resolveCaseStatusLabel(caseRecord),
  };
};

const attachmentHasData = (attachments = [], targetType) =>
  attachments.some((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return false;
    }

    const type = normalize(attachment.type);
    if (type !== normalize(targetType)) {
      return false;
    }

    const status = normalize(attachment.status);
    if (status === 'pending') {
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

export const deriveDataStatus = (attachments = []) => {
  const hasFdrData = attachmentHasData(attachments, 'FDR');
  const hasCvrData = attachmentHasData(attachments, 'CVR');

  if (hasFdrData && hasCvrData) {
    return 'All Data Uploaded';
  }

  if (hasFdrData) {
    return 'FDR Uploaded';
  }

  if (hasCvrData) {
    return 'CVR Uploaded';
  }

  return 'No Data Uploaded';
};

const resolveFdrStatus = ({ fdrAnalysisStatus, fdrLatestRunStatus, analyses }) =>
  normalize(fdrLatestRunStatus || fdrAnalysisStatus || analyses?.fdr?.status);

const resolveCvrStatus = ({ analyses }) => normalize(analyses?.cvr?.status);

const resolveCorrelateStatus = ({ analyses }) => normalize(analyses?.correlate?.status);

export const deriveWorkflowStatusLabel = (caseData = {}) => {
  if (!caseData || typeof caseData !== 'object') {
    return 'Not Started';
  }

  const { hasFdr, hasCvr } = getCaseDataAvailability(caseData);
  const fdrStatus = resolveFdrStatus(caseData);
  const cvrStatus = resolveCvrStatus(caseData);
  const correlateStatus = resolveCorrelateStatus(caseData);
  const statuses = [fdrStatus, cvrStatus, correlateStatus].filter(Boolean);

  const hasRunning = statuses.some((status) => statusIndicates(status, RUNNING_STATUSES));
  const hasSuccess = statuses.some((status) => statusIndicates(status, SUCCESS_STATUSES));
  const hasFailed = statuses.some((status) => statusIndicates(status, FAILED_STATUSES));

  if (hasRunning) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.ANALYSIS_RUNNING];
  }

  if (hasFailed && !hasSuccess) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.ANALYSIS_FAILED];
  }

  if (statusIndicates(correlateStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.CORRELATION_DONE];
  }

  if (statusIndicates(cvrStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.CVR_ANALYZED];
  }

  if (statusIndicates(fdrStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.FDR_ANALYZED];
  }

  if (hasFdr && hasCvr) {
    return CASE_STATUS_LABELS[CASE_STATUS_VALUES.READY_FOR_ANALYSIS];
  }

  return 'Not Started';
};

export const getComputedCaseStatus = ({
  attachments = [],
  analyses = {},
  fdrAnalysisStatus,
  fdrLatestRunStatus,
} = {}) => {
  const hasFdrData = attachmentHasData(attachments, 'FDR');
  const hasCvrData = attachmentHasData(attachments, 'CVR');
  const fdrStatus = resolveFdrStatus({ fdrAnalysisStatus, fdrLatestRunStatus, analyses });
  const cvrStatus = resolveCvrStatus({ analyses });
  const correlateStatus = resolveCorrelateStatus({ analyses });
  const statuses = [fdrStatus, cvrStatus, correlateStatus].filter(Boolean);

  const hasRunning = statuses.some((status) => statusIndicates(status, RUNNING_STATUSES));
  const hasSuccess = statuses.some((status) => statusIndicates(status, SUCCESS_STATUSES));
  const hasFailed = statuses.some((status) => statusIndicates(status, FAILED_STATUSES));

  if (!hasFdrData && !hasCvrData) {
    return CASE_STATUS_VALUES.NO_DATA;
  }

  if (hasRunning) {
    return CASE_STATUS_VALUES.ANALYSIS_RUNNING;
  }

  if (hasFailed && !hasSuccess) {
    return CASE_STATUS_VALUES.ANALYSIS_FAILED;
  }

  if (statusIndicates(correlateStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_VALUES.CORRELATION_DONE;
  }

  if (statusIndicates(cvrStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_VALUES.CVR_ANALYZED;
  }

  if (statusIndicates(fdrStatus, SUCCESS_STATUSES)) {
    return CASE_STATUS_VALUES.FDR_ANALYZED;
  }

  if (hasFdrData && hasCvrData) {
    return CASE_STATUS_VALUES.READY_FOR_ANALYSIS;
  }

  if (hasFdrData) {
    return CASE_STATUS_VALUES.FDR_UPLOADED;
  }

  if (hasCvrData) {
    return CASE_STATUS_VALUES.CVR_UPLOADED;
  }

  return CASE_STATUS_VALUES.NO_DATA;
};

export const getCaseStatusLabel = (status) =>
  CASE_STATUS_LABELS[status] || CASE_STATUS_LABELS[CASE_STATUS_VALUES.NO_DATA];

export const deriveCaseStatus = (caseData = {}) =>
  getCaseStatusLabel(getComputedCaseStatus(caseData));


export const deriveCaseModuleDisplayStatuses = (caseRecord = {}) => {
  const { hasFdr } = getCaseDataAvailability(caseRecord);
  const fdrLatestStatus = normalizeFdrAnalysisStatus(
    caseRecord.fdrLatestRunStatus || caseRecord.fdrAnalysisStatus || caseRecord?.analyses?.fdr?.status,
  );
  const fdrHasResults = Boolean(
    caseRecord.fdrHasResults ||
      caseRecord.fdrAnalysis ||
      caseRecord.fdrLatestRunId ||
      caseRecord.fdrLastRunId,
  );
  const fdrCompleted = fdrHasResults || fdrLatestStatus === FDR_ANALYSIS_STATUSES.COMPLETED;

  let fdrLabel = 'No Data';
  let fdrTooltip = 'No FDR data uploaded';
  let fdrClassName = CASE_STATUS_STYLES[CASE_STATUS_VALUES.NO_DATA];

  if (hasFdr) {
    if (fdrLatestStatus === FDR_ANALYSIS_STATUSES.RUNNING) {
      fdrLabel = 'Running';
      fdrTooltip = getFdrAnalysisStatusLabel(fdrLatestStatus);
      fdrClassName = getFdrAnalysisStatusStyles(fdrLatestStatus);
    } else if (fdrLatestStatus === FDR_ANALYSIS_STATUSES.FAILED) {
      fdrLabel = 'Failed';
      fdrTooltip = getFdrAnalysisStatusLabel(fdrLatestStatus);
      fdrClassName = getFdrAnalysisStatusStyles(fdrLatestStatus);
    } else if (fdrCompleted) {
      fdrLabel = 'Analyzed';
      fdrTooltip = getFdrAnalysisStatusLabel(FDR_ANALYSIS_STATUSES.COMPLETED);
      fdrClassName = getFdrAnalysisStatusStyles(FDR_ANALYSIS_STATUSES.COMPLETED);
    } else {
      fdrLabel = 'Uploaded';
      fdrTooltip = 'FDR Uploaded';
      fdrClassName = CASE_STATUS_STYLES[CASE_STATUS_VALUES.FDR_UPLOADED];
    }
  }

  const cvrComputed = computeCaseCvrStatus(caseRecord);
  const cvrLabel = cvrComputed.status;
  const cvrState = normalizeAnalysisStatus(cvrLabel);
  const cvrTooltip = `CVR ${cvrLabel}`;
  let cvrClassName = CASE_STATUS_STYLES[CASE_STATUS_VALUES.NO_DATA];

  if (cvrLabel === CVR_STATUSES.RUNNING || cvrLabel === CVR_STATUSES.ANALYZED || cvrLabel === CVR_STATUSES.FAILED) {
    cvrClassName = getAnalysisStatusStyles(cvrLabel);
  } else if (cvrLabel === CVR_STATUSES.READY_FOR_ANALYSIS) {
    cvrClassName = CASE_STATUS_STYLES[CASE_STATUS_VALUES.CVR_UPLOADED];
  }

  const correlateRawStatus = 'Not Started';
  const correlateState = normalizeAnalysisStatus(correlateRawStatus);
  const correlationLabel = 'Not Started';
  const correlationTooltip = 'Correlation module will be available in a future release.';
  const correlationClassName = CASE_STATUS_STYLES[CASE_STATUS_VALUES.NO_DATA];

  return {
    fdrStatus: fdrLatestStatus,
    cvrState,
    correlateState,
    fdrDisplayStatus: {
      label: fdrLabel,
      tooltip: fdrTooltip,
      className: fdrClassName,
    },
    cvrDisplayStatus: {
      label: cvrLabel,
      tooltip: cvrTooltip,
      className: cvrClassName,
    },
    correlationDisplayStatus: {
      label: correlationLabel,
      tooltip: correlationTooltip,
      className: correlationClassName,
    },
  };
};
