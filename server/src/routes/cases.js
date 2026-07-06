const express = require('express');
const crypto = require('crypto');
const { detectEmotionForCase } = require('../services/emotion');
const {
  listCases,
  findCaseByNumber,
  createCase,
  updateCase,
  updateCaseInvestigatorSummary,
  deleteCase,
  updateCaseCvrPipeline,
} = require('../services/cases');
const {
  createReportExport,
  getCaseIdByNumber,
  listReportExportsByCaseId,
  findReportExportById,
  deleteReportExportById,
} = require('../services/report-exports');
const {
  buildReportData,
  buildReportPayload,
  formatFileTimestamp,
  generateReportDocx,
  generateReportPdf,
  getReportAvailability,
} = require('../services/reporting');
const { uploadReportBuffer, deleteObject } = require('../services/storage');
const {
  listNotesByCaseId,
  findNoteById,
  createNote,
  updateNote,
  deleteNote,
} = require('../services/notes');
const { analyzeFdrForCase, segmentFlightsForCase, detectPhasesForCase, detectRulesForCase } = require('../services/anomaly');
const { getFdrOccurrence, setFdrOccurrence, getFdrCorrections, addFdrCorrection, deleteFdrCorrection } = require('../services/cases');
const {
  denoiseCvrForCase,
  resolveDenoiseOutputPath,
  transcribeCvrForCase,
  identifyCvrRolesForCase,
  detectCvrEventsForCase,
  deleteDenoiseOutputForCase,
} = require('../services/cvr');
const { validateCasePayload } = require('../utils/validate-case');

const router = express.Router();
const MAX_NOTE_LENGTH = 10000;
const allowedNoteModules = new Map([
  ['fdr', 'FDR'],
  ['cvr', 'CVR'],
  ['correlation', 'Correlation'],
  ['general', 'General'],
]);

const normalizeNoteModule = (moduleValue) => {
  if (!moduleValue) {
    return 'General';
  }

  const normalized = String(moduleValue).trim().toLowerCase();
  return allowedNoteModules.get(normalized) || null;
};

const isNoteAuthor = (noteAuthor = {}, user = {}) => {
  if (!noteAuthor || !user) {
    return false;
  }

  if (noteAuthor.id && user.id) {
    return noteAuthor.id === user.id;
  }

  if (noteAuthor.email && user.email) {
    return noteAuthor.email === user.email;
  }

  return false;
};

