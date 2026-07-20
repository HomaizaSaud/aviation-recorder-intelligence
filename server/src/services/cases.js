const pool = require('../db/pool');
const { mapToDbCase, mapFromDbCase, DEFAULT_ANALYSES } = require('../utils/case-mapper');
const { objectExists } = require('./storage');
const {
  attachComputedStatus,
  buildCaseStatusSummary,
  deriveCaseStatus,
  deriveDataStatus,
} = require('../utils/case-status');
const { getLatestFdrAnalysisRun, getLatestFdrAnalysisRuns } = require('./fdr-analysis-runs');
const { computeCvrStatusFromCase } = require('../utils/cvr-status');

const CVR_ACTIVITY_STEP_LABELS = {
  events: 'Event detection',
  denoise: 'Denoise',
  transcription: 'Transcription',
  roles: 'Speaker identification',
  emotion: 'Emotion recognition',
};

const CVR_ACTIVITY_EVENT_TYPES = {
  STARTED: 'CVR_STARTED',
  STEP_COMPLETED: 'CVR_STEP_COMPLETED',
  STEP_FAILED: 'CVR_STEP_FAILED',
  COMPLETED: 'CVR_COMPLETED',
};

const CVR_TERMINAL_STEP_STATUSES = new Set(['completed', 'failed', 'error', 'skipped', 'unavailable']);

const resolveStorageTarget = (attachment) => {
  if (!attachment || typeof attachment !== 'object') {
    return null;
  }

  const storage = attachment.storage;
  if (!storage || typeof storage !== 'object') {
    return null;
  }

  const objectKey = storage.objectKey || storage.key;
  if (!objectKey) {
    return null;
  }

  const bucket = storage.bucket || storage.bucketName || null;
  return { bucket, objectKey };
};

const filterMissingAttachments = async (attachments) => {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const results = await Promise.all(
    attachments.map(async (attachment) => {
      if (!attachment || typeof attachment !== 'object') {
        return attachment || null;
      }

      const target = resolveStorageTarget(attachment);
      if (!target) {
        return attachment;
      }

      try {
        const exists = await objectExists(target);
        if (exists) {
          return attachment;
        }
        return { ...attachment, missingInStorage: true };
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          'Unable to verify object storage entry for attachment',
          target.bucket,
          target.objectKey,
          error,
        );
        return attachment;
      }
    }),
  );

  return results.filter((item) => Boolean(item));
};

const hydrateCaseRow = async (row) => {
  const mapped = mapFromDbCase(row);
  const attachments = await filterMissingAttachments(mapped.attachments);
  return { ...mapped, attachments };
};

const attachFdrAnalysisSummary = (caseData, latestRun = null) => {
  if (!caseData) {
    return caseData;
  }

  const latestRunId = latestRun?.runId || caseData.fdrLastRunId || null;
  const latestRunAt = latestRun?.createdAt || caseData.fdrLastRunAt || null;
  const normalizedStatus =
    typeof caseData.fdrAnalysisStatus === 'string'
      ? caseData.fdrAnalysisStatus.trim().toUpperCase()
      : null;
  const latestRunStatus =
    normalizedStatus === 'RUNNING' || normalizedStatus === 'COMPLETED' || normalizedStatus === 'FAILED'
      ? normalizedStatus
      : null;
  const hasResults =
    Boolean(caseData.fdrAnalysis) || Boolean(latestRun) || Boolean(caseData.fdrLastRunId);

  return {
    ...caseData,
    fdrAnalysisLatestRun: latestRun,
    fdrHasResults: hasResults,
    fdrLatestRunId: latestRunId,
    fdrLatestRunAt: latestRunAt,
    fdrLatestRunStatus: latestRunStatus,
  };
};

const attachLatestFdrAnalysisRun = async (caseData) => {
  if (!caseData || !caseData.id) {
    return caseData;
  }

  const latestRun = await getLatestFdrAnalysisRun(caseData.id);
  return attachFdrAnalysisSummary(caseData, latestRun);
};


