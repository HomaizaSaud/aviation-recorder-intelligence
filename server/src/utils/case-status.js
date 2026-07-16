const { computeCvrStatusFromCase } = require('./cvr-status');
const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const CASE_COMPUTED_STATUSES = {
  NO_DATA: 'NO_DATA',
  FDR_UPLOADED: 'FDR_UPLOADED',
  CVR_UPLOADED: 'CVR_UPLOADED',
  READY_FOR_ANALYSIS: 'READY_FOR_ANALYSIS',
  ANALYSIS_RUNNING: 'ANALYSIS_RUNNING',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  FDR_ANALYZED: 'FDR_ANALYZED',
  CVR_ANALYZED: 'CVR_ANALYZED',
  CORRELATION_DONE: 'CORRELATION_DONE',
};

const CASE_STATUS_LABELS = {
  [CASE_COMPUTED_STATUSES.NO_DATA]: 'No Data Uploaded',
  [CASE_COMPUTED_STATUSES.FDR_UPLOADED]: 'FDR Uploaded',
  [CASE_COMPUTED_STATUSES.CVR_UPLOADED]: 'CVR Uploaded',
  [CASE_COMPUTED_STATUSES.READY_FOR_ANALYSIS]: 'Ready for Analysis',
  [CASE_COMPUTED_STATUSES.ANALYSIS_RUNNING]: 'Analysis Running',
  [CASE_COMPUTED_STATUSES.ANALYSIS_FAILED]: 'Analysis Failed',
  [CASE_COMPUTED_STATUSES.FDR_ANALYZED]: 'FDR Anomaly Analyzed',
  [CASE_COMPUTED_STATUSES.CVR_ANALYZED]: 'CVR Analyzed',
  [CASE_COMPUTED_STATUSES.CORRELATION_DONE]: 'Correlation Complete',
};

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

