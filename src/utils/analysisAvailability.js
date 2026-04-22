const ATTACHMENT_TYPES = {
  fdr: 'FDR',
  cvr: 'CVR',
};

const MODULE_LABELS = {
  fdr: 'FDR analysis',
  cvr: 'CVR analysis',
  correlate: 'correlation analysis',
};

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

const extractAttachments = (caseData) => {
  if (!caseData || !Array.isArray(caseData.attachments)) {
    return [];
  }

  return caseData.attachments.filter((item) => Boolean(item));
};

const matchesType = (attachment, type) => {
  const attachmentType = normalizeString(attachment?.type).toUpperCase();
  return attachmentType === type.toUpperCase();
};

const isAttachmentReady = (attachment) => {
  const status = normalizeString(attachment?.status).toLowerCase();
  if (status === 'pending') {
    return false;
  }

  const name = normalizeString(attachment?.name).toLowerCase();
  if (name.includes('pending upload')) {
    return false;
  }

  return true;
};

const hasDataForType = (caseData, type) =>
  extractAttachments(caseData).some((attachment) => matchesType(attachment, type) && isAttachmentReady(attachment));

export const getCaseDataAvailability = (caseData) => {
  const hasFdr = hasDataForType(caseData, ATTACHMENT_TYPES.fdr);
  const hasCvr = hasDataForType(caseData, ATTACHMENT_TYPES.cvr);

  return {
    hasFdr,
    hasCvr,
  };
};

export const evaluateModuleReadiness = (caseData, moduleKey) => {
  const normalizedKey = normalizeString(moduleKey).toLowerCase();
  const { hasFdr, hasCvr } = getCaseDataAvailability(caseData);

  let missingTypes = [];
  if (normalizedKey === 'fdr') {
    missingTypes = hasFdr ? [] : [ATTACHMENT_TYPES.fdr];
  } else if (normalizedKey === 'cvr') {
    missingTypes = hasCvr ? [] : [ATTACHMENT_TYPES.cvr];
  } else if (normalizedKey === 'correlate') {
    missingTypes = [
      ...(hasFdr ? [] : [ATTACHMENT_TYPES.fdr]),
      ...(hasCvr ? [] : [ATTACHMENT_TYPES.cvr]),
    ];
  } else {
    missingTypes = [];
  }

  if (missingTypes.length === 0) {
    return { ready: true, missingTypes: [], message: '' };
  }

  const readableMissing = listFormat.format(
    missingTypes.map((type) => (type === ATTACHMENT_TYPES.fdr ? 'FDR data' : 'CVR data')),
  );
  const moduleLabel = MODULE_LABELS[normalizedKey] || 'selected module';

  return {
    ready: false,
    missingTypes,
    message: `The selected case is missing ${readableMissing}. Upload the required recordings before continuing with the ${moduleLabel}.`,
  };
};

export const describeModuleRequirement = (moduleKey) => {
  const normalizedKey = normalizeString(moduleKey).toLowerCase();
  switch (normalizedKey) {
    case 'fdr':
      return 'Requires an uploaded FDR dataset for the chosen case.';
    case 'cvr':
      return 'Requires an uploaded CVR dataset for the chosen case.';
    case 'correlate':
      return 'Requires both FDR and CVR datasets for the chosen case to run correlation.';
    default:
      return 'Requires the appropriate recorder data for the chosen case.';
  }
};

export const getModuleTitle = (moduleKey) => {
  const normalizedKey = normalizeString(moduleKey).toLowerCase();
  switch (normalizedKey) {
    case 'fdr':
      return 'FDR Module';
    case 'cvr':
      return 'CVR Module';
    case 'correlate':
      return 'Correlation Module';
    default:
      return 'Analysis Module';
  }
};