const attachCvrAnalysisSummary = (caseData) => {
  if (!caseData || typeof caseData !== 'object') {
    return caseData;
  }

  const analyses = caseData.analyses && typeof caseData.analyses === 'object' ? caseData.analyses : {};
  const cvr = analyses.cvr && typeof analyses.cvr === 'object' ? analyses.cvr : {};
  const pipeline = cvr.pipeline && typeof cvr.pipeline === 'object' ? cvr.pipeline : {};
  const { status, stepStatuses } = computeCvrStatusFromCase({ ...caseData, analyses });

  return {
    ...caseData,
    analyses: {
      ...analyses,
      cvr: {
        ...cvr,
        status,
        stepStatuses,
        pipeline: {
          ...pipeline,
          stepStatuses,
        },
      },
    },
  };
};

const attachCorrelationFutureStatus = (caseData) => {
  if (!caseData || typeof caseData !== 'object') {
    return caseData;
  }

  const analyses = caseData.analyses && typeof caseData.analyses === 'object' ? caseData.analyses : {};
  const correlate = analyses.correlate && typeof analyses.correlate === 'object' ? analyses.correlate : {};

  return {
    ...caseData,
    analyses: {
      ...analyses,
      correlate: {
        ...correlate,
        status: 'Not Started',
        lastRun: null,
      },
    },
  };
};

const attachCaseStatusSummary = (caseData) => {
  if (!caseData || typeof caseData !== 'object') {
    return caseData;
  }

  return {
    ...caseData,
    caseStatusSummary: buildCaseStatusSummary(caseData),
  };
};

const normalizePipelineStepStatus = (value) => String(value || '').trim().toLowerCase();

const normalizeCvrOverallStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['analyzed', 'completed', 'complete', 'success'].includes(normalized)) {
    return 'Analyzed';
  }
  if (['running', 'in_progress', 'in progress'].includes(normalized)) {
    return 'Running';
  }
  if (['partial', 'partially_completed', 'partially completed'].includes(normalized)) {
    return 'Partial';
  }
  if (['failed', 'error'].includes(normalized)) {
    return 'Failed';
  }
  return value ? String(value) : 'Running';
};

const resolveActorFromUser = (user) => {
  if (!user || typeof user !== 'object') {
    return { name: 'System' };
  }

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    id: user.id,
    name: name || user.name || user.email || 'System',
    email: user.email || undefined,
  };
};

const buildMetadataIfExists = (label, value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return { label, value: String(value) };
};

