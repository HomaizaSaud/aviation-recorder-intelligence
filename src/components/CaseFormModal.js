import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatFileSize } from '../utils/files';
import { deriveCaseStatus, deriveDataStatus } from '../utils/statuses';
import { uploadAttachmentToObjectStore } from '../utils/storage';
import { createTimelineEntry } from '../utils/timeline';

const DEFAULT_ANALYSES = {
  fdr: { status: 'Not Started', lastRun: null, summary: '' },
  cvr: { status: 'Not Started', lastRun: null, summary: '' },
  correlate: { status: 'Not Started', lastRun: null, summary: '' },
};

const FDR_EXTENSIONS = ['.csv', '.xls', '.xlsx'];
const CVR_EXTENSIONS = ['.wav', '.mp3'];
const CVR_CHANNELS = [
  { id: 'channel-1', label: 'Channel 1 – Captain' },
  { id: 'channel-2', label: 'Channel 2 – First Officer' },
  { id: 'channel-3', label: 'Channel 3 – Observer / area' },
  { id: 'channel-4', label: 'Channel 4 – Cockpit area mic (CAM)' },
];

const formatDateInput = (value) => {
  if (!value) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

const createDefaultValues = () => ({
  caseNumber: '',
  caseName: '',
  module: 'No Data Uploaded',
  status: deriveCaseStatus(),
  owner: '',
  organization: '',
  examiner: '',
  aircraftType: '',
  location: '',
  summary: '',
  lastUpdated: '',
  date: '',
  investigator: {
    name: '',
    organization: '',
    phone: '',
    email: '',
    notes: '',
  },
  aircraft: {
    aircraftNumber: '',
    aircraftType: '',
    operator: '',
    flightNumber: '',
    location: '',
    dateOfFlight: '',
  },
  uploads: {
    fdr: {
      file: null,
      notes: '',
      existingAttachment: null,
    },
    cvrGeneral: {
      channelId: 'general',
      label: 'General CVR audio (full mix)',
      file: null,
      notes: '',
      existingAttachment: null,
    },
    cvrChannels: CVR_CHANNELS.map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      file: null,
      notes: '',
      existingAttachment: null,
    })),
  },
  attachments: [],
  analyses: {
    fdr: { ...DEFAULT_ANALYSES.fdr },
    cvr: { ...DEFAULT_ANALYSES.cvr },
    correlate: { ...DEFAULT_ANALYSES.correlate },
  },
  timeline: [],
});

