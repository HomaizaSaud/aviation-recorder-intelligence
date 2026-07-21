const PDFDocument = require('pdfkit');
const {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require('docx');

const { countNotesByCaseId, listNotesByCaseId } = require('./notes');
const { getFdrAnalysisRunById, getLatestFdrAnalysisRun } = require('./fdr-analysis-runs');
const { getFdrCorrections } = require('./cases');

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const statusIndicatesResults = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return [
    'completed',
    'complete',
    'analyzed',
    'finished',
    'correlate analyzed',
    'correlation analyzed',
  ].includes(normalized);
};

const buildAvailability = (caseData, notesCount = 0) => {
  const fdrLatestRunId =
    caseData?.fdrAnalysisLatestRun?.runId ||
    caseData?.fdrLatestRunId ||
    caseData?.fdrLastRunId ||
    null;
  const hasFdrResults =
    Boolean(caseData?.fdrHasResults) ||
    Boolean(caseData?.fdrAnalysisLatestRun) ||
    Boolean(caseData?.fdrAnalysis) ||
    statusIndicatesResults(caseData?.analyses?.fdr?.status);

  const cvrLastRun = caseData?.analyses?.cvr?.lastRun || null;
  const cvrSummary = normalizeString(caseData?.analyses?.cvr?.summary);
  const hasCvrResults =
    statusIndicatesResults(caseData?.analyses?.cvr?.status) ||
    Boolean(cvrLastRun) ||
    Boolean(cvrSummary);

  const corrLastRun = caseData?.analyses?.correlate?.lastRun || null;
  const corrSummary = normalizeString(caseData?.analyses?.correlate?.summary);
  const hasCorrelationResults =
    statusIndicatesResults(caseData?.analyses?.correlate?.status) ||
    Boolean(corrLastRun) ||
    Boolean(corrSummary);

  return {
    has_fdr_results: hasFdrResults,
    latest_fdr_run_id: fdrLatestRunId,
    has_cvr_results: hasCvrResults,
    latest_cvr_run_id: cvrLastRun,
    has_correlation_results: hasCorrelationResults,
    latest_corr_run_id: corrLastRun,
    notes_count: notesCount || 0,
  };
};

const getReportAvailability = async (caseData) => {
  if (!caseData?.id) {
    return buildAvailability(caseData, 0);
  }

  const notesCount = await countNotesByCaseId(caseData.id);
  return buildAvailability(caseData, notesCount);
};