const attachmentHasData = (attachments = [], targetType) =>
  attachments.some((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return false;
    }

    if (attachment.missingInStorage) {
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

const attachmentEntryHasData = (attachment) => {
  if (!attachment || typeof attachment !== 'object') {
    return false;
  }

  if (attachment.missingInStorage) {
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
};

const statusIndicates = (status, indicators = []) =>
  Boolean(status) && indicators.includes(normalize(status));

const deriveDataStatus = (attachments = []) => {
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

const resolveCvrStatus = (caseData = {}) => normalize(computeCvrStatusFromCase(caseData).status);

const resolveCorrelateStatus = ({ analyses }) => normalize(analyses?.correlate?.status);

const computeCaseStatus = ({ attachments = [], analyses = {}, fdrAnalysisStatus, fdrLatestRunStatus } = {}) => {
  const hasFdrData = attachmentHasData(attachments, 'FDR');
  const hasCvrData = attachmentHasData(attachments, 'CVR');
  const fdrStatus = resolveFdrStatus({ fdrAnalysisStatus, fdrLatestRunStatus, analyses });
  const cvrStatus = resolveCvrStatus({ attachments, analyses });
  const correlateStatus = resolveCorrelateStatus({ analyses });
  const statuses = [fdrStatus, cvrStatus, correlateStatus].filter(Boolean);

  const hasRunning = statuses.some((status) => statusIndicates(status, RUNNING_STATUSES));
  const hasSuccess = statuses.some((status) => statusIndicates(status, SUCCESS_STATUSES));
  const hasFailed = statuses.some((status) => statusIndicates(status, FAILED_STATUSES));

  if (!hasFdrData && !hasCvrData) {
    return CASE_COMPUTED_STATUSES.NO_DATA;
  }

  if (hasRunning) {
    return CASE_COMPUTED_STATUSES.ANALYSIS_RUNNING;
  }

  if (hasFailed && !hasSuccess) {
    return CASE_COMPUTED_STATUSES.ANALYSIS_FAILED;
  }

  if (statusIndicates(correlateStatus, SUCCESS_STATUSES)) {
    return CASE_COMPUTED_STATUSES.CORRELATION_DONE;
  }

  if (statusIndicates(cvrStatus, SUCCESS_STATUSES)) {
    return CASE_COMPUTED_STATUSES.CVR_ANALYZED;
  }

  if (statusIndicates(fdrStatus, SUCCESS_STATUSES)) {
    return CASE_COMPUTED_STATUSES.FDR_ANALYZED;
  }

  if (hasFdrData && hasCvrData) {
    return CASE_COMPUTED_STATUSES.READY_FOR_ANALYSIS;
  }

  if (hasFdrData) {
    return CASE_COMPUTED_STATUSES.FDR_UPLOADED;
  }

  if (hasCvrData) {
    return CASE_COMPUTED_STATUSES.CVR_UPLOADED;
  }

  return CASE_COMPUTED_STATUSES.NO_DATA;
};

const getComputedCaseStatusLabel = (status) =>
  CASE_STATUS_LABELS[status] || CASE_STATUS_LABELS[CASE_COMPUTED_STATUSES.NO_DATA];

const deriveCaseStatus = (caseData = {}) => {
  const computedStatus = computeCaseStatus(caseData);
  return getComputedCaseStatusLabel(computedStatus);
};

const attachComputedStatus = (caseData) => {
  if (!caseData || typeof caseData !== 'object') {
    return caseData;
  }

  const computedStatus = computeCaseStatus(caseData);
  return {
    ...caseData,
    computedStatus,
    computedStatusLabel: getComputedCaseStatusLabel(computedStatus),
  };
};

const buildUploadsSummary = (attachments = []) => {
  const pickLatestAttachment = (type) => {
    const candidates = attachments.filter(
      (attachment) =>
        attachment &&
        typeof attachment === 'object' &&
        normalize(attachment.type) === normalize(type) &&
        attachmentEntryHasData(attachment),
    );

    if (candidates.length === 0) {
      return null;
    }

    const toTimestamp = (value) => {
      if (!value) {
        return null;
      }
      const parsed = new Date(value);
      const time = parsed.getTime();
      return Number.isNaN(time) ? null : time;
    };

    const sorted = [...candidates].sort((a, b) => {
      const aTime = toTimestamp(a.uploadedAt || a.createdAt || a.updatedAt);
      const bTime = toTimestamp(b.uploadedAt || b.createdAt || b.updatedAt);
      if (aTime === null && bTime === null) {
        return 0;
      }
      if (aTime === null) {
        return 1;
      }
      if (bTime === null) {
        return -1;
      }
      return bTime - aTime;
    });

    return sorted[0] || null;
  };

  const latestFdr = pickLatestAttachment('FDR');
  const latestCvr = pickLatestAttachment('CVR');

  return {
    hasFdr: attachmentHasData(attachments, 'FDR'),
    hasCvr: attachmentHasData(attachments, 'CVR'),
    fdrFilename: latestFdr?.name || null,
    cvrFilename: latestCvr?.name || null,
  };
};

const buildMetadataEntries = (metadata) => {
  if (!metadata) {
    return [];
  }

  if (Array.isArray(metadata)) {
    return metadata;
  }

  if (typeof metadata === 'object') {
    return Object.entries(metadata).map(([label, value]) => ({
      label,
      value,
    }));
  }

  return [{ label: 'Details', value: metadata }];
};

const resolveActorLabel = (actor) => {
  if (!actor) {
    return null;
  }

  if (typeof actor === 'string') {
    return actor;
  }

  if (typeof actor === 'object') {
    return actor.name || actor.email || actor.id || null;
  }

  return null;
};

const resolveModuleKeyFromEntry = (entry) => {
  const kindValue = normalize(entry?.kind || '');
  const actionValue = normalize(entry?.action || '');

  if (kindValue.includes('fdr') || actionValue.includes('fdr')) {
    return 'fdr';
  }
  if (kindValue.includes('cvr') || actionValue.includes('cvr')) {
    return 'cvr';
  }
  if (
    kindValue.includes('correlate') ||
    kindValue.includes('correlation') ||
    actionValue.includes('correlate') ||
    actionValue.includes('correlation')
  ) {
    return 'correlation';
  }

  return null;
};

const resolveStatusFromEntry = (entry) => {
  const metadataEntries = buildMetadataEntries(entry?.metadata);
  const statusEntry = metadataEntries.find(
    (metadataEntry) => String(metadataEntry.label || '').toLowerCase() === 'status',
  );
  if (statusEntry?.value) {
    return String(statusEntry.value);
  }

  const actionValue = normalize(entry?.action || '');
  const kindValue = normalize(entry?.kind || '');
  const combined = `${actionValue} ${kindValue}`;

  if (combined.includes('fail') || combined.includes('error')) {
    return 'Failed';
  }

  if (
    combined.includes('running') ||
    combined.includes('started') ||
    combined.includes('in progress')
  ) {
    return 'Running';
  }

  if (
    combined.includes('completed') ||
    combined.includes('finished') ||
    combined.includes('analyzed')
  ) {
    return 'Completed';
  }

  return '';
};

const isAnalysisEntry = (entry) => {
  const actionValue = normalize(entry?.action || '');
  const kindValue = normalize(entry?.kind || '');

  return (
    actionValue.includes('analysis') ||
    actionValue.includes('detection') ||
    actionValue.includes('correlate') ||
    actionValue.includes('correlation') ||
    actionValue.includes('anomaly') ||
    kindValue.includes('analysis') ||
    kindValue.includes('detection') ||
    kindValue.includes('correlate') ||
    kindValue.includes('correlation')
  );
};

const buildLatestRunsSummary = (caseData = {}) => {
  const timeline = Array.isArray(caseData.timeline) ? caseData.timeline : [];
  const latestRuns = {
    fdr: null,
    cvr: null,
    correlation: null,
  };

  const toTimestamp = (value) => {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    const time = parsed.getTime();
    return Number.isNaN(time) ? null : time;
  };

  const updateLatest = (moduleKey, candidate) => {
    if (!moduleKey || !candidate) {
      return;
    }
    const current = latestRuns[moduleKey];
    const candidateTime = toTimestamp(candidate.createdAt);
    const currentTime = toTimestamp(current?.createdAt);

    if (currentTime === null && candidateTime === null) {
      if (!current) {
        latestRuns[moduleKey] = candidate;
      }
      return;
    }

    if (currentTime === null || (candidateTime !== null && candidateTime > currentTime)) {
      latestRuns[moduleKey] = candidate;
    }
  };

  timeline.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    const entry = {
      kind: item.kind || item.type || null,
      action: item.action || item.title || item.label || 'Timeline event',
      actor: item.actor || item.user || item.performedBy || item.by || null,
      timestamp: item.timestamp || item.date || item.createdAt || item.time || null,
      metadata: item.metadata || item.details || item.meta || null,
      links: item.links || {},
      runId: item.runId || item.run_id || null,
    };

    const moduleKey = resolveModuleKeyFromEntry(entry);
    if (!moduleKey) {
      return;
    }

    const status = resolveStatusFromEntry(entry);
    if (!status && !isAnalysisEntry(entry)) {
      return;
    }

    updateLatest(moduleKey, {
      status,
      runId: entry.links?.runId || entry.runId || null,
      createdAt: entry.timestamp || null,
      by: resolveActorLabel(entry.actor),
    });
  });

  const fdrStatus = typeof caseData.fdrAnalysisStatus === 'string'
    ? caseData.fdrAnalysisStatus.trim().toUpperCase()
    : null;
  const fdrRun = {
    status:
      fdrStatus === 'COMPLETED'
        ? 'Completed'
        : fdrStatus === 'RUNNING'
          ? 'Running'
          : fdrStatus === 'FAILED'
            ? 'Failed'
            : '',
    runId: caseData.fdrLatestRunId || caseData.fdrAnalysisLatestRun?.runId || null,
    createdAt: caseData.fdrLatestRunAt || caseData.fdrAnalysisLatestRun?.createdAt || null,
    by: resolveActorLabel(caseData.fdrAnalysisLatestRun?.createdBy),
  };

  if (fdrRun.status || fdrRun.runId || fdrRun.createdAt) {
    updateLatest('fdr', fdrRun);
  }

  return latestRuns;
};

const buildCaseStatusSummary = (caseData = {}) => ({
  caseId: caseData.id || null,
  caseNumber: caseData.caseNumber || null,
  uploads: buildUploadsSummary(caseData.attachments || []),
  latestRuns: buildLatestRunsSummary(caseData),
});

module.exports = {
  CASE_COMPUTED_STATUSES,
  CASE_STATUS_LABELS,
  deriveCaseStatus,
  deriveDataStatus,
  computeCaseStatus,
  attachComputedStatus,
  getComputedCaseStatusLabel,
  buildCaseStatusSummary,
};