const CaseFormModal = ({
  isOpen,
  mode = 'create',
  initialValues,
  onClose,
  onSubmit,
  onCaseRefresh,
  isSubmitting = false,
  errorMessage = '',
  initialUploadFocus = '',
}) => {
  const [formValues, setFormValues] = useState(() => createDefaultValues());
  const [localError, setLocalError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const buildFormValues = useCallback((caseData = {}) => {
    const defaults = createDefaultValues();
    const attachments = Array.isArray(caseData?.attachments) ? caseData.attachments : [];
    const mergedAnalyses =
      caseData?.analyses && typeof caseData.analyses === 'object'
        ? {
          fdr: { ...DEFAULT_ANALYSES.fdr, ...(caseData?.analyses?.fdr || {}) },
          cvr: { ...DEFAULT_ANALYSES.cvr, ...(caseData?.analyses?.cvr || {}) },
          correlate: { ...DEFAULT_ANALYSES.correlate, ...(caseData?.analyses?.correlate || {}) },
        }
        : { ...DEFAULT_ANALYSES };
    const mapUpload = ({ type, base, channelId = null }) => {
      const existing = attachments.find((item) => {
        if (item?.type !== type) {
          return false;
        }

        if (channelId) {
          const matchesChannel =
            item?.channel === channelId || item?.channelId === channelId;
          if (matchesChannel) {
            return true;
          }
          return channelId === 'general' && !item?.channel && !item?.channelId;
        }

        return !item?.channel && !item?.channelId;
      });

      if (!existing) {
        return { ...base };
      }

      return {
        ...base,
        file: null,
        notes: existing.notes || '',
        existingAttachment: existing,
      };
    };

    return {
      ...defaults,
      ...caseData,
      owner: caseData?.owner || caseData?.investigator?.name || '',
      organization: caseData?.organization || '',
      examiner: caseData?.examiner || caseData?.investigator?.name || '',
      aircraftType:
        caseData?.aircraftType || caseData?.aircraft?.aircraftType || defaults.aircraftType,
      location: caseData?.location || caseData?.aircraft?.location || defaults.location,
      lastUpdated: formatDateInput(caseData?.lastUpdated),
      date: formatDateInput(caseData?.date),
      investigator: {
        ...defaults.investigator,
        ...(caseData?.investigator || {}),
      },
      aircraft: {
        ...defaults.aircraft,
        ...(caseData?.aircraft || {}),
        dateOfFlight: formatDateInput(caseData?.aircraft?.dateOfFlight),
      },
      uploads: {
        fdr: mapUpload({ type: 'FDR', base: defaults.uploads.fdr }),
        cvrGeneral: mapUpload({
          type: 'CVR',
          base: defaults.uploads.cvrGeneral,
          channelId: defaults.uploads.cvrGeneral.channelId,
        }),
        cvrChannels: defaults.uploads.cvrChannels.map((channel) =>
          mapUpload({ type: 'CVR', base: channel, channelId: channel.channelId }),
        ),
      },
      attachments,
      analyses: mergedAnalyses,
      status: deriveCaseStatus({ analyses: mergedAnalyses }),
      module: deriveDataStatus(attachments),
      timeline: Array.isArray(caseData?.timeline) ? caseData.timeline : [],
    };
  }, []);

  const title = useMemo(() => (mode === 'edit' ? 'Edit Case' : 'Create New Case'), [mode]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleInvestigatorChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({
      ...prev,
      investigator: {
        ...prev.investigator,
        [name]: value,
      },
    }));
  };

  const handleAircraftChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({
      ...prev,
      aircraft: {
        ...prev.aircraft,
        [name]: value,
      },
      ...(name === 'aircraftType' ? { aircraftType: value } : {}),
      ...(name === 'location' ? { location: value } : {}),
    }));
  };

  const handleFileChange = (type) => (event) => {
    const file = event.target.files?.[0] || null;
    setFormValues((prev) => ({
      ...prev,
      uploads: {
        ...prev.uploads,
        [type]: {
          ...prev.uploads[type],
          file,
        },
      },
    }));
  };

  const handleCvrChannelFileChange = (channelId) => (event) => {
    const file = event.target.files?.[0] || null;
    setFormValues((prev) => ({
      ...prev,
      uploads: {
        ...prev.uploads,
        cvrChannels: (prev.uploads?.cvrChannels || []).map((channel) =>
          channel.channelId === channelId ? { ...channel, file } : channel,
        ),
      },
    }));
  };

  const handleUploadNotesChange = (type) => (event) => {
    const { value } = event.target;
    setFormValues((prev) => ({
      ...prev,
      uploads: {
        ...prev.uploads,
        [type]: {
          ...prev.uploads[type],
          notes: value,
        },
      },
    }));
  };

   const handleCvrChannelNotesChange = (channelId) => (eventOrValue) => {
    const value =
      eventOrValue && typeof eventOrValue === 'object' && 'target' in eventOrValue
        ? eventOrValue.target.value
        : eventOrValue;
    setFormValues((prev) => ({
      ...prev,
      uploads: {
        ...prev.uploads,
        cvrChannels: (prev.uploads?.cvrChannels || []).map((channel) =>
          channel.channelId === channelId ? { ...channel, notes: value || '' } : channel,
        ),
      },
    }));
  };

  const attachmentHasStoredData = useCallback((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return false;
    }

    if (attachment.storage && attachment.storage.objectKey) {
      return true;
    }

    const status = typeof attachment.status === 'string' ? attachment.status.toLowerCase() : '';
    const name = typeof attachment.name === 'string' ? attachment.name.toLowerCase() : '';

    if (status === 'pending' || name.includes('pending upload')) {
      return false;
    }

    return Boolean(attachment.name);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLocalError('');
      setFormValues(buildFormValues(initialValues || {}));
    }
  }, [buildFormValues, initialValues, isOpen]);

  const fdrUpload = formValues.uploads?.fdr || {};
  const cvrGeneralUpload = formValues.uploads?.cvrGeneral || {
    channelId: 'general',
    label: 'General CVR audio (full mix)',
    file: null,
    notes: '',
    existingAttachment: null,
  };
  const cvrChannelUploads = formValues.uploads?.cvrChannels || [];
  const normalizedFocus = (initialUploadFocus || '').toLowerCase();
  const highlightFdr = normalizedFocus === 'fdr' || normalizedFocus === 'both';
  const highlightCvr = normalizedFocus === 'cvr' || normalizedFocus === 'both';

  if (!isOpen) {
    return null;
  }

  const buildAttachments = async (investigatorName) => {
    const uploads = formValues.uploads || {};
    const existingAttachments = Array.isArray(formValues.attachments)
      ? formValues.attachments
      : [];
    const otherAttachments = existingAttachments.filter(
      (item) => item && item.type && !['FDR', 'CVR'].includes(item.type),
    );

    const attachments = [...otherAttachments];
    const ownerValue = investigatorName || formValues.owner || '';

    const processUpload = async (key, label, channelConfig = null) => {
      const upload = channelConfig || uploads[key] || {};
      const channelId = channelConfig?.channelId || null;
      const existing =
        upload.existingAttachment ||
        (channelId
          ? existingAttachments.find(
            (item) =>
              item?.type === label &&
                (item?.channel === channelId || item?.channelId === channelId),
          )
          : existingAttachments.find(
            (item) =>
              item?.type === label &&
                !item?.channel &&
                !item?.channelId,
          ));
      const file = upload.file;
      const notes = upload.notes ?? existing?.notes ?? '';
      const uploadedBy = existing?.uploadedBy || ownerValue || investigatorName || 'Unknown';

      if (file) {
        const result = await uploadAttachmentToObjectStore({
          caseNumber: formValues.caseNumber,
          attachmentType: label,
          channel: channelId,
          file,
          existingAttachments: [...attachments, ...existingAttachments],
        });

        attachments.push({
          type: label,
          channel: channelId,
          channelLabel: channelConfig?.label || '',
          name: file.name,
          size: formatFileSize(file.size),
          sizeBytes: file.size,
          uploadedBy,
          notes,
          status: 'Uploaded',
          storage: result.storage,
          contentType: result.contentType,
          uploadedAt: result.uploadedAt,
          checksum: result.checksum,
        });
        return { hasData: true, uploadedNow: true };

      }

      if (existing) {
        attachments.push({
          ...existing,
          channel: channelId || existing.channel,
          channelLabel: channelConfig?.label || existing.channelLabel,
          notes,
        });

        return {
          hasData: attachmentHasStoredData(existing),
          uploadedNow: false,
        };
      }

      if (notes) {
        attachments.push({
          type: label,
          channel: channelId,
          channelLabel: channelConfig?.label || '',
          name: `${label} data pending upload`,
          size: '',
          uploadedBy,
          notes,
          status: 'Pending',
        });
      }

      return { hasData: false, uploadedNow: false };
    };

    const fdrResult = await processUpload('fdr', 'FDR');
    const cvrGeneralResult = await processUpload('cvrGeneral', 'CVR', uploads.cvrGeneral || {});
    const cvrChannelResults = await Promise.all(
      (uploads.cvrChannels || []).map((channel) =>
        processUpload(`cvr:${channel.channelId}`, 'CVR', channel),
      ),
    );

    return {
      attachments,
      hasFdrData: fdrResult.hasData,
      hasCvrData: cvrGeneralResult.hasData || cvrChannelResults.some((result) => result.hasData),
      fdrUploadedNow: fdrResult.uploadedNow,
      cvrUploadedNow: cvrGeneralResult.uploadedNow || cvrChannelResults.some((result) => result.uploadedNow),
    };
  };



  const handleSubmit = async (event) => {
    event.preventDefault();

    if (isProcessing) {
      return;
    }

    const investigatorName = formValues.investigator?.name || '';
    const ownerValue = formValues.owner || investigatorName;

    if (!formValues.caseNumber || !formValues.caseName || !investigatorName || !ownerValue) {
      setLocalError('Case number, case name, and investigator name are required.');
      return;
    }

    try {
      setIsProcessing(true);
      setLocalError('');

      const {
        attachments,
        fdrUploadedNow,
        cvrUploadedNow,
      } = await buildAttachments(investigatorName);
      const uploadedNow = fdrUploadedNow || cvrUploadedNow;
      const currentDate = new Date().toISOString().slice(0, 10);
      const normalizedLastUpdated = uploadedNow
        ? currentDate
        : formatDateInput(formValues.lastUpdated) || null;

      const sanitizedUploads = {
        fdr: {
          notes: formValues.uploads?.fdr?.notes || '',
          existingAttachment: formValues.uploads?.fdr?.existingAttachment || null,
          ...(formValues.uploads?.fdr?.file
            ? {
              selectedFileName: formValues.uploads.fdr.file.name,
              selectedFileSize: formValues.uploads.fdr.file.size,
            }
            : {}),
        },
        cvrGeneral: {
          notes: formValues.uploads?.cvrGeneral?.notes || '',
          existingAttachment: formValues.uploads?.cvrGeneral?.existingAttachment || null,
          ...(formValues.uploads?.cvrGeneral?.file
            ? {
              selectedFileName: formValues.uploads.cvrGeneral.file.name,
              selectedFileSize: formValues.uploads.cvrGeneral.file.size,
            }
            : {}),
        },
        cvrChannels: (formValues.uploads?.cvrChannels || []).map((channel) => ({
          channelId: channel.channelId,
          label: channel.label,
          notes: channel.notes || '',
          existingAttachment: channel.existingAttachment || null,
          ...(channel.file
            ? {
              selectedFileName: channel.file.name,
              selectedFileSize: channel.file.size,
            }
            : {}),
        })),
      };

      const aircraft = {
        ...createDefaultValues().aircraft,
        ...formValues.aircraft,
        aircraftType: formValues.aircraft?.aircraftType || formValues.aircraftType || '',
        location: formValues.aircraft?.location || formValues.location || '',
        dateOfFlight: formatDateInput(formValues.aircraft?.dateOfFlight) || null,
      };

      const investigator = {
        ...createDefaultValues().investigator,
        ...formValues.investigator,
      };

      const existingTimeline = Array.isArray(formValues.timeline) ? formValues.timeline : [];
      const timelineUpdates = [];

      if (fdrUploadedNow) {
        const fdrAttachment = attachments.find(
          (item) => item?.type === 'FDR' && item?.storage?.objectKey,
        );
        if (fdrAttachment) {
          timelineUpdates.push(
            createTimelineEntry({
              kind: 'fdr_upload',
              action: 'FDR data uploaded',
              actor: { name: fdrAttachment.uploadedBy || ownerValue || investigatorName || 'Unknown' },
              timestamp: fdrAttachment.uploadedAt,
              metadata: [{ label: 'File', value: fdrAttachment.name }],
              links: {
                resultsUrl: `/cases/${formValues.caseNumber}/fdr`,
              },
            }),
          );
        }
      }

      if (mode === 'edit') {
        timelineUpdates.push(
          createTimelineEntry({
            kind: 'case_updated',
            action: 'Case updated',
            actor: { name: ownerValue || investigatorName || 'Unknown' },
            timestamp: normalizedLastUpdated || new Date().toISOString(),
            links: {
              caseUrl: `/cases/${formValues.caseNumber}`,
            },
          }),
        );
      }

      const { status: _status, module: _module, analyses: _analyses, ...editableFormValues } = formValues;

      const submitResult = await onSubmit({
        ...editableFormValues,
        uploads: sanitizedUploads,
        owner: ownerValue,
        examiner: formValues.examiner || investigatorName,
        aircraftType: aircraft.aircraftType,
        location: aircraft.location,
        investigator,
        aircraft,
        attachments,
        timeline: [...existingTimeline, ...timelineUpdates],
        lastUpdated: normalizedLastUpdated,
        date: formatDateInput(formValues.date) || null,
      });

      if (mode === 'edit' && formValues.caseNumber) {
        const refreshed = onCaseRefresh && (await onCaseRefresh(formValues.caseNumber));
        const nextCase = refreshed || submitResult;
        if (nextCase) {
          setFormValues(buildFormValues(nextCase));
        }
      }

      if (mode === 'edit') {
        onClose();
      }
    } catch (error) {
      setLocalError(error.message || 'Unable to save case changes.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">{title}</h2>
            <p className="text-sm text-gray-500">
              Provide key details about the investigation case.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-8 overflow-y-auto max-h-[75vh] pr-1">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Case Overview</h3>
            <p className="text-sm text-gray-500 mb-4">
              Update the essential details for this investigation case.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Case Number
                <input
                  name="caseNumber"
                  type="text"
                  value={formValues.caseNumber}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  disabled={mode === 'edit'}
                  required
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Case Name
                <input
                  name="caseName"
                  type="text"
                  value={formValues.caseName}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Owner
                <input
                  name="owner"
                  type="text"
                  value={formValues.owner}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Organization
                <input
                  name="organization"
                  type="text"
                  value={formValues.organization}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Examiner
                <input
                  name="examiner"
                  type="text"
                  value={formValues.examiner}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Last Updated
                <input
                  name="lastUpdated"
                  type="date"
                  value={formValues.lastUpdated}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Occurrence Date
                <input
                  name="date"
                  type="date"
                  value={formValues.date}
                  onChange={handleChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800">Summary</h3>
            <textarea
              name="summary"
              value={formValues.summary}
              onChange={handleChange}
              rows={4}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800">Investigator Information</h3>
            <p className="text-sm text-gray-500 mb-4">Keep the primary contact for this case up to date.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Name
                <input
                  name="name"
                  type="text"
                  value={formValues.investigator.name}
                  onChange={handleInvestigatorChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Organization
                <input
                  name="organization"
                  type="text"
                  value={formValues.investigator.organization}
                  onChange={handleInvestigatorChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Phone
                <input
                  name="phone"
                  type="text"
                  value={formValues.investigator.phone}
                  onChange={handleInvestigatorChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Email
                <input
                  name="email"
                  type="email"
                  value={formValues.investigator.email}
                  onChange={handleInvestigatorChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
            </div>
            <label className="text-sm font-medium text-gray-700 flex flex-col gap-2 mt-4">
              Notes
              <textarea
                name="notes"
                value={formValues.investigator.notes}
                onChange={handleInvestigatorChange}
                rows={3}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </label>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800">Aircraft Information</h3>
            <p className="text-sm text-gray-500 mb-4">Capture the aircraft context for this case.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Tail Number
                <input
                  name="aircraftNumber"
                  type="text"
                  value={formValues.aircraft.aircraftNumber}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Aircraft Type
                <input
                  name="aircraftType"
                  type="text"
                  value={formValues.aircraft.aircraftType}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Operator
                <input
                  name="operator"
                  type="text"
                  value={formValues.aircraft.operator}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Flight Number
                <input
                  name="flightNumber"
                  type="text"
                  value={formValues.aircraft.flightNumber}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Location
                <input
                  name="location"
                  type="text"
                  value={formValues.aircraft.location}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                Date of Flight
                <input
                  name="dateOfFlight"
                  type="date"
                  value={formValues.aircraft.dateOfFlight}
                  onChange={handleAircraftChange}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800">Data Uploads</h3>
            <p className="text-sm text-gray-500 mb-4">
              Upload the latest FDR and CVR datasets and add any supporting notes.
            </p>
            {(highlightFdr || highlightCvr) && (
              <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                {highlightFdr && highlightCvr
                  ? 'Upload both the FDR and CVR datasets to enable analysis for this case.'
                  : highlightFdr
                    ? 'Upload the FDR dataset to unlock FDR-related analysis.'
                    : 'Upload the CVR dataset to unlock CVR-related analysis.'}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div
                className={`border rounded-xl p-4 ${
                  highlightFdr
                    ? 'border-emerald-300 ring-2 ring-emerald-100 bg-emerald-50/40'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">FDR Data</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Upload the recorded flight data file for this case.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                      Upload file
                      <input
                        type="file"
                        accept={FDR_EXTENSIONS.join(',')}
                        onChange={handleFileChange('fdr')}
                        className="block w-full text-sm text-gray-700 border border-gray-200 rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-50 file:px-4 file:py-2 file:text-emerald-700"
                      />
                    </label>
                    <p className="text-xs text-gray-500">
                      Accepted formats: {FDR_EXTENSIONS.map((ext) => ext.replace('.', '').toUpperCase()).join(', ')}
                    </p>
                    <p className="text-xs text-gray-500">
                      {fdrUpload.file
                        ? `Selected file: ${fdrUpload.file.name} (${formatFileSize(fdrUpload.file.size)})`
                        : fdrUpload.existingAttachment
                          ? `Current file: ${fdrUpload.existingAttachment.name || 'Pending upload'}${fdrUpload.existingAttachment.size ? ` (${fdrUpload.existingAttachment.size})` : ''
                          }`
                          : 'No file uploaded yet.'}
                    </p>
                  </div>
                  <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                    Notes
                    <textarea
                      rows={3}
                      value={formValues.uploads.fdr.notes}
                      onChange={handleUploadNotesChange('fdr')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      placeholder="Add helpful reminders about this dataset"
                    />
                  </label>
                </div>
              </div>

              <div
                className={`border rounded-xl p-4 ${
                  highlightCvr
                    ? 'border-emerald-300 ring-2 ring-emerald-100 bg-emerald-50/40'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">CVR Data</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Upload the cockpit voice recording associated with this case.
                    </p>
                  </div>
                  <p className="text-xs text-gray-500">
                    Accepted formats: {CVR_EXTENSIONS.map((ext) => ext.replace('.', '').toUpperCase()).join(', ')}
                  </p>
                  <div className="rounded-xl border border-gray-200 p-4 space-y-3">
                    <p className="text-sm font-semibold text-gray-800">General CVR audio (full mix)</p>
                    <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                      Upload file
                      <input
                        type="file"
                        accept={CVR_EXTENSIONS.join(',')}
                        onChange={handleFileChange('cvrGeneral')}
                        className="block w-full text-sm text-gray-700 border border-gray-200 rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-50 file:px-4 file:py-2 file:text-emerald-700"
                      />
                    </label>
                    <p className="text-xs text-gray-500">
                      {cvrGeneralUpload.file
                        ? `Selected file: ${cvrGeneralUpload.file.name} (${formatFileSize(cvrGeneralUpload.file.size)})`
                        : cvrGeneralUpload.existingAttachment
                          ? `Current file: ${cvrGeneralUpload.existingAttachment.name || 'Pending upload'}${cvrGeneralUpload.existingAttachment.size ? ` (${cvrGeneralUpload.existingAttachment.size})` : ''
                          }`
                          : 'No file uploaded yet.'}
                    </p>
                    <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                      Notes
                      <textarea
                        rows={2}
                        value={cvrGeneralUpload.notes}
                        onChange={handleUploadNotesChange('cvrGeneral')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        placeholder="Add helpful reminders about this dataset"
                      />
                    </label>
                  </div>
                  <div className="space-y-4">
                    {cvrChannelUploads.map((channel) => (
                      <div key={channel.channelId} className="rounded-xl border border-gray-200 p-4 space-y-3">
                        <p className="text-sm font-semibold text-gray-800">{channel.label}</p>
                        <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                          Upload file
                          <input
                            type="file"
                            accept={CVR_EXTENSIONS.join(',')}
                            onChange={handleCvrChannelFileChange(channel.channelId)}
                            className="block w-full text-sm text-gray-700 border border-gray-200 rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-50 file:px-4 file:py-2 file:text-emerald-700"
                          />
                        </label>
                        <p className="text-xs text-gray-500">
                          {channel.file
                            ? `Selected file: ${channel.file.name} (${formatFileSize(channel.file.size)})`
                            : channel.existingAttachment
                              ? `Current file: ${channel.existingAttachment.name || 'Pending upload'}${channel.existingAttachment.size ? ` (${channel.existingAttachment.size})` : ''
                              }`
                              : 'No file uploaded yet.'}
                        </p>
                        <label className="text-sm font-medium text-gray-700 flex flex-col gap-2">
                          Notes
                          <textarea
                            rows={2}
                            value={channel.notes}
                            onChange={handleCvrChannelNotesChange(channel.channelId)}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            placeholder="Add helpful reminders about this channel"
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>



          {(localError || errorMessage) && (
            <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
              {localError || errorMessage}
            </p>
          )}

          <div className="flex justify-end gap-3 pb-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              disabled={isSubmitting || isProcessing}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg text-white font-semibold shadow-md"
              style={{ backgroundColor: '#019348' }}
              disabled={isSubmitting || isProcessing}
            >
              {isProcessing
                ? 'Uploading…'
                : isSubmitting
                  ? 'Saving…'
                  : mode === 'edit'
                    ? 'Save Changes'
                    : 'Create Case'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CaseFormModal;