const formatDisplayDateTime = (value) => {
  if (!value) {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
};

const formatFileTimestamp = (date) => {
  const safeDate = date instanceof Date ? date : new Date(date);
  const year = safeDate.getUTCFullYear();
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getUTCDate()).padStart(2, '0');
  const hours = String(safeDate.getUTCHours()).padStart(2, '0');
  const minutes = String(safeDate.getUTCMinutes()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}`;
};

const formatStorageReference = (storage) => {
  if (!storage) {
    return null;
  }
  const bucket = normalizeString(storage.bucket);
  const objectKey = normalizeString(storage.objectKey);
  if (bucket && objectKey) {
    return `${bucket}/${objectKey}`;
  }
  return objectKey || bucket || null;
};

const formatDurationSeconds = (value) => {
  if (value == null || value === '') {
    return '—';
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return String(value);
  }
  return `${seconds.toFixed(1)} sec`;
};

const formatPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric >= 0 && numeric <= 1) {
    return `${(numeric * 100).toFixed(1)}%`;
  }
  return `${numeric.toFixed(1)}%`;
};

const buildTranscriptExcerpt = (text, lineCount = 4) => {
  const normalized = normalizeString(text);
  if (!normalized) {
    return [];
  }
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lineCount);
};

const extractStepFailureReason = (stepData) => {
  if (!stepData) {
    return 'Step not run.';
  }
  const errorCandidates = [
    stepData.error,
    stepData.reason,
    stepData.message,
    stepData.output?.error,
    stepData.output?.reason,
    stepData.output?.message,
  ];
  const firstError = errorCandidates.map(normalizeString).find(Boolean);
  if (firstError) {
    return firstError;
  }

  const status = normalizeString(stepData.status).toLowerCase();
  if (!status || status === 'pending') {
    return 'Step not run.';
  }
  if (status === 'failed' || status === 'error') {
    return 'Step failed.';
  }
  if (status === 'unavailable') {
    return 'Not available in this build.';
  }
  return `Step status: ${stepData.status || 'unknown'}.`;
};

const extractEmotionSummary = (stepData) => {
  const output = stepData?.output || {};
  const distribution =
    output.summaryDistribution ||
    output.distribution ||
    output.emotionDistribution ||
    output.summaryStats?.distribution ||
    null;
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
    return [];
  }
  return Object.entries(distribution)
    .map(([label, value]) => {
      const percent = formatPercent(value);
      return percent ? `${label}: ${percent}` : `${label}: ${String(value)}`;
    })
    .filter(Boolean);
};

const toEventLabel = (event, index) =>
  event?.label || event?.event_type || event?.eventType || event?.type || `event_${index + 1}`;

const toEventTimestamp = (event) => {
  const candidate = event?.timestamp ?? event?.time ?? event?.start ?? event?.startTime;
  if (candidate == null) {
    return '—';
  }
  const numeric = Number(candidate);
  if (Number.isFinite(numeric)) {
    return `${numeric.toFixed(2)}s`;
  }
  return String(candidate);
};

const collectTopDrivers = (segment, limit = 3) => {
  const drivers = Array.isArray(segment?.top_drivers)
    ? segment.top_drivers
    : Array.isArray(segment?.drivers)
      ? segment.drivers
      : [];
  return drivers
    .map((driver) => driver?.parameter || driver?.name || driver?.field || driver)
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
};

const buildFdrAnomalyRows = (segments = []) =>
  segments.slice(0, 10).map((segment, index) => {
    const severity =
      segment?.severity || segment?.severity_label || segment?.severityLabel || '—';
    const start = segment?.start_time ?? segment?.startTime ?? '—';
    const end = segment?.end_time ?? segment?.endTime ?? '—';
    const timeWindow = start !== end ? `${start}–${end}` : `${start}`;
    const drivers = collectTopDrivers(segment);
    const interpretation = drivers
      ? `Top drivers: ${drivers}`
      : 'Review for contributing parameters.';

    return [
      severity,
      timeWindow,
      drivers || '—',
      `Segment ${index + 1}. ${interpretation}`,
    ];
  });

const buildReportData = async ({
  caseData,
  selectedSections,
  fdrRun,
  notes,
  generatedAt,
  fdrReportData,
}) => {
  const caseNumber = caseData?.caseNumber || caseData?.case_number || '—';
  const title = caseData?.caseName || 'Investigation Report';
  const attachments = Array.isArray(caseData?.attachments)
    ? caseData.attachments.filter(Boolean)
    : [];
  const investigatorSummary = normalizeString(
    caseData?.investigatorSummary || caseData?.investigator_summary,
  );
  const analysisOutput = fdrRun?.output || {};
  const analysisSummary = fdrRun?.summary || analysisOutput?.summary || {};
  const segments = Array.isArray(analysisOutput?.segments) ? analysisOutput.segments : [];
  const cvrPipeline = caseData?.analyses?.cvr?.pipeline || {};
  const cvrSteps = cvrPipeline?.steps || {};

  const cvr = {
    runId: cvrPipeline?.runId || null,
    events: cvrSteps?.events || null,
    denoise: cvrSteps?.denoise || null,
    transcription: cvrSteps?.transcription || null,
    roles: cvrSteps?.roles || null,
    emotion: cvrSteps?.emotion || null,
  };

  let fdrWizardReport = null;
  if (fdrReportData) {
    const fdrCorrections = caseData?.caseNumber
      ? await getFdrCorrections(caseData.caseNumber)
      : [];
    fdrWizardReport = {
      ...fdrReportData,
      corrections: Array.isArray(fdrCorrections) ? fdrCorrections : [],
    };
  }

  return {
    caseData,
    caseNumber,
    title,
    generatedAt,
    generatedLabel: formatDisplayDateTime(generatedAt),
    selectedSections: Array.isArray(selectedSections) ? selectedSections : [],
    investigatorSummary,
    caseSummary: {
      module: caseData?.module || '—',
      status: caseData?.computedStatusLabel || caseData?.status || '—',
      lead: caseData?.owner || caseData?.examiner || '—',
      organization: caseData?.organization || '—',
      location: caseData?.location || '—',
      occurrenceDate:
        caseData?.occurrenceDate || caseData?.occurrence_date || caseData?.date || '—',
      aircraftType: caseData?.aircraftType || caseData?.aircraft_type || '—',
    },
    fdr: fdrRun
      ? {
          run: fdrRun,
          summary: analysisSummary,
          segments,
          anomalyRows: buildFdrAnomalyRows(segments),
        }
      : null,
    cvr,
    cvrSummary: normalizeString(caseData?.analyses?.cvr?.summary),
    correlationSummary: normalizeString(caseData?.analyses?.correlate?.summary),
    notes: Array.isArray(notes) ? notes : [],
    attachments,
    fdrWizardReport,
  };
};

const generateReportPdf = async (reportData) => {
  const {
    caseNumber,
    title,
    generatedLabel,
    generatedAt,
    exportedAt,
    createdAt,
    caseSummary,
    selectedSections,
    fdr,
    cvr,
    cvrSummary,
    correlationSummary,
    notes,
    attachments,
    investigatorSummary,
    fdrWizardReport,
  } = reportData;
  const resolvedGeneratedAt = generatedAt ?? exportedAt ?? createdAt ?? new Date();
  const resolvedGeneratedLabel =
    generatedLabel || formatDisplayDateTime(resolvedGeneratedAt);

  const fdrRun = fdr?.run || null;
  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    bufferPages: true,
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const pageWidth = doc.page.width;
  const margins = doc.page.margins;
  const contentWidth = pageWidth - margins.left - margins.right;

  const ensureSpace = (height) => {
    if (doc.y + height > doc.page.height - margins.bottom - 40) {
      doc.addPage();
    }
  };

  const resetToFullWidth = () => {
    doc.x = margins.left;
  };

  const writeFullWidthText = (text, options = {}) => {
    resetToFullWidth();
    doc.text(text, margins.left, doc.y, {
      width: contentWidth,
      ...options,
    });
    resetToFullWidth();
  };

  const forceWrapLongTokens = (value, chunkSize = 28) =>
    String(value || '').replace(new RegExp(`\\S{${chunkSize + 1},}`, 'g'), (token) =>
      token.match(new RegExp(`.{1,${chunkSize}}`, 'g')).join('\u200B'),
    );

  const sectionTitle = (label) => {
    ensureSpace(28);
    resetToFullWidth();
    doc
      .moveDown(0.6)
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111827')
      .text(label, margins.left, doc.y, { align: 'left', width: contentWidth })
      .moveDown(0.35);
    resetToFullWidth();
  };

  const addKeyValueRow = (label, value) => {
    ensureSpace(18);
    resetToFullWidth();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#374151')
      .text(label, margins.left, doc.y, { width: 140 });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#111827')
      .text(forceWrapLongTokens(value || '—'), margins.left + 150, doc.y - 12, {
        width: contentWidth - 150,
      });
    doc.moveDown(0.4);
    resetToFullWidth();
  };

  const drawKeyAnomaliesTable = (rows) => {
    const columnWidths = [
      60,
      100,
      190,
      Math.max(contentWidth - 350, 120),
    ];
    const headers = ['Severity', 'Time window', 'Key parameters', 'Interpretation'];
    const padding = 6;
    const maxY = doc.page.height - margins.bottom - 24;

    const measureRowHeight = (row, font, fontSize) => {
      doc.font(font).fontSize(fontSize);
      const heights = row.map((cell, index) =>
        doc.heightOfString(String(cell || '—'), {
          width: columnWidths[index] - padding * 2,
        }),
      );
      return Math.max(...heights, 0) + padding * 2;
    };

    const drawHeader = () => {
      const headerHeight = measureRowHeight(headers, 'Helvetica-Bold', 9);
      if (doc.y + headerHeight > maxY) {
        doc.addPage();
      }
      const startY = doc.y;
      let x = margins.left;
      headers.forEach((header, index) => {
        const width = columnWidths[index];
        doc.rect(x, startY, width, headerHeight).fillAndStroke('#F3F4F6', '#E5E7EB');
        doc
          .fillColor('#111827')
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(header, x + padding, startY + padding, { width: width - padding * 2 });
        x += width;
      });
      doc.y = startY + headerHeight;
    };

    drawHeader();
    rows.forEach((row) => {
      const rowHeight = measureRowHeight(row, 'Helvetica', 9);
      if (doc.y + rowHeight > maxY) {
        doc.addPage();
        drawHeader();
      }
      const startY = doc.y;
      let x = margins.left;
      row.forEach((cell, index) => {
        const width = columnWidths[index];
        doc.rect(x, startY, width, rowHeight).stroke('#E5E7EB');
        doc
          .fillColor('#111827')
          .font('Helvetica')
          .fontSize(9)
          .text(cell || '—', x + padding, startY + padding, { width: width - padding * 2 });
        x += width;
      });
      doc.y = startY + rowHeight;
    });
  };

  const drawTable = (headers, columnWidths, rows) => {
    const padding = 6;
    const maxY = doc.page.height - margins.bottom - 24;

    const measureRowHeight = (row, font, fontSize) => {
      doc.font(font).fontSize(fontSize);
      const heights = row.map((cell, index) =>
        doc.heightOfString(String(cell ?? '—'), {
          width: columnWidths[index] - padding * 2,
        }),
      );
      return Math.max(...heights, 0) + padding * 2;
    };

    const drawHeader = () => {
      const headerHeight = measureRowHeight(headers, 'Helvetica-Bold', 9);
      if (doc.y + headerHeight > maxY) {
        doc.addPage();
      }
      const startY = doc.y;
      let x = margins.left;
      headers.forEach((header, index) => {
        const width = columnWidths[index];
        doc.rect(x, startY, width, headerHeight).fillAndStroke('#F3F4F6', '#E5E7EB');
        doc
          .fillColor('#111827')
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(header, x + padding, startY + padding, { width: width - padding * 2 });
        x += width;
      });
      doc.y = startY + headerHeight;
    };

    drawHeader();
    rows.forEach((row) => {
      const rowHeight = measureRowHeight(row, 'Helvetica', 9);
      if (doc.y + rowHeight > maxY) {
        doc.addPage();
        drawHeader();
      }
      const startY = doc.y;
      let x = margins.left;
      row.forEach((cell, index) => {
        const width = columnWidths[index];
        doc.rect(x, startY, width, rowHeight).stroke('#E5E7EB');
        doc
          .fillColor('#111827')
          .font('Helvetica')
          .fontSize(9)
          .text(cell ?? '—', x + padding, startY + padding, { width: width - padding * 2 });
        x += width;
      });
      doc.y = startY + rowHeight;
    });
  };

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text('Investigation Report');
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#6B7280')
    .text(`${caseNumber} · ${title}`)
    .text(`Generated ${resolvedGeneratedLabel}`)
    .moveDown(0.8);

  doc
    .moveTo(margins.left, doc.y)
    .lineTo(pageWidth - margins.right, doc.y)
    .strokeColor('#E5E7EB')
    .stroke();

  sectionTitle('Case Summary');
  addKeyValueRow('Case number', caseNumber);
  addKeyValueRow('Case title', title);
  addKeyValueRow('Module', caseSummary.module);
  addKeyValueRow('Status', caseSummary.status);
  addKeyValueRow('Lead investigator', caseSummary.lead);
  addKeyValueRow('Organization', caseSummary.organization);
  addKeyValueRow('Location', caseSummary.location);
  addKeyValueRow('Occurrence date', caseSummary.occurrenceDate);
  addKeyValueRow('Aircraft type', caseSummary.aircraftType);

  if (investigatorSummary) {
    sectionTitle('Investigator Summary');
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(investigatorSummary);
  }

  if (fdrWizardReport) {
    const { flightSummary, anomalySummary, topFindings, phaseBreakdown, corrections } = fdrWizardReport;

    sectionTitle('FDR Analysis Report');

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Case Details');
    doc.font('Helvetica').fontSize(10).moveDown(0.2);
    addKeyValueRow('Investigator', caseSummary.lead);
    addKeyValueRow('Aircraft type', caseSummary.aircraftType);
    addKeyValueRow('Occurrence date', caseSummary.occurrenceDate);
    addKeyValueRow('Location', caseSummary.location);

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Flight Summary');
    doc.font('Helvetica').fontSize(10).moveDown(0.2);
    addKeyValueRow('Duration', flightSummary?.durationLabel || '—');
    addKeyValueRow('Max altitude', flightSummary?.maxAltitudeLabel || '—');
    addKeyValueRow(
      'Phases detected',
      Array.isArray(flightSummary?.phasesDetected) && flightSummary.phasesDetected.length
        ? flightSummary.phasesDetected.join(', ')
        : '—',
    );

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Anomaly Summary');
    doc.font('Helvetica').fontSize(10).moveDown(0.2);
    addKeyValueRow('Total findings', anomalySummary?.total ?? 0);
    addKeyValueRow('High severity', anomalySummary?.high ?? 0);
    addKeyValueRow('Medium severity', anomalySummary?.med ?? 0);
    addKeyValueRow('Low severity', anomalySummary?.low ?? 0);

    if (Array.isArray(topFindings) && topFindings.length > 0) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Top 5 Findings');
      doc.moveDown(0.3);
      drawTable(
        ['Parameter', 'Deviation', 'Phase', 'Type'],
        [140, 130, 110, Math.max(contentWidth - 380, 100)],
        topFindings.map((f) => [f.parameter, f.deviation, f.phase, f.type]),
      );
    }

    if (Array.isArray(phaseBreakdown) && phaseBreakdown.length > 0) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Phase Breakdown');
      doc.moveDown(0.3);
      drawTable(
        ['Phase', 'Rows', 'Segments', 'Worst severity'],
        [140, 100, 100, Math.max(contentWidth - 340, 100)],
        phaseBreakdown.map((row) => [
          row.phase,
          row.n_rows ?? '—',
          row.segments_found ?? 0,
          row.worst_severity ?? '—',
        ]),
      );
    }

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Investigator Corrections Log');
    doc.moveDown(0.3);
    if (Array.isArray(corrections) && corrections.length > 0) {
      doc.font('Helvetica').fontSize(9).fillColor('#111827');
      corrections.forEach((correction) => {
        writeFullWidthText(
          `${String(correction.type || '').replace(/_/g, ' ')} — ${correction.investigator || 'investigator'} (${formatDisplayDateTime(correction.timestamp)})`,
        );
      });
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#6B7280').text('No corrections logged.');
    }

    doc.moveDown(0.8);
    doc
      .moveTo(margins.left, doc.y)
      .lineTo(pageWidth - margins.right, doc.y)
      .strokeColor('#E5E7EB')
      .stroke();
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(`Generated: ${resolvedGeneratedLabel}`);
    doc.moveDown(1.2);
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text('Investigator Signature: ______________________');
  }

  if (selectedSections.includes('fdr') && fdrRun && !fdrWizardReport) {
    const analysisSummary = fdr?.summary || {};
    const segments = Array.isArray(fdr?.segments) ? fdr.segments : [];

    sectionTitle('FDR Analysis Results');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#111827')
      .text(
        `Latest run ${fdrRun.runId ? `(${fdrRun.runId})` : ''} generated ${formatDisplayDateTime(
          fdrRun.createdAt,
        )}.`,
      )
      .moveDown(0.4);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Run summary');
    doc.font('Helvetica').fontSize(10).fillColor('#111827').moveDown(0.2);
    addKeyValueRow('Segments found', analysisSummary?.segments_found ?? '—');
    addKeyValueRow('Flagged rows', analysisSummary?.flagged_rows ?? '—');
    addKeyValueRow('Flagged percent', analysisSummary?.flagged_percent ?? '—');
    addKeyValueRow('Rows reviewed', analysisSummary?.total_rows_reviewed ?? '—');

    if (segments.length > 0) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Key anomalies');
      doc.moveDown(0.4);
      drawKeyAnomaliesTable(buildFdrAnomalyRows(segments));
    }
  }

  if (selectedSections.includes('cvr') && (cvrSummary || cvr)) {
    sectionTitle('CVR Analysis');
    if (cvr?.runId) {
      addKeyValueRow('CVR run ID', cvr.runId);
    }
    if (cvrSummary) {
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(cvrSummary).moveDown(0.4);
    }

    const cvrSubheading = (label) => {
      ensureSpace(24);
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(label);
      doc.moveDown(0.2);
    };

    const eventStep = cvr?.events;
    cvrSubheading('Event Detection');
    const events = Array.isArray(eventStep?.output?.events) ? eventStep.output.events : [];
    if (events.length > 0) {
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Detected ${events.length} event(s).`);
      const topEvents = events.slice(0, 10);
      topEvents.forEach((event, index) => {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#111827')
          .text(`${index + 1}. ${toEventTimestamp(event)}  |  ${toEventLabel(event, index)}`);
      });
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#4B5563')
        .text(`Output not generated. ${extractStepFailureReason(eventStep)}`);
    }

    const denoiseStep = cvr?.denoise;
    cvrSubheading('Denoise');
    if (denoiseStep?.output) {
      const audioStoragePath =
        formatStorageReference(denoiseStep.output?.artifacts?.audioWav?.storage) ||
        formatStorageReference(denoiseStep.output?.storage) ||
        normalizeString(denoiseStep.output?.outputId) ||
        '—';
      const duration = formatDurationSeconds(denoiseStep.output?.summaryStats?.outputDurationSeconds);
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text('Denoised audio generated.');
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Artifact: ${audioStoragePath}`);
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Duration: ${duration}`);
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#4B5563')
        .text(`Output not generated. ${extractStepFailureReason(denoiseStep)}`);
    }

    const transcriptionStep = cvr?.transcription;
    cvrSubheading('Transcription');
    if (transcriptionStep?.output) {
      const excerptLines = buildTranscriptExcerpt(transcriptionStep.output?.transcriptText, 4);
      const transcriptPath =
        formatStorageReference(transcriptionStep.output?.artifacts?.transcriptText?.storage) ||
        formatStorageReference(transcriptionStep.output?.storage) ||
        '—';
      if (excerptLines.length > 0) {
        writeFullWidthText('Excerpt:');
        excerptLines.forEach((line) => {
          doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#111827');
          writeFullWidthText(`• ${forceWrapLongTokens(line)}`);
        });
      } else {
        doc.font('Helvetica').fontSize(10).fillColor('#4B5563');
        writeFullWidthText('Excerpt not available.');
      }
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      writeFullWidthText(`Full transcript artifact: ${forceWrapLongTokens(transcriptPath)}`);
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#4B5563')
        .text(`Output not generated. ${extractStepFailureReason(transcriptionStep)}`);
    }

    const rolesStep = cvr?.roles;
    cvrSubheading('Speaker Identification');
    const speakerRoles = rolesStep?.output?.speakerRoles;
    if (speakerRoles && typeof speakerRoles === 'object' && Object.keys(speakerRoles).length > 0) {
      Object.entries(speakerRoles).forEach(([speaker, role]) => {
        doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`• ${speaker}: ${role || 'Unknown role'}`);
      });
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#4B5563')
        .text(`Output not generated. ${extractStepFailureReason(rolesStep)}`);
    }

    const emotionStep = cvr?.emotion;
    cvrSubheading('Emotion Recognition');
    const emotionSummary = extractEmotionSummary(emotionStep);
    if (emotionSummary.length > 0) {
      emotionSummary.forEach((line) => {
        doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`• ${line}`);
      });
    } else if (normalizeString(emotionStep?.status).toLowerCase() === 'unavailable') {
      doc.font('Helvetica').fontSize(10).fillColor('#4B5563').text('Not available in this build.');
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#4B5563')
        .text(`Output not generated. ${extractStepFailureReason(emotionStep)}`);
    }
  }

  if (selectedSections.includes('correlation') && correlationSummary) {
    sectionTitle('Correlation Summary');
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(correlationSummary);
  }

  if (selectedSections.includes('notes') && Array.isArray(notes) && notes.length > 0) {
    sectionTitle('Investigator Notes');
    notes.forEach((note) => {
      const author =
        `${note.author?.firstName || ''} ${note.author?.lastName || ''}`.trim() ||
        note.author?.email ||
        'Unknown';
      const timestamp = formatDisplayDateTime(note.createdAt);
      const content = normalizeString(note.content).replace(/\s+/g, ' ');
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#111827')
        .text(`${timestamp} · ${author}`);
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(content || '—');
      doc.moveDown(0.4);
    });
  }

  if (attachments.length > 0) {
    sectionTitle('Attachments');
    attachments.slice(0, 12).forEach((attachment) => {
      const name = normalizeString(attachment?.name) || 'Attachment';
      const type = normalizeString(attachment?.type) || 'File';
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(`${name} (${type})`);
    });
  }

  const generatedStamp = formatDisplayDateTime(resolvedGeneratedAt);
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280');
    const footerY = doc.page.height - margins.bottom + 12;
    doc.text(`CVR/FDR Analyzer — Generated ${generatedStamp}`, margins.left, footerY, {
      align: 'left',
      width: contentWidth / 2,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, margins.left, footerY, {
      align: 'right',
      width: contentWidth,
    });
  }

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};