router.get('/', async (req, res, next) => {
  try {
    const { page, pageSize } = req.query;
    const data = await listCases({ page, pageSize });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/fdr/analyze', async (req, res, next) => {
  try {
    const result = await analyzeFdrForCase(req.params.caseNumber, { user: req.user });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/fdr/segments', async (req, res, next) => {
  try {
    const result = await segmentFlightsForCase(req.params.caseNumber);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/fdr/phases', async (req, res, next) => {
  try {
    const result = await detectPhasesForCase(req.params.caseNumber);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/fdr/rules', async (req, res, next) => {
  try {
    const result = await detectRulesForCase(req.params.caseNumber);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/fdr/occurrence', async (req, res, next) => {
  try {
    const result = await getFdrOccurrence(req.params.caseNumber);
    if (result === null) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch('/:caseNumber/fdr/occurrence', async (req, res, next) => {
  try {
    const { start, end, label } = req.body || {};
    const result = await setFdrOccurrence(req.params.caseNumber, {
      start: start == null ? null : Number(start),
      end: end == null ? null : Number(end),
      label: label == null ? null : String(label),
    });
    if (result === null) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/fdr/corrections', async (req, res, next) => {
  try {
    const result = await getFdrCorrections(req.params.caseNumber);
    if (result === null) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/fdr/corrections', async (req, res, next) => {
  try {
    const correction = req.body || {};
    const note = typeof correction.note === 'string' ? correction.note.trim() : '';
    if (note.length < 10) {
      return res.status(400).json({ error: 'Note must be at least 10 characters.' });
    }
    const entry = {
      id: correction.id || crypto.randomUUID(),
      type: correction.type || 'false_positive',
      target_id: String(correction.target_id ?? ''),
      original_value: correction.original_value ?? {},
      corrected_value: correction.corrected_value ?? {},
      investigator: String(correction.investigator ?? 'investigator'),
      timestamp: correction.timestamp || new Date().toISOString(),
      note,
    };
    const result = await addFdrCorrection(req.params.caseNumber, entry);
    if (result === null) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:caseNumber/fdr/corrections/:correctionId', async (req, res, next) => {
  try {
    const result = await deleteFdrCorrection(req.params.caseNumber, req.params.correctionId);
    if (result === null) {
      return res.status(404).json({ error: 'Case not found' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/cvr/denoise', async (req, res, next) => {
  try {
    const result = await denoiseCvrForCase(req.params.caseNumber, { ...(req.body || {}), user: req.user });
    res.json({
      ...result,
      pipeline: {
        steps: {
          denoise: {
            status: 'completed',
            output: result,
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/cvr/transcription', async (req, res, next) => {
  try {
    const result = await transcribeCvrForCase(req.params.caseNumber, { ...(req.body || {}), user: req.user });
    res.json({
      ...result,
      pipeline: {
        steps: {
          transcription: {
            status: 'completed',
            output: result,
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/cvr/denoise/:outputId', async (req, res, next) => {
  try {
    const outputPath = await resolveDenoiseOutputPath(req.params.caseNumber, req.params.outputId);
    res.type('audio/wav');
    res.sendFile(outputPath);
  } catch (error) {
    next(error);
  }
});

router.delete('/:caseNumber/cvr/denoise/:outputId', async (req, res, next) => {
  try {
    const result = await deleteDenoiseOutputForCase(req.params.caseNumber, req.params.outputId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/report-exports', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const limit = Number.parseInt(req.query.limit, 10);
    const exportsList = await listReportExportsByCaseId(caseId, limit);
    res.json(exportsList);
  } catch (error) {
    next(error);
  }
});


router.delete('/:caseNumber/report-exports/:reportId', async (req, res, next) => {
  try {
    const caseData = await findCaseByNumber(req.params.caseNumber);
    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const exportRecord = await findReportExportById({
      caseId: caseData.id,
      exportId: req.params.reportId,
    });

    if (!exportRecord) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    await deleteObject({
      bucket: exportRecord.storageBucket,
      objectKey: exportRecord.storagePath,
    });

    await deleteReportExportById({
      caseId: caseData.id,
      exportId: req.params.reportId,
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/report-availability', async (req, res, next) => {
  try {
    const caseData = await findCaseByNumber(req.params.caseNumber);
    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const availability = await getReportAvailability(caseData);
    res.json(availability);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/report-exports', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const payload = req.body || {};
    if (!payload.format || !payload.filename) {
      res.status(400).json({ error: 'format and filename are required.' });
      return;
    }

    const created = await createReportExport({
      caseId,
      createdBy: req.user,
      format: payload.format,
      filename: payload.filename,
      storageBucket: payload.storageBucket,
      storagePath: payload.storagePath,
      storageUrl: payload.storageUrl,
      linkedRunId: payload.linkedRunId,
    });

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/report-exports/generate', async (req, res, next) => {
  try {
    const caseData = await findCaseByNumber(req.params.caseNumber);
    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const payload = req.body || {};
    const selectedSections = Array.isArray(payload.selected_sections)
      ? payload.selected_sections
      : [];
    const format = typeof payload.format === 'string' ? payload.format.toLowerCase() : 'pdf';
    if (format !== 'pdf' && format !== 'docx') {
      res.status(400).json({ error: 'format must be "pdf" or "docx".' });
      return;
    }

    const { resolvedSections, fdrRun, notes } = await buildReportPayload({
      caseData,
      selectedSections,
      fdrRunId: payload.fdr_run_id,
    });

    const generatedAt = new Date().toISOString();
    const extension = format === 'docx' ? 'docx' : 'pdf';
    const fileName = `${caseData.caseNumber}_Report_${formatFileTimestamp(generatedAt)}.${extension}`;
    const reportData = buildReportData({
      caseData,
      selectedSections: resolvedSections,
      fdrRun,
      notes,
      generatedAt,
    });
    const { reportBuffer, contentType, formatLabel } =
      format === 'docx'
        ? {
            reportBuffer: await generateReportDocx(reportData),
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            formatLabel: 'DOCX',
          }
        : {
            reportBuffer: await generateReportPdf(reportData),
            contentType: 'application/pdf',
            formatLabel: 'PDF',
          };

    const storageResult = await uploadReportBuffer({
      caseNumber: caseData.caseNumber,
      fileName,
      contentType,
      body: reportBuffer,
    });

    const exportRecord = await createReportExport({
      caseId: caseData.id,
      createdBy: req.user,
      format: formatLabel,
      filename: fileName,
      storageBucket: storageResult.bucket,
      storagePath: storageResult.objectKey,
      storageUrl: storageResult.storageUrl,
      linkedRunId: fdrRun?.runId || payload.fdr_run_id || null,
    });

    const actorName =
      req.user?.name ||
      `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() ||
      req.user?.email ||
      'System';
    const reportEntry = {
      id: `report-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'report_export',
      action: 'Report exported',
      actor: { name: actorName },
      timestamp: generatedAt,
      metadata: [{ label: 'Format', value: formatLabel }],
      links: {
        download: {
          bucket: storageResult.bucket,
          objectKey: storageResult.objectKey,
          fileName,
          contentType,
        },
      },
    };

    const nextTimeline = [
      ...(Array.isArray(caseData.timeline) ? caseData.timeline : []),
      reportEntry,
    ];
    const nextAttachments = [
      ...(Array.isArray(caseData.attachments) ? caseData.attachments : []),
      {
        type: 'Report',
        name: fileName,
        size: reportBuffer.length,
        uploadedBy: actorName,
        status: 'Uploaded',
        format: formatLabel,
        storage: {
          bucket: storageResult.bucket,
          objectKey: storageResult.objectKey,
        },
        contentType,
        uploadedAt: generatedAt,
        sourceRunId: fdrRun?.runId || null,
      },
    ];

    await updateCase(caseData.caseNumber, {
      ...caseData,
      timeline: nextTimeline,
      attachments: nextAttachments,
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(reportBuffer);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/cvr/roles', async (req, res, next) => {
  try {
    const result = await identifyCvrRolesForCase(req.params.caseNumber, { ...(req.body || {}), user: req.user });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/cvr/events', async (req, res, next) => {
  try {
    const result = await detectCvrEventsForCase(req.params.caseNumber, { ...(req.body || {}), user: req.user });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber/notes', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const moduleFilter = req.query.module ? normalizeNoteModule(req.query.module) : null;
    if (req.query.module && !moduleFilter) {
      res.status(400).json({ error: 'Invalid module.' });
      return;
    }

    const notes = await listNotesByCaseId(caseId, {
      module: moduleFilter || undefined,
    });
    res.json(notes);
  } catch (error) {
    next(error);
  }
});

router.post('/:caseNumber/notes', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const payload = req.body || {};
    const moduleValue = normalizeNoteModule(payload.module);
    if (!moduleValue) {
      res.status(400).json({ error: 'Invalid module.' });
      return;
    }

    const content = String(payload.content || '').trim();
    if (!content) {
      res.status(400).json({ error: 'content is required.' });
      return;
    }
    if (content.length > MAX_NOTE_LENGTH) {
      res.status(400).json({ message: 'Note too long (max 10,000 characters).' });
      return;
    }

    const created = await createNote({
      caseId,
      module: moduleValue,
      relatedRunId: payload.relatedRunId || null,
      author: req.user || {},
      content,
    });

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

router.put('/:caseNumber/notes/:noteId', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const noteId = Number.parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      res.status(400).json({ error: 'Invalid note id.' });
      return;
    }

    const note = await findNoteById(caseId, noteId);
    if (!note) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    if (!isNoteAuthor(note.author, req.user)) {
      res.status(403).json({ error: 'Not authorized to edit this note.' });
      return;
    }

    const content = String(req.body?.content || '').trim();
    if (!content) {
      res.status(400).json({ error: 'content is required.' });
      return;
    }
    if (content.length > MAX_NOTE_LENGTH) {
      res.status(400).json({ message: 'Note too long (max 10,000 characters).' });
      return;
    }

    const updated = await updateNote({ caseId, noteId, content });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:caseNumber/notes/:noteId', async (req, res, next) => {
  try {
    const caseId = await getCaseIdByNumber(req.params.caseNumber);
    if (!caseId) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const noteId = Number.parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      res.status(400).json({ error: 'Invalid note id.' });
      return;
    }

    const note = await findNoteById(caseId, noteId);
    if (!note) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    if (!isNoteAuthor(note.author, req.user)) {
      res.status(403).json({ error: 'Not authorized to delete this note.' });
      return;
    }

    await deleteNote({ caseId, noteId });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.put('/:caseNumber/investigator-summary', async (req, res, next) => {
  try {
    const { investigatorSummary, investigatorSummaryEditedBy, investigatorSummaryEditedAt } = req.body;
    if (
      investigatorSummary !== undefined &&
      investigatorSummary !== null &&
      typeof investigatorSummary !== 'string'
    ) {
      res.status(400).json({ error: 'Investigator summary must be a string.' });
      return;
    }

    if (
      investigatorSummaryEditedBy !== undefined &&
      investigatorSummaryEditedBy !== null &&
      typeof investigatorSummaryEditedBy !== 'object'
    ) {
      res.status(400).json({ error: 'Investigator summary edited by must be an object.' });
      return;
    }

    const updated = await updateCaseInvestigatorSummary(req.params.caseNumber, {
      investigatorSummary: investigatorSummary || '',
      investigatorSummaryEditedBy,
      investigatorSummaryEditedAt,
      lastUpdated: new Date().toISOString(),
    });

    if (!updated) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.put('/:caseNumber/cvr/pipeline', async (req, res, next) => {
  try {
    const updated = await updateCaseCvrPipeline(req.params.caseNumber, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/:caseNumber', async (req, res, next) => {
  try {
    const caseData = await findCaseByNumber(req.params.caseNumber);
    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    res.json(caseData);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = validateCasePayload(req.body);
    const created = await createCase(payload);
    res.status(201).json(created);
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'A case with this case number already exists.';
    }

    next(error);
  }
});

router.put('/:caseNumber', async (req, res, next) => {
  try {
    const payload = validateCasePayload({ ...req.body, caseNumber: req.params.caseNumber });
    const updated = await updateCase(req.params.caseNumber, payload);
    if (!updated) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:caseNumber', async (req, res, next) => {
  try {
    const removed = await deleteCase(req.params.caseNumber);
    if (!removed) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
router.post('/:caseNumber/emotion-analysis', async (req, res, next) => {
  try {
    const caseNumber = String(req.params.caseNumber).replace(/[^\w-]/g, '');
    if (!caseNumber) {
      res.status(400).json({ error: 'Invalid case number.' });
      return;
    }
    const result = await detectEmotionForCase(caseNumber, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