const deriveCvrTimelineEntries = ({
  currentTimeline,
  previousPipeline,
  nextPipeline,
  cvrStatus,
  caseNumber,
  attachments,
  actor,
}) => {
  const entries = [];
  const now = new Date().toISOString();
  const nextRunId = nextPipeline?.runId || previousPipeline?.runId || null;
  const previousRunId = previousPipeline?.runId || null;
  const timelineItems = Array.isArray(currentTimeline) ? currentTimeline : [];
  const cvrFiles = Array.isArray(attachments)
    ? attachments.filter((item) => String(item?.type || '').toUpperCase() === 'CVR')
    : [];
  const latestCvrFile = cvrFiles.sort((a, b) => {
    const aTime = new Date(a?.uploadedAt || a?.createdAt || 0).getTime();
    const bTime = new Date(b?.uploadedAt || b?.createdAt || 0).getTime();
    return bTime - aTime;
  })[0];

  const hasStartEntryForRun = timelineItems.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return item.eventType === CVR_ACTIVITY_EVENT_TYPES.STARTED && item?.links?.runId === nextRunId;
  });

  const nextSteps = nextPipeline?.steps && typeof nextPipeline.steps === 'object' ? nextPipeline.steps : {};
  const previousSteps =
    previousPipeline?.steps && typeof previousPipeline.steps === 'object' ? previousPipeline.steps : {};

  const hasAnyActiveStep = Object.values(nextSteps).some((step) => {
    const status = normalizePipelineStepStatus(step?.status);
    return ['running', 'completed', 'failed', 'error', 'skipped'].includes(status);
  });

  if (nextRunId && hasAnyActiveStep && (!hasStartEntryForRun || previousRunId !== nextRunId)) {
    entries.push({
      id: `cvr-started-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'cvr_analysis_started',
      action: 'CVR analysis started',
      eventType: CVR_ACTIVITY_EVENT_TYPES.STARTED,
      actor,
      timestamp: now,
      metadata: [
        buildMetadataIfExists('Run ID', nextRunId),
        buildMetadataIfExists('Audio file', latestCvrFile?.name),
      ].filter(Boolean),
      links: {
        runId: nextRunId,
        resultsUrl: `/cases/${encodeURIComponent(caseNumber)}/cvr`,
      },
    });
  }

  Object.entries(nextSteps).forEach(([stepName, stepValue]) => {
    const currentStatus = normalizePipelineStepStatus(stepValue?.status);
    const previousStatus = normalizePipelineStepStatus(previousSteps?.[stepName]?.status);
    if (!currentStatus || currentStatus === previousStatus || !['completed', 'failed', 'error'].includes(currentStatus)) {
      return;
    }

    const stepLabel = CVR_ACTIVITY_STEP_LABELS[stepName] || stepName;
    const durationSeconds =
      stepValue?.durationSeconds ??
      stepValue?.summaryStats?.durationSeconds ??
      stepValue?.output?.durationSeconds ??
      null;
    const errorMessage =
      stepValue?.error || stepValue?.errorMessage || stepValue?.output?.error || stepValue?.output?.errorMessage;
    const isFailed = ['failed', 'error'].includes(currentStatus);

    entries.push({
      id: `cvr-step-${stepName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: isFailed ? 'cvr_step_failed' : 'cvr_step_completed',
      action: `CVR: ${stepLabel} ${isFailed ? 'failed' : 'completed'}`,
      eventType: isFailed ? CVR_ACTIVITY_EVENT_TYPES.STEP_FAILED : CVR_ACTIVITY_EVENT_TYPES.STEP_COMPLETED,
      actor,
      timestamp: stepValue?.updatedAt || stepValue?.completedAt || now,
      metadata: [
        buildMetadataIfExists('Run ID', nextRunId),
        buildMetadataIfExists('Step', stepLabel),
        buildMetadataIfExists('Duration', durationSeconds !== null ? `${durationSeconds}s` : null),
        buildMetadataIfExists('Error', isFailed ? errorMessage : null),
      ].filter(Boolean),
      links: {
        runId: nextRunId,
        resultsUrl: `/cases/${encodeURIComponent(caseNumber)}/cvr`,
      },
    });
  });

  const requiredSteps = ['events', 'denoise', 'transcription', 'roles', 'emotion'];
  const pipelineTerminal = requiredSteps.every((stepName) => {
    const status = normalizePipelineStepStatus(nextSteps?.[stepName]?.status);
    return CVR_TERMINAL_STEP_STATUSES.has(status);
  });

  const hasCompletionEntryForRun = timelineItems.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return item.eventType === CVR_ACTIVITY_EVENT_TYPES.COMPLETED && item?.links?.runId === nextRunId;
  });

  if (nextRunId && pipelineTerminal && !hasCompletionEntryForRun) {
    const overallStatus = normalizeCvrOverallStatus(cvrStatus);
    entries.push({
      id: `cvr-completed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'cvr_analysis_completed',
      action: 'CVR analysis completed',
      eventType: CVR_ACTIVITY_EVENT_TYPES.COMPLETED,
      actor,
      timestamp: now,
      metadata: [
        buildMetadataIfExists('Run ID', nextRunId),
        buildMetadataIfExists('Overall status', overallStatus),
      ].filter(Boolean),
      links: {
        runId: nextRunId,
        resultsUrl: `/cases/${encodeURIComponent(caseNumber)}/cvr`,
      },
    });
  }

  return entries;
};

const listCases = async ({ page = 1, pageSize = 20 } = {}) => {
  const normalizedPage = Number.parseInt(page, 10);
  const normalizedPageSize = Number.parseInt(pageSize, 10);
  const safePage = Number.isNaN(normalizedPage) || normalizedPage < 1 ? 1 : normalizedPage;
  const safePageSize =
    Number.isNaN(normalizedPageSize) || normalizedPageSize < 1 ? 20 : normalizedPageSize;
  const offset = (safePage - 1) * safePageSize;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM cases'),
    pool.query(
      `SELECT * FROM cases
      ORDER BY last_updated DESC NULLS LAST, created_at DESC
      LIMIT $1 OFFSET $2`,
      [safePageSize, offset],
    ),
  ]);
  const total = countRows?.[0]?.total ?? 0;
  const safeRows = Array.isArray(rows) ? rows : [];
  const hydratedCases = await Promise.all(safeRows.map(hydrateCaseRow));
  const caseIds = hydratedCases.map((caseItem) => caseItem?.id).filter(Boolean);
  const latestRuns = await getLatestFdrAnalysisRuns(caseIds);

  const data = hydratedCases.map((caseItem) =>
    attachCaseStatusSummary(
      attachComputedStatus(
        attachCvrAnalysisSummary(
        attachCorrelationFutureStatus(
          attachFdrAnalysisSummary(caseItem, latestRuns.get(caseItem?.id) || null),
        ),
        ),
      ),
    ),
  );

  return {
    data,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: safePageSize > 0 ? Math.max(1, Math.ceil(total / safePageSize)) : 1,
  };
};

const findCaseByNumber = async (caseNumber) => {
  const { rows } = await pool.query('SELECT * FROM cases WHERE case_number = $1', [caseNumber]);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const hydrated = await hydrateCaseRow(rows[0]);
  const withRun = await attachLatestFdrAnalysisRun(hydrated);
  return attachCaseStatusSummary(
    attachComputedStatus(attachCvrAnalysisSummary(attachCorrelationFutureStatus(withRun))),
  );
};

const toNullIfEmpty = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
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

const coerceJsonValue = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }

    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return fallback;
    }
  }

  if (typeof value === 'object') {
    return value;
  }

  return fallback;
};

const toJsonbParameter = (value, fallback) => JSON.stringify(coerceJsonValue(value, fallback));

const extractRows = (result) => {
  if (!result || !Array.isArray(result.rows)) {
    return [];
  }

  return result.rows;
};

const createCase = async (payload) => {
  const data = mapToDbCase(payload);
  const derivedStatus = deriveCaseStatus(data);
  const derivedDataStatus = deriveDataStatus(data.attachments);

  const query = `
    INSERT INTO cases (
      case_number,
      case_name,
      module,
      status,
      owner,
      organization,
      examiner,
      aircraft_type,
      location,
      summary,
      investigator_summary,
      investigator_summary_edited_by,
      investigator_summary_edited_at,
      last_updated,
      occurrence_date,
      tags,
      analyses,
      fdr_analysis,
      fdr_analysis_updated_at,
      fdr_analysis_status,
      fdr_last_run_id,
      fdr_last_run_at,
      timeline,
      attachments,
      investigator,
      aircraft
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12::jsonb, $13, $14,
      $15, $16, $17::jsonb, $18::jsonb, $19,
      $20, $21, $22,
      $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb
    )
    RETURNING *
  `;

  const values = [
    data.case_number,
    toNullIfEmpty(data.case_name),
    toNullIfEmpty(derivedDataStatus),
    toNullIfEmpty(derivedStatus),
    toNullIfEmpty(data.owner),
    toNullIfEmpty(data.organization),
    toNullIfEmpty(data.examiner),
    toNullIfEmpty(data.aircraft_type),
    toNullIfEmpty(data.location),
    toNullIfEmpty(data.summary),
    toNullIfEmpty(data.investigator_summary),
    toJsonbParameter(data.investigator_summary_edited_by, {}),
    data.investigator_summary_edited_at,
    data.last_updated,
    data.occurrence_date,
    data.tags,
    toJsonbParameter(data.analyses, {}),
    toJsonbParameter(data.fdr_analysis, null),
    data.fdr_analysis_updated_at,
    toNullIfEmpty(data.fdr_analysis_status),
    toNullIfEmpty(data.fdr_last_run_id),
    data.fdr_last_run_at,
    toJsonbParameter(data.timeline, []),
    toJsonbParameter(data.attachments, []),
    toJsonbParameter(data.investigator, {}),
    toJsonbParameter(data.aircraft, {}),
  ];

  const { rows } = await pool.query(query, values);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const hydrated = await hydrateCaseRow(rows[0]);
  return attachCaseStatusSummary(
    attachComputedStatus(
      attachCvrAnalysisSummary(attachCorrelationFutureStatus(attachFdrAnalysisSummary(hydrated, null))),
    ),
  );
};

const updateCase = async (caseNumber, payload) => {
  const data = mapToDbCase(payload);
  const derivedStatus = deriveCaseStatus(data);
  const derivedDataStatus = deriveDataStatus(data.attachments);

  const { rows: existingRows } = await pool.query('SELECT analyses FROM cases WHERE case_number = $1', [caseNumber]);
  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return null;
  }

  const existingAnalyses = existingRows[0]?.analyses && typeof existingRows[0].analyses === 'object'
    ? existingRows[0].analyses
    : DEFAULT_ANALYSES;
  const nextAnalyses = {
    ...data.analyses,
    correlate: existingAnalyses?.correlate || DEFAULT_ANALYSES.correlate,
  };

  const query = `
    UPDATE cases
    SET
      case_name = $1,
      module = $2,
      status = $3,
      owner = $4,
      organization = $5,
      examiner = $6,
      aircraft_type = $7,
      location = $8,
      summary = $9,
      investigator_summary = $10,
      investigator_summary_edited_by = $11::jsonb,
      investigator_summary_edited_at = $12,
      last_updated = $13,
      occurrence_date = $14,
      tags = $15,
      analyses = $16::jsonb,
      fdr_analysis = $17::jsonb,
      fdr_analysis_updated_at = $18,
      timeline = $19::jsonb,
      attachments = $20::jsonb,
      investigator = $21::jsonb,
      aircraft = $22::jsonb
    WHERE case_number = $23
    RETURNING *
  `;

  const values = [
    toNullIfEmpty(data.case_name),
    toNullIfEmpty(derivedDataStatus),
    toNullIfEmpty(derivedStatus),
    toNullIfEmpty(data.owner),
    toNullIfEmpty(data.organization),
    toNullIfEmpty(data.examiner),
    toNullIfEmpty(data.aircraft_type),
    toNullIfEmpty(data.location),
    toNullIfEmpty(data.summary),
    toNullIfEmpty(data.investigator_summary),
    toJsonbParameter(data.investigator_summary_edited_by, {}),
    data.investigator_summary_edited_at,
    data.last_updated,
    data.occurrence_date,
    data.tags,
    toJsonbParameter(nextAnalyses, {}),
    toJsonbParameter(data.fdr_analysis, null),
    data.fdr_analysis_updated_at,
    toJsonbParameter(data.timeline, []),
    toJsonbParameter(data.attachments, []),
    toJsonbParameter(data.investigator, {}),
    toJsonbParameter(data.aircraft, {}),
    caseNumber,
  ];

  const result = await pool.query(query, values);
  const rows = extractRows(result);
  if (!Array.isArray(rows) || rows.length === 0){
    return null;
  }

  const hydrated = await hydrateCaseRow(rows[0]);
  const withRun = await attachLatestFdrAnalysisRun(hydrated);
  return attachCaseStatusSummary(
    attachComputedStatus(attachCvrAnalysisSummary(attachCorrelationFutureStatus(withRun))),
  );
};

const updateCaseInvestigatorSummary = async (
  caseNumber,
  { investigatorSummary, investigatorSummaryEditedBy, investigatorSummaryEditedAt, lastUpdated },
) => {
  const query = `
    UPDATE cases
    SET
      investigator_summary = $1,
      investigator_summary_edited_by = $2::jsonb,
      investigator_summary_edited_at = $3,
      last_updated = $4
    WHERE case_number = $5
    RETURNING *
  `;

  const safeEditedBy =
    investigatorSummaryEditedBy && typeof investigatorSummaryEditedBy === 'object'
      ? investigatorSummaryEditedBy
      : {};

  const values = [
    toNullIfEmpty(investigatorSummary),
    toJsonbParameter(safeEditedBy, {}),
    investigatorSummaryEditedAt || null,
    normalizeDate(lastUpdated),
    caseNumber,
  ];

  const result = await pool.query(query, values);
  const rows = extractRows(result);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const hydrated = await hydrateCaseRow(rows[0]);
  const withRun = await attachLatestFdrAnalysisRun(hydrated);
  return attachCaseStatusSummary(
    attachComputedStatus(attachCvrAnalysisSummary(attachCorrelationFutureStatus(withRun))),
  );
};

const deleteCase = async (caseNumber) => {
  const { rowCount } = await pool.query('DELETE FROM cases WHERE case_number = $1', [caseNumber]);
  return rowCount > 0;
};

const updateCaseFdrAnalysis = async (caseNumber, analysisPayload, runMetadata = {}) => {
  const lastRunId = runMetadata.lastRunId || null;
  const lastRunAt = runMetadata.lastRunAt || null;
  const nextStatus = runMetadata.status || null;
  const query = `
    UPDATE cases
    SET
      fdr_analysis = $1::jsonb,
      fdr_analysis_updated_at = NOW(),
      fdr_analysis_status = $2,
      fdr_last_run_id = $3,
      fdr_last_run_at = $4
    WHERE case_number = $5
    RETURNING *
  `;

  const values = [
    toJsonbParameter(analysisPayload, null),
    toNullIfEmpty(nextStatus),
    toNullIfEmpty(lastRunId),
    lastRunAt,
    caseNumber,
  ];
  const result = await pool.query(query, values);
  const rows = extractRows(result);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return hydrateCaseRow(rows[0]);
};

const updateCaseFdrAnalysisStatus = async (caseNumber, status, lastRunId = null, lastRunAt = null) => {
  const query = `
    UPDATE cases
    SET
      fdr_analysis_status = $1,
      fdr_last_run_id = COALESCE($2, fdr_last_run_id),
      fdr_last_run_at = COALESCE($3, fdr_last_run_at)
    WHERE case_number = $4
    RETURNING *
  `;

  const values = [
    toNullIfEmpty(status),
    toNullIfEmpty(lastRunId),
    lastRunAt,
    caseNumber,
  ];
  const result = await pool.query(query, values);
  const rows = extractRows(result);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return hydrateCaseRow(rows[0]);
};

const updateCaseCvrPipeline = async (caseNumber, pipeline, options = {}) => {
  const { rows } = await pool.query('SELECT analyses, attachments, timeline FROM cases WHERE case_number = $1', [caseNumber]);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const currentAnalyses = rows[0].analyses || DEFAULT_ANALYSES;
  const currentTimeline = Array.isArray(rows[0].timeline) ? rows[0].timeline : [];
  const actor = resolveActorFromUser(options.user || options.actor);
  const nextPipeline =
    pipeline && typeof pipeline === 'object' && pipeline.pipeline && typeof pipeline.pipeline === 'object'
      ? pipeline.pipeline
      : pipeline;
  const draftAnalyses = {
    ...DEFAULT_ANALYSES,
    ...currentAnalyses,
    cvr: {
      ...DEFAULT_ANALYSES.cvr,
      ...(currentAnalyses?.cvr || {}),
      pipeline: nextPipeline && typeof nextPipeline === 'object' ? nextPipeline : {},
    },
  };
  const cvrDerived = computeCvrStatusFromCase({
    analyses: draftAnalyses,
    attachments: Array.isArray(rows[0].attachments) ? rows[0].attachments : [],
  });
  const nextAnalyses = {
    ...draftAnalyses,
    cvr: {
      ...draftAnalyses.cvr,
      status: cvrDerived.status,
      stepStatuses: cvrDerived.stepStatuses,
      pipeline: {
        ...(draftAnalyses.cvr.pipeline || {}),
        stepStatuses: cvrDerived.stepStatuses,
      },
    },
  };
  const timelineEntries = deriveCvrTimelineEntries({
    currentTimeline,
    previousPipeline: currentAnalyses?.cvr?.pipeline || {},
    nextPipeline: nextAnalyses?.cvr?.pipeline || {},
    cvrStatus: nextAnalyses?.cvr?.status,
    caseNumber,
    attachments: rows[0].attachments,
    actor,
  });
  const nextTimeline = [...currentTimeline, ...timelineEntries];

  const result = await pool.query(
    `
      UPDATE cases
      SET analyses = $1::jsonb,
          timeline = $2::jsonb,
          last_updated = NOW()
      WHERE case_number = $3
      RETURNING *
    `,
    [toJsonbParameter(nextAnalyses, DEFAULT_ANALYSES), toJsonbParameter(nextTimeline, []), caseNumber],
  );

  const rowsUpdated = extractRows(result);
  if (!Array.isArray(rowsUpdated) || rowsUpdated.length === 0) {
    return null;
  }

  const hydrated = await hydrateCaseRow(rowsUpdated[0]);
  const withRun = await attachLatestFdrAnalysisRun(hydrated);
  return attachCaseStatusSummary(
    attachComputedStatus(attachCvrAnalysisSummary(attachCorrelationFutureStatus(withRun))),
  );
};

const getFdrOccurrence = async (caseNumber) => {
  const { rows } = await pool.query(
    `SELECT analyses->'fdr'->'occurrenceWindow' AS window FROM cases WHERE case_number = $1`,
    [caseNumber],
  );
  if (!rows[0]) return null;
  const w = rows[0].window;
  return {
    start: w?.start ?? null,
    end: w?.end ?? null,
    label: w?.label ?? null,
  };
};

const setFdrOccurrence = async (caseNumber, { start, end, label }) => {
  const windowJson = JSON.stringify({
    start: start ?? null,
    end: end ?? null,
    label: label ?? null,
  });
  const { rows } = await pool.query(
    `UPDATE cases
     SET analyses = jsonb_set(analyses, '{fdr,occurrenceWindow}', $1::jsonb, true),
         updated_at = NOW()
     WHERE case_number = $2
     RETURNING analyses->'fdr'->'occurrenceWindow' AS window`,
    [windowJson, caseNumber],
  );
  if (!rows[0]) return null;
  const w = rows[0].window;
  return {
    start: w?.start ?? null,
    end: w?.end ?? null,
    label: w?.label ?? null,
  };
};

const getFdrCorrections = async (caseNumber) => {
  const { rows } = await pool.query(
    `SELECT COALESCE(analyses->'fdr'->'corrections', '[]'::jsonb) AS corrections FROM cases WHERE case_number = $1`,
    [caseNumber],
  );
  if (!rows[0]) return null;
  const c = rows[0].corrections;
  return Array.isArray(c) ? c : [];
};

const addFdrCorrection = async (caseNumber, correction) => {
  const { rows } = await pool.query(
    `UPDATE cases
     SET analyses = jsonb_set(
       analyses,
       '{fdr,corrections}',
       COALESCE(analyses->'fdr'->'corrections', '[]'::jsonb) || $1::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE case_number = $2
     RETURNING analyses->'fdr'->'corrections' AS corrections`,
    [JSON.stringify(correction), caseNumber],
  );
  if (!rows[0]) return null;
  const c = rows[0].corrections;
  return Array.isArray(c) ? c : [];
};

const deleteFdrCorrection = async (caseNumber, correctionId) => {
  const { rows } = await pool.query(
    `UPDATE cases
     SET analyses = jsonb_set(
       analyses,
       '{fdr,corrections}',
       COALESCE(
         (SELECT jsonb_agg(elem)
          FROM jsonb_array_elements(analyses->'fdr'->'corrections') elem
          WHERE elem->>'id' != $1),
         '[]'::jsonb
       ),
       true
     ),
     updated_at = NOW()
     WHERE case_number = $2
     RETURNING analyses->'fdr'->'corrections' AS corrections`,
    [correctionId, caseNumber],
  );
  if (!rows[0]) return null;
  const c = rows[0].corrections;
  return Array.isArray(c) ? c : [];
};

module.exports = {
  listCases,
  findCaseByNumber,
  createCase,
  updateCase,
  updateCaseInvestigatorSummary,
  deleteCase,
  updateCaseFdrAnalysis,
  updateCaseFdrAnalysisStatus,
  updateCaseCvrPipeline,
  getFdrOccurrence,
  setFdrOccurrence,
  getFdrCorrections,
  addFdrCorrection,
  deleteFdrCorrection,
};
