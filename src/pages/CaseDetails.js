import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Calendar,
  MapPin,
  Plane,
  Tags,
  FileText,
  AudioLines,
  PlaneTakeoff,
  Workflow,
  Clock3,
  Phone,
  Mail,
  ChevronDown,
  ChevronUp,
  Trash2,
} from 'lucide-react';
import { fetchCaseByNumber, updateCase, updateInvestigatorSummary } from '../api/cases';
import { deleteReportExport, fetchReportExports } from '../api/report-exports';
import { createDownloadTarget } from '../api/storage';
import { evaluateModuleReadiness } from '../utils/analysisAvailability';
import { getAnalysisStatusStyles } from '../utils/analysisStatus';
import { CASE_STATUS_STYLES, normalizeCaseRecord, resolveCaseStatusLabel } from '../utils/statuses';
import { FDR_ANALYSIS_STATUSES, normalizeFdrAnalysisStatus } from '../utils/fdrStatus';
import { deleteAttachmentFromObjectStore } from '../utils/storage';
import { computeCvrStatus } from '../utils/cvrAnalysisStatus';
import { resolveActorLabel } from '../utils/timeline';
import NotesPanel from '../components/NotesPanel';
import { useAuth } from '../hooks/useAuth';

const analysisIcon = {
  fdr: PlaneTakeoff,
  cvr: AudioLines,
  correlate: Workflow,
};

const TIMELINE_PAGE_SIZE = 10;
const TIMELINE_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const TIMELINE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'uploads', label: 'Uploads' },
  { key: 'analyses', label: 'Analyses' },
  { key: 'exports', label: 'Exports' },
  { key: 'system', label: 'System' },
];

