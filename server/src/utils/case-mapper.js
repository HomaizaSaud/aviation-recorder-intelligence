const DEFAULT_ANALYSES = {
  fdr: { status: 'Not Started', lastRun: null, summary: '' },
  cvr: { status: 'Not Started', lastRun: null, summary: '' },
  correlate: { status: 'Not Started', lastRun: null, summary: '' },
};

const normalizeDate = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
};

const mapToDbCase = (payload) => {
  const {
    caseNumber,
    caseName,
    module,
    status,
    owner,
    organization = '',
    examiner = '',
    aircraftType = '',
    location = '',
    summary = '',
    investigatorSummary = '',
    investigatorSummaryEditedBy = {},
    investigatorSummaryEditedAt,
    lastUpdated,
    date,
    tags = [],
    analyses,
    fdrAnalysis,
    fdrAnalysisUpdatedAt,
    fdrAnalysisStatus,
    fdrLastRunId,
    fdrLastRunAt,
    timeline = [],
    attachments = [],
    investigator = {},
    aircraft = {},
  } = payload;

  return {
    case_number: caseNumber,
    case_name: caseName,
    module,
    status,
    owner,
    organization,
    examiner,
    aircraft_type: aircraftType,
    location,
    summary,
    investigator_summary: investigatorSummary,
    investigator_summary_edited_by:
      investigatorSummaryEditedBy && typeof investigatorSummaryEditedBy === 'object'
        ? investigatorSummaryEditedBy
        : {},
    investigator_summary_edited_at: investigatorSummaryEditedAt || null,
    last_updated: normalizeDate(lastUpdated),
    occurrence_date: normalizeDate(date),
    tags: Array.isArray(tags) ? tags : [],
    analyses: analyses && typeof analyses === 'object' ? analyses : DEFAULT_ANALYSES,
    fdr_analysis: fdrAnalysis && typeof fdrAnalysis === 'object' ? fdrAnalysis : null,
    fdr_analysis_updated_at: fdrAnalysisUpdatedAt || null,
    fdr_analysis_status: fdrAnalysisStatus || 'NOT_STARTED',
    fdr_last_run_id: fdrLastRunId || null,
    fdr_last_run_at: fdrLastRunAt || null,
    timeline: Array.isArray(timeline) ? timeline : [],
    attachments: Array.isArray(attachments) ? attachments : [],
    investigator: investigator && typeof investigator === 'object' ? investigator : {},
    aircraft: aircraft && typeof aircraft === 'object' ? aircraft : {},
  };
};

const mapFromDbCase = (row) => ({
  id: row.id,
  caseNumber: row.case_number,
  caseName: row.case_name,
  module: row.module,
  status: row.status,
  owner: row.owner,
  organization: row.organization || '',
  examiner: row.examiner || '',
  aircraftType: row.aircraft_type || '',
  location: row.location || '',
  summary: row.summary || '',
  investigatorSummary: row.investigator_summary || '',
  investigatorSummaryEditedBy: row.investigator_summary_edited_by || {},
  investigatorSummaryEditedAt: row.investigator_summary_edited_at
    ? row.investigator_summary_edited_at.toISOString()
    : null,
  lastUpdated: row.last_updated ? row.last_updated.toISOString().slice(0, 10) : null,
  date: row.occurrence_date ? row.occurrence_date.toISOString().slice(0, 10) : null,
  tags: row.tags || [],
  analyses: row.analyses || DEFAULT_ANALYSES,
  fdrAnalysis: row.fdr_analysis || null,
  fdrAnalysisUpdatedAt: row.fdr_analysis_updated_at
    ? row.fdr_analysis_updated_at.toISOString()
    : null,
  fdrAnalysisStatus: row.fdr_analysis_status || 'NOT_STARTED',
  fdrLastRunId: row.fdr_last_run_id || null,
  fdrLastRunAt: row.fdr_last_run_at ? row.fdr_last_run_at.toISOString() : null,
  timeline: row.timeline || [],
  attachments: row.attachments || [],
  investigator: row.investigator || {},
  aircraft: row.aircraft || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

module.exports = {
  mapToDbCase,
  mapFromDbCase,
  DEFAULT_ANALYSES,
};