const generateReportDocx = async (reportData) => {
  const {
    caseNumber,
    title,
    generatedLabel,
    caseSummary,
    investigatorSummary,
    selectedSections,
    fdr,
    cvr,
    cvrSummary,
    correlationSummary,
    notes,
    attachments,
  } = reportData;

  const children = [];
  const addHeading = (text, level = HeadingLevel.HEADING_1) => {
    children.push(new Paragraph({ text, heading: level }));
  };
  const addKeyValue = (label, value) => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${label}: `, bold: true }),
          new TextRun(String(value || '—')),
        ],
      }),
    );
  };

  children.push(new Paragraph({ text: 'Investigation Report', heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ text: `${caseNumber} · ${title}` }));
  children.push(new Paragraph({ text: `Generated ${generatedLabel}` }));
  children.push(new Paragraph({ text: '' }));

  addHeading('Case Summary');
  addKeyValue('Case number', caseNumber);
  addKeyValue('Case title', title);
  addKeyValue('Module', caseSummary.module);
  addKeyValue('Status', caseSummary.status);
  addKeyValue('Lead investigator', caseSummary.lead);
  addKeyValue('Organization', caseSummary.organization);
  addKeyValue('Location', caseSummary.location);
  addKeyValue('Occurrence date', caseSummary.occurrenceDate);
  addKeyValue('Aircraft type', caseSummary.aircraftType);

  if (investigatorSummary) {
    addHeading('Investigator Summary');
    children.push(new Paragraph({ text: investigatorSummary }));
  }

  if (selectedSections.includes('fdr') && fdr) {
    addHeading('FDR Analysis Results');
    if (fdr.run?.createdAt) {
      children.push(
        new Paragraph({
          text: `Latest run ${fdr.run?.runId ? `(${fdr.run.runId})` : ''} generated ${formatDisplayDateTime(
            fdr.run.createdAt,
          )}.`,
        }),
      );
    }
    addHeading('Run summary', HeadingLevel.HEADING_2);
    addKeyValue('Segments found', fdr.summary?.segments_found ?? '—');
    addKeyValue('Flagged rows', fdr.summary?.flagged_rows ?? '—');
    addKeyValue('Flagged percent', fdr.summary?.flagged_percent ?? '—');
    addKeyValue('Rows reviewed', fdr.summary?.total_rows_reviewed ?? '—');

    if (fdr.anomalyRows?.length) {
      addHeading('Key anomalies', HeadingLevel.HEADING_2);
      const columnWidths = [900, 1500, 3000, 3600];
      const tableRows = [
        new TableRow({
          children: ['Severity', 'Time window', 'Key parameters', 'Interpretation'].map(
            (header, index) =>
              new TableCell({
                width: { size: columnWidths[index], type: WidthType.DXA },
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: header, bold: true })],
                  }),
                ],
              }),
          ),
        }),
        ...fdr.anomalyRows.map((row) =>
          new TableRow({
            children: row.map(
              (cell, index) =>
                new TableCell({
                  width: { size: columnWidths[index], type: WidthType.DXA },
                  children: [new Paragraph(String(cell || '—'))],
                }),
            ),
          }),
        ),
      ];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));
    }
  }

  if (selectedSections.includes('cvr') && (cvrSummary || cvr)) {
    addHeading('CVR Analysis');
    if (cvr?.runId) {
      addKeyValue('CVR run ID', cvr.runId);
    }
    if (cvrSummary) {
      children.push(new Paragraph({ text: cvrSummary }));
    }

    addHeading('Event Detection', HeadingLevel.HEADING_2);
    const events = Array.isArray(cvr?.events?.output?.events) ? cvr.events.output.events : [];
    if (events.length > 0) {
      children.push(new Paragraph({ text: `Detected ${events.length} event(s).` }));
      events.slice(0, 10).forEach((event, index) => {
        children.push(
          new Paragraph({
            text: `${index + 1}. ${toEventTimestamp(event)} | ${toEventLabel(event, index)}`,
            bullet: { level: 0 },
          }),
        );
      });
    } else {
      children.push(
        new Paragraph({ text: `Output not generated. ${extractStepFailureReason(cvr?.events)}` }),
      );
    }

    addHeading('Denoise', HeadingLevel.HEADING_2);
    if (cvr?.denoise?.output) {
      const denoisePath =
        formatStorageReference(cvr.denoise.output?.artifacts?.audioWav?.storage) ||
        formatStorageReference(cvr.denoise.output?.storage) ||
        normalizeString(cvr.denoise.output?.outputId) ||
        '—';
      children.push(new Paragraph({ text: 'Denoised audio generated.' }));
      children.push(new Paragraph({ text: `Artifact: ${denoisePath}` }));
      children.push(
        new Paragraph({
          text: `Duration: ${formatDurationSeconds(cvr.denoise.output?.summaryStats?.outputDurationSeconds)}`,
        }),
      );
    } else {
      children.push(
        new Paragraph({ text: `Output not generated. ${extractStepFailureReason(cvr?.denoise)}` }),
      );
    }

    addHeading('Transcription', HeadingLevel.HEADING_2);
    if (cvr?.transcription?.output) {
      const excerptLines = buildTranscriptExcerpt(cvr.transcription.output?.transcriptText, 4);
      if (excerptLines.length > 0) {
        children.push(new Paragraph({ text: 'Excerpt:' }));
        excerptLines.forEach((line) => {
          children.push(new Paragraph({ text: line, bullet: { level: 0 } }));
        });
      } else {
        children.push(new Paragraph({ text: 'Excerpt not available.' }));
      }
      const transcriptPath =
        formatStorageReference(cvr.transcription.output?.artifacts?.transcriptText?.storage) ||
        formatStorageReference(cvr.transcription.output?.storage) ||
        '—';
      children.push(new Paragraph({ text: `Full transcript artifact: ${transcriptPath}` }));
    } else {
      children.push(
        new Paragraph({ text: `Output not generated. ${extractStepFailureReason(cvr?.transcription)}` }),
      );
    }

    addHeading('Speaker Identification', HeadingLevel.HEADING_2);
    const speakerRoles = cvr?.roles?.output?.speakerRoles;
    if (speakerRoles && typeof speakerRoles === 'object' && Object.keys(speakerRoles).length > 0) {
      Object.entries(speakerRoles).forEach(([speaker, role]) => {
        children.push(new Paragraph({ text: `${speaker}: ${role || 'Unknown role'}`, bullet: { level: 0 } }));
      });
    } else {
      children.push(
        new Paragraph({ text: `Output not generated. ${extractStepFailureReason(cvr?.roles)}` }),
      );
    }

    addHeading('Emotion Recognition', HeadingLevel.HEADING_2);
    const emotionSummary = extractEmotionSummary(cvr?.emotion);
    if (emotionSummary.length > 0) {
      emotionSummary.forEach((line) => {
        children.push(new Paragraph({ text: line, bullet: { level: 0 } }));
      });
    } else if (normalizeString(cvr?.emotion?.status).toLowerCase() === 'unavailable') {
      children.push(new Paragraph({ text: 'Not available in this build.' }));
    } else {
      children.push(
        new Paragraph({ text: `Output not generated. ${extractStepFailureReason(cvr?.emotion)}` }),
      );
    }
  }

  if (selectedSections.includes('correlation') && correlationSummary) {
    addHeading('Correlation Summary');
    children.push(new Paragraph({ text: correlationSummary }));
  }

  if (selectedSections.includes('notes') && notes.length > 0) {
    addHeading('Investigator Notes');
    notes.forEach((note) => {
      const author =
        `${note.author?.firstName || ''} ${note.author?.lastName || ''}`.trim() ||
        note.author?.email ||
        'Unknown';
      const timestamp = formatDisplayDateTime(note.createdAt);
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `${timestamp} · ${author}`, bold: true })],
        }),
      );
      children.push(new Paragraph({ text: normalizeString(note.content) || '—' }));
    });
  }

  if (attachments.length > 0) {
    addHeading('Attachments');
    attachments.slice(0, 12).forEach((attachment) => {
      const name = normalizeString(attachment?.name) || 'Attachment';
      const type = normalizeString(attachment?.type) || 'File';
      children.push(
        new Paragraph({
          text: `${name} (${type})`,
          bullet: { level: 0 },
        }),
      );
    });
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
};

const resolveReportSections = (selectedSections, availability) => {
  const allowed = new Set(['fdr', 'cvr', 'correlation', 'notes']);
  const normalizedSelections = (Array.isArray(selectedSections) ? selectedSections : [])
    .map((section) => normalizeString(section).toLowerCase())
    .filter((section) => allowed.has(section));

  const supported = new Map([
    ['fdr', availability?.has_fdr_results],
    ['cvr', availability?.has_cvr_results],
    ['correlation', availability?.has_correlation_results],
    ['notes', (availability?.notes_count || 0) > 0],
  ]);

  return normalizedSelections.filter((section) => supported.get(section));
};

const buildReportPayload = async ({ caseData, selectedSections, fdrRunId }) => {
  const availability = await getReportAvailability(caseData);
  const resolvedSections = resolveReportSections(selectedSections, availability);

  let fdrRun = null;
  if (resolvedSections.includes('fdr')) {
    if (fdrRunId) {
      fdrRun = await getFdrAnalysisRunById(caseData.id, fdrRunId);
    }
    if (!fdrRun) {
      fdrRun = await getLatestFdrAnalysisRun(caseData.id);
    }
    if (!fdrRun && caseData?.fdrAnalysis) {
      fdrRun = {
        runId: caseData?.fdrLastRunId || caseData?.fdrLatestRunId || null,
        createdAt: caseData?.fdrLastRunAt || caseData?.fdrAnalysisUpdatedAt || null,
        output: caseData.fdrAnalysis,
        summary: caseData?.fdrAnalysis?.summary || {},
      };
    }
  }

  let notes = [];
  if (resolvedSections.includes('notes') && caseData.id) {
    const generalNotes = await listNotesByCaseId(caseData.id, {
      module: 'GENERAL',
      relatedRunId: null,
    });
    const fdrNotes = await listNotesByCaseId(caseData.id, {
      module: 'FDR',
    });
    notes = [...generalNotes, ...fdrNotes].sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  return {
    availability,
    resolvedSections,
    fdrRun,
    notes,
  };
};

module.exports = {
  buildAvailability,
  buildReportData,
  buildReportPayload,
  formatFileTimestamp,
  generateReportDocx,
  generateReportPdf,
  getReportAvailability,
  resolveReportSections,
};