const CaseDetails = ({ caseNumber: propCaseNumber }) => {
  const { user } = useAuth();
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [pendingDeleteAttachment, setPendingDeleteAttachment] = useState(null);
  const [recentExports, setRecentExports] = useState([]);
  const [recentExportsError, setRecentExportsError] = useState('');
  const [recentExportsLoading, setRecentExportsLoading] = useState(false);
  const [downloadingExportId, setDownloadingExportId] = useState('');
  const [downloadingKey, setDownloadingKey] = useState('');
  const [deletingKey, setDeletingKey] = useState('');
  const [pendingDeleteReport, setPendingDeleteReport] = useState(null);
  const [deletingReportId, setDeletingReportId] = useState('');
  const [timelineFilter, setTimelineFilter] = useState('all');
  const [timelinePage, setTimelinePage] = useState(1);
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState(new Set());
  const [isEditingInvestigatorSummary, setIsEditingInvestigatorSummary] = useState(false);
  const [investigatorSummaryDraft, setInvestigatorSummaryDraft] = useState('');
  const [investigatorSummaryError, setInvestigatorSummaryError] = useState('');
  const [investigatorSummarySaving, setInvestigatorSummarySaving] = useState(false);
  const navigate = useNavigate();
  const { caseNumber: routeCaseNumber } = useParams();
  const caseNumber = propCaseNumber || routeCaseNumber;

  const goBack = () => {
    navigate('/cases');
  };

  useEffect(() => {
    const loadCase = async () => {
      if (!caseNumber) {
        setCaseData(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');
      setDeleteError('');
      setDeletingKey('');

      try {
        const data = await fetchCaseByNumber(caseNumber);
        setCaseData(normalizeCaseRecord(data));
      } catch (err) {
        setError(err.message || 'Unable to load case details');
        setCaseData(null);
      } finally {
        setLoading(false);
      }
    };

    loadCase();
  }, [caseNumber]);

  useEffect(() => {
    if (!caseData) {
      return;
    }
    if (!isEditingInvestigatorSummary) {
      setInvestigatorSummaryDraft(caseData.investigatorSummary || '');
    }
  }, [caseData, isEditingInvestigatorSummary]);

  useEffect(() => {
    setAnalysisError('');
  }, [caseNumber]);

  useEffect(() => {
    if (!caseNumber) {
      setRecentExports([]);
      return;
    }

    let isMounted = true;
    setRecentExportsLoading(true);
    setRecentExportsError('');

    fetchReportExports(caseNumber, { limit: 5 })
      .then((exportsList) => {
        if (!isMounted) {
          return;
        }

        setRecentExports(Array.isArray(exportsList) ? exportsList : []);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }

        setRecentExportsError(err.message || 'Unable to load recent exports.');
      })
      .finally(() => {
        if (isMounted) {
          setRecentExportsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [caseNumber]);

  useEffect(() => {
    setTimelinePage(1);
    setExpandedTimelineGroups(new Set());
  }, [timelineFilter, caseNumber]);

  const handleOpenModule = (moduleKey) => {
    if (!caseData) {
      setAnalysisError('Case details are still loading.');
      return;
    }

    if (moduleKey === 'correlate') {
      setAnalysisError('Correlation module will be available in a future release.');
      return;
    }

    const evaluation = evaluateModuleReadiness(caseData, moduleKey);
    if (!evaluation.ready) {
      setAnalysisError(evaluation.message);
      return;
    }

    setAnalysisError('');
    navigate(`/cases/${caseNumber}/${moduleKey}`);
  };

  const handleViewLatestResults = (moduleKey) => {
    if (!caseData) {
      setAnalysisError('Case details are still loading.');
      return;
    }

    const latestRun = latestRunsByModule[moduleKey];
    if (!latestRun?.resultsUrl) {
      setAnalysisError('No completed analysis run is available yet.');
      return;
    }

    setAnalysisError('');
    navigate(latestRun.resultsUrl);
  };

  const handleUploadData = (moduleKey, missingTypes) => {
    if (!caseNumber) {
      return;
    }

    setAnalysisError('');

    const normalizedMissing = Array.isArray(missingTypes)
      ? missingTypes.map((type) => String(type || '').toLowerCase())
      : [];

    let focusUpload = '';
    const hasFdr = normalizedMissing.includes('fdr');
    const hasCvr = normalizedMissing.includes('cvr');
    if (hasFdr && hasCvr) {
      focusUpload = 'both';
    } else if (hasFdr) {
      focusUpload = 'fdr';
    } else if (hasCvr) {
      focusUpload = 'cvr';
    }

    navigate('/cases', {
      state: {
        editCaseNumber: caseNumber,
        focusUpload,
        attemptedCase: caseNumber,
      },
    });
  };

  const handleDeleteAttachment = async (attachment) => {
    const objectKey = attachment?.storage?.objectKey || attachment?.storage?.key;
    if (!caseData || !objectKey) {
      return;
    }

    setDeleteError('');
    setDeletingKey(objectKey);

    try {
      await deleteAttachmentFromObjectStore({
        bucket: attachment.storage?.bucket,
        objectKey,
      });

      const nextAttachments = (caseData.attachments || []).filter((item) => {
        const key = item?.storage?.objectKey || item?.storage?.key;
        return key !== objectKey;
      });

      const updated = await updateCase(caseNumber, {
        ...caseData,
        attachments: nextAttachments,
      });

      setCaseData(normalizeCaseRecord(updated));
    } catch (err) {
      setDeleteError(err.message || 'Unable to delete attachment from storage.');
    } finally {
      setDeletingKey('');
    }
  };

  const handleRequestDeleteAttachment = (attachment) => {
    setPendingDeleteAttachment(attachment);
    setDeleteModalOpen(true);
  };

  const handleCancelDeleteAttachment = () => {
    setDeleteModalOpen(false);
    setPendingDeleteAttachment(null);
    setPendingDeleteReport(null);
  };

  const handleConfirmDeleteAttachment = async () => {
    if (pendingDeleteReport) {
      await handleConfirmDeleteReport();
      return;
    }

    if (!pendingDeleteAttachment) {
      return;
    }

    await handleDeleteAttachment(pendingDeleteAttachment);
    handleCancelDeleteAttachment();
  };

  const handleEditInvestigatorSummary = () => {
    setInvestigatorSummaryDraft(caseData?.investigatorSummary || '');
    setInvestigatorSummaryError('');
    setIsEditingInvestigatorSummary(true);
  };

  const handleCancelInvestigatorSummary = () => {
    setInvestigatorSummaryDraft(caseData?.investigatorSummary || '');
    setInvestigatorSummaryError('');
    setIsEditingInvestigatorSummary(false);
  };

  const handleSaveInvestigatorSummary = async () => {
    if (!caseData) {
      return;
    }

    setInvestigatorSummarySaving(true);
    setInvestigatorSummaryError('');

    try {
      const updated = await updateInvestigatorSummary(caseNumber, {
        investigatorSummary: investigatorSummaryDraft,
        investigatorSummaryEditedBy: user
          ? {
              id: user.id,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
            }
          : null,
        investigatorSummaryEditedAt: new Date().toISOString(),
      });
      setCaseData(normalizeCaseRecord(updated));
      setIsEditingInvestigatorSummary(false);
    } catch (error) {
      setInvestigatorSummaryError(error.message || 'Unable to update investigator summary.');
    } finally {
      setInvestigatorSummarySaving(false);
    }
  };

  const fdrAnalysisStatus = normalizeFdrAnalysisStatus(caseData?.fdrAnalysisStatus);

  const attachments = useMemo(
    () => (Array.isArray(caseData?.attachments) ? caseData.attachments : []),
    [caseData],
  );
  const caseTimeline = useMemo(
    () => (Array.isArray(caseData?.timeline) ? caseData.timeline : []),
    [caseData],
  );

  const resolveResultsUrl = (moduleKey, runId) => {
    if (!moduleKey) {
      return null;
    }

    if (moduleKey === 'fdr') {
      return runId ? `/cases/${caseNumber}/fdr?runId=${runId}` : `/cases/${caseNumber}/fdr`;
    }

    if (moduleKey === 'cvr') {
      return `/cases/${caseNumber}/cvr`;
    }

    if (moduleKey === 'correlate') {
      return `/cases/${caseNumber}/correlate`;
    }

    return null;
  };

  const formatTimelineTimestamp = (value) => {
    if (!value) {
      return '—';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return typeof value === 'string' ? value : '—';
    }

    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
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

  const isNoteEntry = (entry) => entry?.kind === 'note' || entry?.kind === 'manual_update';

  const isEditableTimelineEntry = (entry) =>
    entry?.kind === 'note' || entry?.kind === 'manual_update';

  const getTimelineCategory = (entry) => {
    if (!entry) {
      return 'system';
    }

    if (entry.kind === 'note' || entry.kind === 'manual_update' || entry.editedAt || entry.editedBy) {
      return 'notes';
    }

    const kindValue = String(entry.kind || '').toLowerCase();
    const actionValue = String(entry.action || '').toLowerCase();
    const eventTypeValue = String(entry.eventType || entry.event_type || '').toLowerCase();

    if (kindValue.includes('upload') || actionValue.includes('uploaded')) {
      return 'uploads';
    }

    if (kindValue.includes('export') || actionValue.includes('export')) {
      return 'exports';
    }

    if (
      eventTypeValue.startsWith('cvr_') ||
      kindValue.includes('cvr') ||
      actionValue.includes('cvr') ||
      kindValue.includes('analysis') ||
      kindValue.includes('detection') ||
      actionValue.includes('analysis') ||
      actionValue.includes('anomaly')
    ) {
      return 'analyses';
    }

    return 'system';
  };

  const resolveTimelineGroupLabel = (value) => {
    if (!value) {
      return 'Unknown date';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown date';
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfEntry = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((startOfToday - startOfEntry) / (1000 * 60 * 60 * 24));

    if (dayDiff === 0) {
      return 'Today';
    }
    if (dayDiff === 1) {
      return 'Yesterday';
    }

    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
  };

  const compressTimelineEntries = (entries) => {
    const compressed = [];

    let index = 0;
    while (index < entries.length) {
      const entry = entries[index];
      const shouldCompress =
        entry?.kind === 'fdr_detection_started' ||
        String(entry?.action || '').toLowerCase() === 'behavioral anomaly detection started';

      if (!shouldCompress) {
        compressed.push({ type: 'entry', entry });
        index += 1;
        continue;
      }

      const groupEntries = [entry];
      let nextIndex = index + 1;

      while (nextIndex < entries.length) {
        const nextEntry = entries[nextIndex];
        const sameKind = nextEntry?.kind === entry.kind && nextEntry?.action === entry.action;
        if (!sameKind) {
          break;
        }

        const lastTimestamp = new Date(groupEntries[groupEntries.length - 1].timestamp || 0).getTime();
        const nextTimestamp = new Date(nextEntry?.timestamp || 0).getTime();
        if (Number.isNaN(lastTimestamp) || Number.isNaN(nextTimestamp)) {
          break;
        }

        if (lastTimestamp - nextTimestamp <= TIMELINE_DEDUPE_WINDOW_MS) {
          groupEntries.push(nextEntry);
          nextIndex += 1;
        } else {
          break;
        }
      }

      if (groupEntries.length > 1) {
        compressed.push({
          type: 'group',
          id: `${entry.id}-group`,
          action: entry.action,
          kind: entry.kind,
          timestamp: entry.timestamp,
          entries: groupEntries,
        });
      } else {
        compressed.push({ type: 'entry', entry });
      }

      index = nextIndex;
    }

    return compressed;
  };

  const resolveTimelineItemTimestamp = (item) => {
    if (!item) {
      return null;
    }
    if (item.type === 'group') {
      return item.timestamp;
    }
    return item.entry?.timestamp || null;
  };

  const derivedTimeline = useMemo(() => {
    if (!caseData) {
      return [];
    }

    const entries = [];
    const hasEvent = (predicate) =>
      caseTimeline.some((item) => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        return predicate(item);
      });

    const fdrAttachments = attachments.filter((attachment) => {
      const type = (attachment?.type || '').toUpperCase();
      const name = (attachment?.name || '').toLowerCase();
      const storageKey = attachment?.storage?.objectKey || attachment?.storage?.key;
      return Boolean(storageKey) && (type === 'FDR' || name.includes('fdr'));
    });

    fdrAttachments.forEach((attachment) => {
      const uploadedAt = attachment.uploadedAt || attachment.createdAt || null;
      const uploadedBy = attachment.uploadedBy || '';
      if (
        hasEvent(
          (item) =>
            item.kind === 'fdr_upload' ||
            (item.action || item.title || '').toLowerCase().includes('fdr data uploaded'),
        )
      ) {
        return;
      }

      entries.push({
        id: `fdr-upload-${attachment.name}-${uploadedAt || ''}`,
        kind: 'fdr_upload',
        action: 'FDR data uploaded',
        actor: uploadedBy ? { name: uploadedBy } : null,
        timestamp: uploadedAt,
        metadata: [{ label: 'File', value: attachment.name }],
      });
    });

    const latestRun = caseData.fdrAnalysisLatestRun;
    if (
      latestRun &&
      fdrAnalysisStatus === FDR_ANALYSIS_STATUSES.COMPLETED &&
      !hasEvent(
        (item) =>
          item.kind === 'fdr_detection_completed' ||
          (item.action || '').toLowerCase().includes('behavioral anomaly detection completed'),
      )
    ) {
      const resolvedResultsUrl = resolveResultsUrl('fdr', latestRun.runId || null);
      const actor = latestRun.createdBy?.name || latestRun.createdBy?.email || '';
      entries.push({
        id: `fdr-detection-start-${latestRun.runId || latestRun.createdAt}`,
        kind: 'fdr_detection_started',
        action: 'Behavioral anomaly detection started',
        actor: actor ? { name: actor } : null,
        timestamp: latestRun.createdAt,
        metadata: [{ label: 'Status', value: 'Inferred start time' }],
      });
      entries.push({
        id: `fdr-detection-complete-${latestRun.runId || latestRun.createdAt}`,
        kind: 'fdr_detection_completed',
        action: 'Behavioral anomaly detection completed',
        actor: actor ? { name: actor } : null,
        timestamp: latestRun.createdAt,
        metadata: [
          { label: 'Status', value: 'Success' },
          { label: 'Duration', value: '—' },
        ],
        links: {
          resultsUrl: resolvedResultsUrl,
          runId: latestRun.runId || null,
        },
      });
    }

    const reportAttachments = attachments.filter((attachment) => {
      const name = (attachment?.name || '').toLowerCase();
      const type = (attachment?.type || '').toLowerCase();
      return (
        name.endsWith('.pdf') ||
        name.endsWith('.docx') ||
        type === 'report' ||
        type === 'report export'
      );
    });

    reportAttachments.forEach((attachment) => {
      if (
        hasEvent(
          (item) =>
            item.kind === 'report_export' ||
            (item.action || '').toLowerCase().includes('report exported'),
        )
      ) {
        return;
      }

      const extension = attachment?.name?.split('.').pop() || '';
      const format = extension ? extension.toUpperCase() : attachment?.format?.toUpperCase() || 'Report';
      entries.push({
        id: `report-export-${attachment.name}-${attachment.uploadedAt || ''}`,
        kind: 'report_export',
        action: `Report exported (${format})`,
        actor: attachment.uploadedBy ? { name: attachment.uploadedBy } : null,
        timestamp: attachment.uploadedAt || attachment.createdAt || null,
        metadata: [
          { label: 'Format', value: format },
          {
            label: 'Run used',
            value: 'Open results',
            href: resolveResultsUrl('fdr'),
          },
        ],
        links: {
          resultsUrl: resolveResultsUrl('fdr'),
          download: {
            bucket: attachment?.storage?.bucket,
            objectKey: attachment?.storage?.objectKey || attachment?.storage?.key,
            fileName: attachment.name,
            contentType: attachment.contentType,
          },
        },
      });
    });

    return entries;
  }, [attachments, caseData, caseNumber, caseTimeline, fdrAnalysisStatus]);

  const timeline = useMemo(() => {
    const normalized = caseTimeline
      .map((item, index) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        return {
          id: item.id || `${item.timestamp || item.date || item.title}-${index}`,
          kind: item.kind || item.type || null,
          eventType: item.eventType || item.event_type || null,
          action: item.action || item.title || item.label || 'Timeline event',
          actor: item.actor || item.user || item.performedBy || item.by || null,
          timestamp: item.timestamp || item.date || item.createdAt || item.time || null,
          metadata: item.metadata || item.details || item.meta || null,
          note: item.note || item.message || item.content || item.noteText || null,
          editedBy: item.editedBy || item.edited_by || null,
          editedAt: item.editedAt || item.edited_at || null,
          deletedBy: item.deletedBy || item.deleted_by || null,
          deletedAt: item.deletedAt || item.deleted_at || null,
          links: item.links || {},
        };
      })
      .filter(Boolean);

    const combined = [...normalized, ...derivedTimeline];
    return combined.sort((a, b) => {
      const aTime = a.timestamp ? new Date(a.timestamp).getTime() : null;
      const bTime = b.timestamp ? new Date(b.timestamp).getTime() : null;

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
  }, [caseTimeline, derivedTimeline]);

  const resolveModuleKeyFromEntry = (entry) => {
    const kindValue = String(entry?.kind || '').toLowerCase();
    const actionValue = String(entry?.action || '').toLowerCase();

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
      return 'correlate';
    }

    return null;
  };

  const resolveRunStatusValue = (entry) => {
    const metadataEntries = buildMetadataEntries(entry?.metadata);
    const statusEntry = metadataEntries.find(
      (metadataEntry) => String(metadataEntry.label || '').toLowerCase() === 'status',
    );
    return statusEntry?.value ? String(statusEntry.value) : '';
  };

  const isSuccessfulCompletion = (entry) => {
    const kindValue = String(entry?.kind || '').toLowerCase();
    const actionValue = String(entry?.action || '').toLowerCase();
    const statusValue = resolveRunStatusValue(entry).toLowerCase();

    if (statusValue && ['fail', 'failed', 'failure', 'error'].some((flag) => statusValue.includes(flag))) {
      return false;
    }

    return kindValue.includes('completed') || actionValue.includes('completed');
  };

  const resolveRunIdFromEntry = (entry) => entry?.links?.runId || null;

  const resolveResultsUrlForEntry = (entry) => {
    const moduleKey = resolveModuleKeyFromEntry(entry);
    const runId = resolveRunIdFromEntry(entry);
    return (
      resolveResultsUrl(moduleKey, runId) ||
      entry?.links?.resultsUrl ||
      null
    );
  };

  const latestRunsByModule = useMemo(() => {
    const latestRuns = {
      fdr: null,
      cvr: null,
      correlate: null,
    };

    timeline.forEach((entry) => {
      const moduleKey = resolveModuleKeyFromEntry(entry);
      if (!moduleKey || !isSuccessfulCompletion(entry)) {
        return;
      }

      const runTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
      if (!runTimestamp || Number.isNaN(runTimestamp)) {
        return;
      }

      const current = latestRuns[moduleKey];
      if (!current || runTimestamp > current.timestampMs) {
        latestRuns[moduleKey] = {
          runId: resolveRunIdFromEntry(entry),
          timestamp: entry.timestamp,
          timestampMs: runTimestamp,
          runBy: resolveActorLabel(entry.actor),
          resultsUrl: resolveResultsUrlForEntry(entry),
        };
      }
    });

    return latestRuns;
  }, [timeline]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      // DOM inspection note: results button was disabled due to stale status logic, now derived from timeline runs.
      // eslint-disable-next-line no-console
      console.debug('[CaseDetails] latestRunsByModule', latestRunsByModule);
    }
  }, [latestRunsByModule]);

  const latestAttachmentNames = useMemo(() => {
    const resolveLatestName = (type) => {
      const matching = attachments.filter((attachment) => {
        const attachmentType = (attachment?.type || '').toUpperCase();
        return attachmentType === type;
      });

      if (matching.length === 0) {
        return '';
      }

      const sorted = [...matching].sort((a, b) => {
        const aTime = new Date(a.uploadedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.uploadedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      });

      return sorted[0]?.name || '';
    };

    return {
      fdr: resolveLatestName('FDR'),
      cvr: resolveLatestName('CVR'),
    };
  }, [attachments]);

  const getModuleStatusLabel = ({ key, rawStatus, ready, caseRecord }) => {
    if (key === 'correlate') {
      return 'Not Started';
    }

    if (key === 'fdr') {
      const normalized = normalizeFdrAnalysisStatus(rawStatus);
      if (normalized === FDR_ANALYSIS_STATUSES.FAILED) {
        return 'Failed';
      }
      if (normalized === FDR_ANALYSIS_STATUSES.COMPLETED) {
        return 'Analyzed/Completed';
      }
      return ready ? 'Ready for Analysis' : 'Not Started';
    }

    return computeCvrStatus(caseRecord || {}).status;
  };

  const analysisCards = useMemo(() => {
    const analyses = caseData?.analyses || {};

    return [
      {
        key: 'fdr',
        title: 'FDR Analysis',
        rawStatus: caseData?.fdrAnalysisStatus,
        description: analyses.fdr?.summary || 'No summary available yet.',
        evaluation: evaluateModuleReadiness(caseData, 'fdr'),
        latestRun: latestRunsByModule.fdr,
      },
      {
        key: 'cvr',
        title: 'CVR Analysis',
        rawStatus: analyses.cvr?.status,
        description: analyses.cvr?.summary || 'No summary available yet.',
        evaluation: evaluateModuleReadiness(caseData, 'cvr'),
        latestRun: latestRunsByModule.cvr,
      },
      {
        key: 'correlate',
        title: 'Correlation',
        rawStatus: analyses.correlate?.status,
        description: analyses.correlate?.summary || 'No summary available yet.',
        evaluation: evaluateModuleReadiness(caseData, 'correlate'),
        latestRun: latestRunsByModule.correlate,
      },
    ];
  }, [caseData, latestRunsByModule]);

  const filteredTimeline = useMemo(() => {
    if (timelineFilter === 'all') {
      return timeline;
    }

    return timeline.filter((entry) => getTimelineCategory(entry) === timelineFilter);
  }, [timeline, timelineFilter]);

  const compressedTimeline = useMemo(
    () => compressTimelineEntries(filteredTimeline),
    [filteredTimeline],
  );

  const visibleTimeline = useMemo(
    () => compressedTimeline.slice(0, timelinePage * TIMELINE_PAGE_SIZE),
    [compressedTimeline, timelinePage],
  );

  const timelineSections = useMemo(() => {
    const sections = [];
    visibleTimeline.forEach((item) => {
      const timestamp = resolveTimelineItemTimestamp(item);
      const label = resolveTimelineGroupLabel(timestamp);
      const lastSection = sections[sections.length - 1];
      if (!lastSection || lastSection.label !== label) {
        sections.push({ label, items: [item] });
      } else {
        lastSection.items.push(item);
      }
    });
    return sections;
  }, [visibleTimeline]);

  const hasMoreTimeline = visibleTimeline.length < compressedTimeline.length;

  const handleDownloadReport = async (entry) => {
    if (!entry?.links?.download?.objectKey) {
      setDownloadError('No download is available for this report.');
      return;
    }

    setDownloadError('');
    setDownloadingKey(entry.id);
    try {
      const target = await createDownloadTarget({
        bucket: entry.links.download.bucket,
        objectKey: entry.links.download.objectKey,
        fileName: entry.links.download.fileName,
        contentType: entry.links.download.contentType,
      });
      window.open(target.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (downloadErr) {
      setDownloadError(downloadErr.message || 'Unable to download the report.');
    } finally {
      setDownloadingKey('');
    }
  };

  const handleDownloadExport = async (exportItem) => {
    if (!exportItem?.storagePath) {
      setDownloadError('No download is available for this report.');
      return;
    }

    setDownloadError('');
    setDownloadingExportId(exportItem.exportId);
    try {
      const target = await createDownloadTarget({
        bucket: exportItem.storageBucket,
        objectKey: exportItem.storagePath,
        fileName: exportItem.filename,
      });
      window.open(target.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (downloadErr) {
      setDownloadError(downloadErr.message || 'Unable to download the report.');
    } finally {
      setDownloadingExportId('');
    }
  };

  const handleRequestDeleteReport = (report) => {
    setRecentExportsError('');
    setPendingDeleteReport(report);
    setDeleteModalOpen(true);
  };

  const handleConfirmDeleteReport = async () => {
    if (!caseNumber || !pendingDeleteReport?.exportId) {
      return;
    }

    const reportId = pendingDeleteReport.exportId;
    setRecentExportsError('');
    setDeletingReportId(reportId);

    try {
      const response = await deleteReportExport(caseNumber, reportId);
      if (!response?.ok) {
        throw new Error('Unable to delete report.');
      }

      setRecentExports((current) =>
        current.filter((item) => item.exportId !== reportId),
      );
      setDeleteModalOpen(false);
      setPendingDeleteReport(null);
    } catch (deleteErr) {
      setRecentExportsError(deleteErr.message || 'Unable to delete report.');
    } finally {
      setDeletingReportId('');
    }
  };

  const handleToggleTimelineGroup = (groupId) => {
    setExpandedTimelineGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };


  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <button
          type="button"
          onClick={goBack}
          className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Cases
        </button>
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
          <p className="text-sm text-gray-500">Loading case details…</p>
        </div>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="max-w-5xl mx-auto">
        <button
          type="button"
          onClick={goBack}
          className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Cases
        </button>
        <div className="mt-10 bg-white shadow-md rounded-xl p-8 text-center">
          <h2 className="text-xl font-semibold text-gray-800">Case not found</h2>
          <p className="mt-2 text-gray-600">
            {error || 'The selected case could not be located. Please return to the cases list and select another case.'}
          </p>
        </div>
      </div>
    );
  }

  const tags = Array.isArray(caseData.tags) ? caseData.tags : [];
  const investigatorInfo = caseData.investigator || {};
  const aircraftInfo = caseData.aircraft || {};
  const pendingDeleteKey =
    pendingDeleteAttachment?.storage?.objectKey || pendingDeleteAttachment?.storage?.key;
  const isPendingDelete = Boolean(
    (pendingDeleteKey && deletingKey === pendingDeleteKey) ||
    (pendingDeleteReport?.exportId && deletingReportId === pendingDeleteReport.exportId),
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <button
        type="button"
        onClick={goBack}
        className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Cases
      </button>

      <div className="bg-white rounded-2xl shadow-lg p-6 md:p-8 space-y-6">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500">Case #{caseData.caseNumber}</p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">{caseData.caseName}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-4">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${CASE_STATUS_STYLES[caseData.computedStatus] || 'bg-gray-100 text-gray-700'}`}>
                {resolveCaseStatusLabel(caseData)}
              </span>
              <span className="flex items-center gap-2 text-sm text-gray-600">
                <Calendar className="w-4 h-4" /> Last updated {caseData.lastUpdated || '—'}
              </span>
              <span className="flex items-center gap-2 text-sm text-gray-600">
                <Plane className="w-4 h-4" /> {caseData.aircraftType || 'Unknown aircraft'}
              </span>
            </div>
          </div>
          <div className="bg-emerald-50 rounded-xl p-4 w-full md:w-72">
            <h2 className="text-sm font-semibold text-emerald-700">Case owner</h2>
            <p className="mt-1 text-lg font-semibold text-emerald-900">{caseData.owner}</p>
            <p className="text-sm text-emerald-700/80">{caseData.organization || '—'}</p>
            <p className="mt-3 text-sm text-emerald-700 flex items-center gap-2">
              <Clock3 className="w-4 h-4" /> Examiner: {caseData.examiner || '—'}
            </p>
            {(investigatorInfo.email || investigatorInfo.phone) && (
              <div className="mt-3 space-y-2 text-sm text-emerald-700">
                {investigatorInfo.email && (
                  <p className="flex items-center gap-2">
                    <Mail className="w-4 h-4" /> {investigatorInfo.email}
                  </p>
                )}
                {investigatorInfo.phone && (
                  <p className="flex items-center gap-2">
                    <Phone className="w-4 h-4" /> {investigatorInfo.phone}
                  </p>
                )}
              </div>
            )}
            {investigatorInfo.notes && (
              <p className="mt-3 text-xs text-emerald-700/80 bg-white/60 border border-emerald-100 rounded-lg px-3 py-2">
                {investigatorInfo.notes}
              </p>
            )}
          </div>
        </div>

        <div className="bg-gray-50 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Reports / Recent Exports</h2>
          {recentExportsError && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {recentExportsError}
            </div>
          )}
          {recentExportsLoading ? (
            <p className="text-sm text-gray-500">Loading recent exports…</p>
          ) : recentExports.length === 0 ? (
            <p className="text-sm text-gray-500">No exports generated yet.</p>
          ) : (
            <div className="max-h-[320px] overflow-y-auto pr-1 sm:pr-2">
              <ul className="space-y-3">
                {recentExports.map((item) => {
                  const isRowDeleting = deletingReportId === item.exportId;
                  return (
                    <li key={item.exportId} className="rounded-lg border border-gray-100 bg-white px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                        <span>{item.format}</span>
                        <span>{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—'}</span>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-gray-800">{item.filename}</p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                        <span>
                          {item.createdBy?.firstName || item.createdBy?.lastName
                            ? `${item.createdBy?.firstName || ''} ${item.createdBy?.lastName || ''}`.trim()
                            : item.createdBy?.email || 'Unknown'}
                        </span>
                        {item.linkedRunId && <span>Run {item.linkedRunId}</span>}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadExport(item)}
                          disabled={downloadingExportId === item.exportId || isRowDeleting}
                          className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {downloadingExportId === item.exportId ? 'Preparing…' : 'Download'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRequestDeleteReport(item)}
                          disabled={isRowDeleting}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {isRowDeleting ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-6">
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-800">Case summary</h2>
              <p className="text-gray-700 leading-relaxed">{caseData.summary || 'No summary provided.'}</p>
            </div>
            <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-gray-800">Investigator Summary</h2>
                  <p className="text-xs text-gray-500">
                    Add a narrative overview to include in reports.
                  </p>
                </div>
                {!isEditingInvestigatorSummary && (
                  <button
                    type="button"
                    onClick={handleEditInvestigatorSummary}
                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50"
                  >
                    Edit
                  </button>
                )}
              </div>
              {isEditingInvestigatorSummary ? (
                <div className="space-y-3">
                  <textarea
                    value={investigatorSummaryDraft}
                    onChange={(event) => setInvestigatorSummaryDraft(event.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    placeholder="Write the investigator summary to include in exports."
                  />
                  {investigatorSummaryError && (
                    <p className="text-xs text-rose-600">{investigatorSummaryError}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleSaveInvestigatorSummary}
                      disabled={investigatorSummarySaving}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {investigatorSummarySaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelInvestigatorSummary}
                      className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {caseData.investigatorSummary || 'No investigator summary added yet.'}
                </p>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-800">Key details</h2>
            <div className="space-y-3 text-sm text-gray-700">
              <div className="flex items-center gap-2">
                <Workflow className="w-4 h-4 text-emerald-600" />
                <span>Focus: {caseData.module || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-emerald-600" />
                <span>{caseData.location || 'Location not specified'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-emerald-600" />
                <span>Occurrence date: {caseData.date || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Plane className="w-4 h-4 text-emerald-600" />
                <span>Tail number: {aircraftInfo.aircraftNumber || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Plane className="w-4 h-4 text-emerald-600" />
                <span>Operator: {aircraftInfo.operator || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Plane className="w-4 h-4 text-emerald-600" />
                <span>Flight number: {aircraftInfo.flightNumber || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Tags className="w-4 h-4 text-emerald-600" />
                <span className="flex flex-wrap gap-2">
                  {tags.length > 0
                    ? tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium"
                        >
                          {tag}
                        </span>
                      ))
                    : 'No tags assigned.'}
                </span>
              </div>
            </div>
          </div>
        </div>
        
        {analysisError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {analysisError}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {analysisCards.map(({ key, title, rawStatus, description, evaluation, latestRun }) => {
            const Icon = analysisIcon[key];
            const ready = evaluation?.ready;
            const missingTypes = evaluation?.missingTypes || [];
            const uploadLabel = (() => {
              if (!missingTypes.length) {
                return 'Upload recorder data';
              }

              if (missingTypes.length === 2) {
                return 'Upload FDR & CVR data';
              }

              if (missingTypes.length === 1) {
                return missingTypes[0] === 'FDR' ? 'Upload FDR data' : 'Upload CVR data';
              }

              return 'Upload recorder data';
            })();
            const hasFdrFile = Boolean(latestAttachmentNames.fdr);
            const hasCvrFile = Boolean(latestAttachmentNames.cvr);
            const fileLine =
              key === 'fdr'
                ? hasFdrFile
                  ? latestAttachmentNames.fdr
                  : 'No file uploaded'
                : key === 'cvr'
                  ? hasCvrFile
                    ? latestAttachmentNames.cvr
                    : 'No file uploaded'
                  : hasFdrFile && hasCvrFile
                    ? 'N/A'
                    : 'FDR + CVR required';
            const statusLabel = getModuleStatusLabel({ key, rawStatus, ready, caseRecord: caseData });
            const badgeStyles = getAnalysisStatusStyles(statusLabel);
            const hasLatestRun = key !== 'correlate' && Boolean(latestRun?.resultsUrl);
            const latestRunAtLabel = hasLatestRun ? formatTimelineTimestamp(latestRun.timestamp) : '';
            const latestRunByLabel = hasLatestRun ? latestRun.runBy || '—' : '';
            const isCorrelationModule = key === 'correlate';
            const openModuleHandler = isCorrelationModule
              ? undefined
              : ready
                ? () => handleOpenModule(key)
                : () => handleUploadData(key, missingTypes);
            const openModuleDisabled = isCorrelationModule || (!ready && missingTypes.length === 0);
            const primaryLabel = isCorrelationModule ? 'Coming soon' : ready ? 'Open module' : 'Upload file';

            return (
              <div key={key} className="border border-gray-200 rounded-xl p-4 bg-gray-50/60 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <Icon className="w-5 h-5 text-emerald-600" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-800">{title}</p>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${badgeStyles}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">{fileLine}</p>
                  </div>
                </div>
                <p className="text-sm text-gray-600 min-h-[60px]">{description}</p>
                <div className="mt-auto space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={openModuleHandler}
                      disabled={openModuleDisabled}
                      title={isCorrelationModule ? 'Correlation module will be available in a future release.' : undefined}
                      className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {primaryLabel}
                    </button>
                    {isCorrelationModule && (
                      <p className="w-full text-xs text-gray-500">Correlation module will be available in a future release.</p>
                    )}
                    {hasLatestRun && (
                      <button
                        type="button"
                        onClick={() => handleViewLatestResults(key)}
                        className="pointer-events-auto inline-flex items-center justify-center rounded-lg border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                      >
                        View latest results
                      </button>
                    )}
                  </div>
                  {hasLatestRun && (
                    <div className="text-xs text-gray-500 space-y-1">
                      <p>Latest run at {latestRunAtLabel}</p>
                      <p>Run by {latestRunByLabel}</p>
                    </div>
                  )}
                  {!ready && !isCorrelationModule && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        onClick={() => handleUploadData(key, missingTypes)}
                        className="text-sm font-semibold text-emerald-600 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                      >
                        {uploadLabel} →
                      </button>
                      {evaluation?.message && (
                        <p className="text-xs text-emerald-700/90">{evaluation.message}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-gray-50 rounded-xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-800">Investigator Notes</h2>
                  <p className="text-xs text-gray-500">Notes are saved separately from the activity log.</p>
                </div>
              </div>
              <NotesPanel
                caseNumber={caseNumber}
                module="general"
                emptyMessage="No investigator notes yet."
              />
            </div>

            <div className="bg-gray-50 rounded-xl p-5">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">Attachments</h2>
              {deleteError && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {deleteError}
                </div>
              )}
              <div className="max-h-[320px] overflow-y-auto pr-1">
                {attachments.length === 0 ? (
                  <p className="text-sm text-gray-500">No attachments have been uploaded.</p>
                ) : (
                  <ul className="space-y-4">
                    {attachments.map((file, index) => {
                      const details = [
                        file.type,
                        file.size,
                        file.status ? `Status: ${file.status}` : null,
                        file.uploadedBy ? `Uploaded by ${file.uploadedBy}` : null,
                      ]
                        .filter(Boolean)
                        .join(' • ');
                      const objectKey = file?.storage?.objectKey || file?.storage?.key;
                      const isDeleting = deletingKey === objectKey;

                      return (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                        >
                          <div className="flex flex-1 items-start gap-3 min-w-0">
                            <FileText className="w-5 h-5 text-emerald-600 mt-0.5" />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-800 break-words">{file.name}</p>
                              <p className="text-xs text-gray-500">{details || 'No additional metadata'}</p>
                              {file.notes && (
                                <p className="text-xs text-gray-500 mt-1">{file.notes}</p>
                              )}
                            </div>
                          </div>
                          {objectKey && (
                            <div className="flex flex-col items-end gap-1 text-right min-w-[110px]">
                              <button
                                type="button"
                                onClick={() => handleRequestDeleteAttachment(file)}
                                disabled={isDeleting}
                                className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {isDeleting ? 'Deleting…' : 'Delete'}
                              </button>
                              <span className="text-[11px] text-gray-400">Remove attachment</span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl p-5">
            <div className="rounded-xl border border-gray-200 bg-white">
              <div className="max-h-[420px] overflow-y-auto">
                <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-100 px-4 py-3 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-gray-800">Activity Log</h2>
                      <p className="text-xs text-gray-500">
                        Showing {visibleTimeline.length} of {compressedTimeline.length} entries
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {TIMELINE_FILTERS.map((filter) => {
                      const isActive = timelineFilter === filter.key;
                      return (
                        <button
                          key={filter.key}
                          type="button"
                          onClick={() => setTimelineFilter(filter.key)}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                            isActive
                              ? 'bg-emerald-600 text-white'
                              : 'bg-white text-gray-600 border border-gray-200 hover:border-emerald-200 hover:text-emerald-700'
                          }`}
                        >
                          {filter.label}
                        </button>
                      );
                    })}
                  </div>
                  {downloadError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      {downloadError}
                    </div>
                  )}
                </div>
                <div className="px-4 py-4">
                  {timeline.length === 0 ? (
                    <p className="text-sm text-gray-500">No timeline events recorded.</p>
                  ) : compressedTimeline.length === 0 ? (
                    <p className="text-sm text-gray-500">No timeline events match this filter.</p>
                  ) : (
                    <div className="space-y-6 divide-y divide-gray-100">
                      {timelineSections.map((section, sectionIndex) => (
                        <div
                          key={section.label}
                          className={`space-y-3 ${sectionIndex === 0 ? '' : 'pt-6'}`}
                        >
                          <div className="sticky top-[112px] z-10 -mx-4 px-4 py-1 bg-white/95 backdrop-blur border-b border-gray-100">
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                              {section.label}
                            </p>
                          </div>
                          <ol className="space-y-4">
                            {section.items.map((item) => {
                              if (item.type === 'group') {
                                const groupExpanded = expandedTimelineGroups.has(item.id);
                                return (
                                  <li key={item.id} className="flex gap-3">
                                    <div className="w-2 h-2 rounded-full bg-amber-500 mt-2" />
                                    <div className="flex-1 space-y-2 rounded-xl border border-amber-100 bg-amber-50/50 p-3">
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-semibold text-gray-800">{item.action}</p>
                                          <p className="text-xs text-gray-500">
                                            {item.entries.length} starts within 10 minutes
                                          </p>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => handleToggleTimelineGroup(item.id)}
                                          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700"
                                        >
                                          {groupExpanded ? 'Hide details' : 'Show details'}
                                          {groupExpanded ? (
                                            <ChevronUp className="w-3 h-3" />
                                          ) : (
                                            <ChevronDown className="w-3 h-3" />
                                          )}
                                        </button>
                                      </div>
                                      {groupExpanded && (
                                        <ul className="space-y-2 text-xs text-gray-500">
                                          {item.entries.map((entry) => {
                                            const actorLabel = resolveActorLabel(entry.actor);
                                            return (
                                              <li key={entry.id} className="flex flex-wrap items-center gap-1">
                                                <span>{formatTimelineTimestamp(entry.timestamp)}</span>
                                                {actorLabel && <span>• {actorLabel}</span>}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      )}
                                    </div>
                                  </li>
                                );
                              }

                              const timelineEntry = item.entry;
                              const actorLabel = resolveActorLabel(timelineEntry.actor);
                              const metadataEntries = buildMetadataEntries(timelineEntry.metadata).filter(
                                (entry) => entry.label !== 'Note',
                              );
                              const resultsUrl = resolveResultsUrlForEntry(timelineEntry);
                              const showResultsButton =
                                Boolean(resultsUrl) && isSuccessfulCompletion(timelineEntry);
                              const showDownloadButton =
                                timelineEntry.kind === 'report_export' && timelineEntry.links?.download?.objectKey;
                              const isEditable = isEditableTimelineEntry(timelineEntry);
                              const noteText = timelineEntry.note || '';
                              const editedByLabel = resolveActorLabel(
                                timelineEntry.editedBy || timelineEntry.edited_by,
                              );
                              const editedTimestamp = timelineEntry.editedAt || timelineEntry.edited_at;
                              const deletedByLabel = resolveActorLabel(
                                timelineEntry.deletedBy || timelineEntry.deleted_by,
                              );
                              const deletedTimestamp = timelineEntry.deletedAt || timelineEntry.deleted_at;
                              const isDeletedNote = Boolean(deletedTimestamp) && isNoteEntry(timelineEntry);
                              const showNoteBlock = isNoteEntry(timelineEntry);

                              return (
                                <li key={timelineEntry.id} className="flex gap-3">
                                  <div
                                    className={`w-2 h-2 rounded-full mt-2 ${
                                      isEditable ? 'bg-amber-500' : 'bg-emerald-500'
                                    }`}
                                  />
                                  <div className="flex-1 space-y-2">
                                    <div className="flex flex-col gap-1">
                                      <p className="text-sm font-semibold text-gray-800">{timelineEntry.action}</p>
                                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                        <span>{formatTimelineTimestamp(timelineEntry.timestamp)}</span>
                                        {actorLabel && <span>• {actorLabel}</span>}
                                      </div>
                                    </div>
                                    {showNoteBlock && (
                                      <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-gray-700">
                                        {isDeletedNote ? (
                                          <p className="italic text-gray-400">Deleted note</p>
                                        ) : (
                                          <p className="text-sm text-gray-700">{noteText || '—'}</p>
                                        )}
                                      </div>
                                    )}
                                    {editedTimestamp && !isDeletedNote && (
                                      <p className="text-xs text-gray-400">
                                        Edited {editedByLabel ? `by ${editedByLabel} ` : ''}
                                        {editedTimestamp ? `• ${formatTimelineTimestamp(editedTimestamp)}` : ''}
                                      </p>
                                    )}
                                    {isDeletedNote && (
                                      <p className="text-xs text-gray-400">
                                        Deleted {deletedByLabel ? `by ${deletedByLabel} ` : ''}
                                        {deletedTimestamp ? `• ${formatTimelineTimestamp(deletedTimestamp)}` : ''}
                                      </p>
                                    )}
                                    {metadataEntries.length > 0 && (
                                      <dl className="space-y-1 text-xs text-gray-500">
                                        {metadataEntries.map((entry, entryIndex) => (
                                          <div key={`${entry.label}-${entryIndex}`} className="flex flex-wrap gap-1">
                                            <dt className="font-semibold text-gray-600">{entry.label}:</dt>
                                            <dd>
                                              {entry.href ? (
                                                <button
                                                  type="button"
                                                  onClick={() => navigate(entry.href)}
                                                  className="text-emerald-600 hover:text-emerald-700"
                                                >
                                                  {entry.value}
                                                </button>
                                              ) : (
                                                entry.value
                                              )}
                                            </dd>
                                          </div>
                                        ))}
                                      </dl>
                                    )}
                                    {(showResultsButton || showDownloadButton) && (
                                      <div className="flex flex-wrap items-center gap-2">
                                        {showResultsButton && (
                                          <button
                                            type="button"
                                            onClick={() => navigate(resultsUrl)}
                                            className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50"
                                          >
                                            Open results
                                          </button>
                                        )}
                                        {showDownloadButton && (
                                          <button
                                            type="button"
                                            onClick={() => handleDownloadReport(timelineEntry)}
                                            disabled={downloadingKey === timelineEntry.id}
                                            className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-70"
                                          >
                                            {downloadingKey === timelineEntry.id ? 'Preparing…' : 'Download'}
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ol>
                        </div>
                      ))}
                      {hasMoreTimeline && (
                        <button
                          type="button"
                          onClick={() => setTimelinePage((prev) => prev + 1)}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 transition hover:border-emerald-200 hover:text-emerald-700"
                        >
                          Show more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {deleteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">
              {pendingDeleteReport ? 'Delete this report?' : 'Delete attachment?'}
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              {pendingDeleteReport
                ? 'This cannot be undone.'
                : 'This will remove the file from this case. This action cannot be undone.'}
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={handleCancelDeleteAttachment}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteAttachment}
                disabled={isPendingDelete}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isPendingDelete ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CaseDetails;
