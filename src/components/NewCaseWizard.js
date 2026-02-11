import React, { useMemo, useState } from 'react';
import { Check, UploadCloud, X } from 'lucide-react';
import { formatFileSize } from '../utils/files';
import { uploadAttachmentToObjectStore } from '../utils/storage';
import { deriveCaseStatus, deriveDataStatus } from '../utils/statuses';
import { createTimelineEntry } from '../utils/timeline';

const steps = [
  { title: 'Step 1', subtitle: 'Case Details' },
  { title: 'Step 2', subtitle: 'Investigator' },
  { title: 'Step 3', subtitle: 'Aircraft' },
  { title: 'Step 4', subtitle: 'FDR Upload' },
  { title: 'Step 5', subtitle: 'CVR & Review' },
];

const CVR_CHANNELS = [
  { id: 'channel-1', label: 'Channel 1 – Captain' },
  { id: 'channel-2', label: 'Channel 2 – First Officer' },
  { id: 'channel-3', label: 'Channel 3 – Observer / area' },
  { id: 'channel-4', label: 'Channel 4 – Cockpit area mic (CAM)' },
];

const initialCaseInfo = {
  caseNumber: '',
  caseName: '',
  occurrenceDate: '',
  summary: '',
  tags: '',
};

const initialInvestigator = {
  name: '',
  organization: '',
  phone: '',
  email: '',
  notes: '',
};

const initialAircraft = {
  aircraftNumber: '',
  aircraftType: '',
  operator: '',
  flightNumber: '',
  location: '',
  dateOfFlight: '',
};

const initialUploadState = {
  file: null,
  notes: '',
  willUploadLater: true,
};

const createCvrUploads = () =>
  CVR_CHANNELS.map((channel) => ({
    channelId: channel.id,
    label: channel.label,
    file: null,
    notes: '',
    willUploadLater: true,
  }));

const buildAnalysesState = (hasFdrData, hasCvrData) => ({
  fdr: {
    status: hasFdrData ? 'Not Started' : 'Data Not Uploaded',
    lastRun: null,
    summary: hasFdrData ? 'FDR data uploaded and ready for analysis.' : 'Upload required before analysis can begin.',
  },
  cvr: {
    status: hasCvrData ? 'Not Started' : 'Data Not Uploaded',
    lastRun: null,
    summary: hasCvrData ? 'CVR data uploaded and ready for analysis.' : 'Upload required before analysis can begin.',
  },
  correlate: {
    status: hasFdrData && hasCvrData ? 'Not Started' : 'Blocked',
    lastRun: null,
    summary:
      hasFdrData && hasCvrData
        ? 'Correlation can begin once initial analyses are completed.'
        : 'Requires both FDR and CVR datasets to proceed.',
  },
});

const StepIndicator = ({ currentStep }) => (
  <ol className="grid grid-cols-5 gap-4 mb-10">
    {steps.map((step, index) => {
      const status =
        index < currentStep ? 'complete' : index === currentStep ? 'current' : 'upcoming';

      return (
        <li key={step.title} className="flex flex-col items-center">
          <div
            className={`flex items-center justify-center w-12 h-12 rounded-full border-2 transition-all ${status === 'complete'
                ? 'border-emerald-500 bg-emerald-500 text-white'
                : status === 'current'
                  ? 'border-emerald-500 text-emerald-600 bg-white'
                  : 'border-gray-300 text-gray-400 bg-white'
              }`}
          >
            {status === 'complete' ? <Check className="w-6 h-6" /> : index + 1}
          </div>
          <div className="mt-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {step.title}
            </p>
            <p className="text-sm font-medium text-gray-700">{step.subtitle}</p>
          </div>
        </li>
      );
    })}
  </ol>
);

const TextField = ({ id, label, type = 'text', value, onChange, placeholder, required = false }) => (
  <label className="flex flex-col space-y-1 text-sm font-medium text-gray-700">
    {label}
    <input
      id={id}
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      required={required}
      className="px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
    />
  </label>
);

const TextAreaField = ({ id, label, value, onChange, placeholder }) => (
  <label className="flex flex-col space-y-1 text-sm font-medium text-gray-700">
    {label}
    <textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={4}
      className="px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
    />
  </label>
);

const FileUploadField = ({ id, label, helperText, accept, onChange, file, willUploadLater, onToggleLater, notes, onNotesChange }) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {helperText && <p className="text-xs text-gray-500 mt-1">{helperText}</p>}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={willUploadLater}
          onChange={(event) => onToggleLater(event.target.checked)}
        />
        Upload later
      </label>
    </div>

    <label
      htmlFor={id}
      className={`flex flex-col items-center justify-center w-full border-2 border-dashed rounded-xl py-12 transition-colors ${willUploadLater
          ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
          : 'border-gray-200 bg-gray-50 hover:border-emerald-500 hover:bg-white cursor-pointer'
        }`}
    >
      <UploadCloud className="w-12 h-12 text-emerald-500 mb-3" />
      <p className="text-base font-semibold text-gray-700">
        {file ? file.name : willUploadLater ? 'Upload will be handled later' : 'Drag and drop files here'}
      </p>
      {!willUploadLater && <p className="text-sm text-gray-500 mt-1">or click to browse</p>}
      <input
        id={id}
        type="file"
        accept={accept}
        onChange={(event) => onChange(event.target.files?.[0] || null)}
        className="hidden"
        disabled={willUploadLater}
      />
    </label>

    <TextAreaField
      id={`${id}-notes`}
      label="Notes"
      value={notes}
      onChange={onNotesChange}
      placeholder="Additional context about this data upload"
    />
  </div>
);

const normalizeDate = (value) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().slice(0, 10);
};

const NewCaseWizard = ({ isOpen, onClose, onSubmit, isSubmitting = false, errorMessage = '' }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [caseInfo, setCaseInfo] = useState(() => ({ ...initialCaseInfo }));
  const [investigator, setInvestigator] = useState(() => ({ ...initialInvestigator }));
  const [aircraft, setAircraft] = useState(() => ({ ...initialAircraft }));
  const [fdrUpload, setFdrUpload] = useState(() => ({ ...initialUploadState }));
  const [cvrUploads, setCvrUploads] = useState(() => createCvrUploads());
  const [cvrGeneralUpload, setCvrGeneralUpload] = useState(() => ({
    ...initialUploadState,
    channelId: 'general',
    label: 'General CVR audio (full mix)',
  }));
  const [localError, setLocalError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const resetState = () => {
    setCurrentStep(0);
    setCaseInfo({ ...initialCaseInfo });
    setInvestigator({ ...initialInvestigator });
    setAircraft({ ...initialAircraft });
    setFdrUpload({ ...initialUploadState });
    setCvrUploads(createCvrUploads());
    setCvrGeneralUpload({ ...initialUploadState, channelId: 'general', label: 'General CVR audio (full mix)' });
    setLocalError('');
  };

  const closeWizard = () => {
    resetState();
    onClose();
  };

  React.useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen]);

  const derivedData = useMemo(() => {
    const hasFdrData = Boolean(fdrUpload.file && !fdrUpload.willUploadLater);
    const hasCvrData =
      Boolean(cvrGeneralUpload.file && !cvrGeneralUpload.willUploadLater) ||
      cvrUploads.some(
        (channel) => channel.file && !channel.willUploadLater,
      );

    const analyses = buildAnalysesState(hasFdrData, hasCvrData);

    const attachments = [];
    if (hasFdrData && fdrUpload.file) {
      attachments.push({
        name: fdrUpload.file.name,
        size: formatFileSize(fdrUpload.file.size),
        type: 'FDR',
        uploadedBy: investigator.name || 'Unknown',
        notes: fdrUpload.notes || '',
      });
    } else if (!hasFdrData && fdrUpload.notes) {
      attachments.push({
        name: 'FDR data pending upload',
        size: '',
        type: 'FDR',
        uploadedBy: investigator.name || 'Unknown',
        notes: fdrUpload.notes,
        status: 'Pending',
      });
    }

    if (cvrGeneralUpload.file && !cvrGeneralUpload.willUploadLater) {
      attachments.push({
        name: cvrGeneralUpload.file.name,
        size: formatFileSize(cvrGeneralUpload.file.size),
        type: 'CVR',
        channel: cvrGeneralUpload.channelId,
        channelLabel: cvrGeneralUpload.label,
        uploadedBy: investigator.name || 'Unknown',
        notes: cvrGeneralUpload.notes || '',
      });
    } else if (!cvrGeneralUpload.file && cvrGeneralUpload.notes) {
      attachments.push({
        name: 'CVR data pending upload',
        size: '',
        type: 'CVR',
        channel: cvrGeneralUpload.channelId,
        channelLabel: cvrGeneralUpload.label,
        uploadedBy: investigator.name || 'Unknown',
        notes: cvrGeneralUpload.notes,
        status: 'Pending',
      });
    }

    cvrUploads.forEach((channel) => {
      if (channel.file && !channel.willUploadLater) {
        attachments.push({
          name: channel.file.name,
          size: formatFileSize(channel.file.size),
          type: 'CVR',
          channel: channel.channelId,
          channelLabel: channel.label,
          uploadedBy: investigator.name || 'Unknown',
          notes: channel.notes || '',
        });
      } else if (!channel.file && channel.notes) {
        attachments.push({
          name: 'CVR data pending upload',
          size: '',
          type: 'CVR',
          channel: channel.channelId,
          channelLabel: channel.label,
          uploadedBy: investigator.name || 'Unknown',
          notes: channel.notes,
          status: 'Pending',
        });
      }
    });

    const status = deriveCaseStatus({ analyses });
    const module = deriveDataStatus(attachments);

    return {
      module,
      status,
      analyses,
      attachments,
      hasFdrData,
      hasCvrData,
    };
  }, [cvrUploads, cvrGeneralUpload, fdrUpload, investigator.name]);

  const validateStep = (step) => {
    switch (step) {
      case 0: {
        if (!caseInfo.caseNumber || !caseInfo.caseName) {
          setLocalError('Case number and case name are required.');
          return false;
        }
        setLocalError('');
        return true;
      }
      case 1: {
        if (!investigator.name) {
          setLocalError('Investigator name is required.');
          return false;
        }
        setLocalError('');
        return true;
      }
      case 2:
        setLocalError('');
        return true;
      case 3:
        setLocalError('');
        return true;
      default:
        setLocalError('');
        return true;
    }
  };

  const handleNext = () => {
    if (!validateStep(currentStep)) {
      return;
    }

    setCurrentStep((step) => Math.min(step + 1, steps.length - 1));
  };

  const handleBack = () => {
    setLocalError('');
    setCurrentStep((step) => Math.max(step - 1, 0));
  };

  const buildPayload = ({ attachments, analyses, module, status, timeline }) => {
    const normalizedDate = normalizeDate(caseInfo.occurrenceDate || aircraft.dateOfFlight);
    const tagsArray = caseInfo.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    return {
      caseNumber: caseInfo.caseNumber,
      caseName: caseInfo.caseName,
      owner: investigator.name,
      organization: investigator.organization,
      examiner: investigator.name,
      module,
      status,
      summary: caseInfo.summary,
      lastUpdated: normalizeDate(new Date()),
      date: normalizedDate,
      location: aircraft.location,
      aircraftType: aircraft.aircraftType,
      tags: tagsArray,
      analyses,
      attachments,
      timeline,
      investigator: {
        ...investigator,
      },
      aircraft: {
        ...aircraft,
        dateOfFlight: normalizeDate(aircraft.dateOfFlight),
      },
    };
  };

  const handleSubmit = async () => {
    if (!validateStep(currentStep)) {
      return;
    }

    if (isProcessing) {
      return;
    }

    const attachments = [];
    const uploadedBy = investigator.name || 'Unknown';

    const processUpload = async (uploadState, label, channelId, channelLabel) => {
      const notes = uploadState.notes || '';
      if (uploadState.file && !uploadState.willUploadLater) {
        const result = await uploadAttachmentToObjectStore({
          caseNumber: caseInfo.caseNumber,
          attachmentType: label,
          channel: channelId,
          file: uploadState.file,
          existingAttachments: attachments,
        });

        attachments.push({
          type: label,
          channel: channelId,
          channelLabel: channelLabel || '',
          name: uploadState.file.name,
          size: formatFileSize(uploadState.file.size),
          sizeBytes: uploadState.file.size,
          uploadedBy,
          notes,
          status: 'Uploaded',
          storage: result.storage,
          contentType: result.contentType,
          uploadedAt: result.uploadedAt,
          checksum: result.checksum,
        });

        return true;
      }

      if (notes) {
        attachments.push({
          type: label,
          channel: channelId,
          channelLabel: channelLabel || '',
          name: `${label} data pending upload`,
          size: '',
          uploadedBy,
          notes,
          status: 'Pending',
        });
      }

      return false;
    };

    try {
      setIsProcessing(true);
      setLocalError('');

      const hasFdrData = await processUpload(fdrUpload, 'FDR');
      const cvrGeneral = await processUpload(
        cvrGeneralUpload,
        'CVR',
        cvrGeneralUpload.channelId,
        cvrGeneralUpload.label,
      );
      const cvrResults = await Promise.all(
        cvrUploads.map((channel) =>
          processUpload(channel, 'CVR', channel.channelId, channel.label),
        ),
      );
      const hasCvrData = cvrGeneral || cvrResults.some(Boolean);

      const analyses = buildAnalysesState(hasFdrData, hasCvrData);
      const module = deriveDataStatus(attachments);
      const status = deriveCaseStatus({ analyses });

      const timelineUpdates = [];
      if (hasFdrData) {
        const fdrAttachment = attachments.find(
          (item) => item?.type === 'FDR' && item?.storage?.objectKey,
        );
        if (fdrAttachment) {
          timelineUpdates.push(
            createTimelineEntry({
              kind: 'fdr_upload',
              action: 'FDR data uploaded',
              actor: { name: fdrAttachment.uploadedBy || uploadedBy },
              timestamp: fdrAttachment.uploadedAt,
              metadata: [{ label: 'File', value: fdrAttachment.name }],
              links: {
                resultsUrl: `/cases/${caseInfo.caseNumber}/fdr`,
              },
            }),
          );
        }
      }

      const payload = buildPayload({
        attachments,
        analyses,
        module,
        status,
        timeline: timelineUpdates,
      });

      await onSubmit(payload);
      resetState();
    } catch (error) {
      setLocalError(error.message || 'Unable to create case.');
    } finally {
      setIsProcessing(false);
    }
  };

  const renderCaseDetailsStep = () => (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-gray-800">Case Information</h3>
      <p className="text-sm text-gray-600">
        Provide the core details of the investigation. You can update or enrich these fields later.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TextField
          id="case-number"
          label="Case Number"
          value={caseInfo.caseNumber}
          onChange={(value) => setCaseInfo((prev) => ({ ...prev, caseNumber: value }))}
          placeholder="AAI-UAE-2025-021"
          required
        />
        <TextField
          id="case-name"
          label="Case Name"
          value={caseInfo.caseName}
          onChange={(value) => setCaseInfo((prev) => ({ ...prev, caseName: value }))}
          placeholder="Engine anomaly during climb"
          required
        />
        <TextField
          id="occurrence-date"
          label="Occurrence Date"
          type="date"
          value={caseInfo.occurrenceDate}
          onChange={(value) => setCaseInfo((prev) => ({ ...prev, occurrenceDate: value }))}
        />
        <TextField
          id="case-tags"
          label="Tags"
          value={caseInfo.tags}
          onChange={(value) => setCaseInfo((prev) => ({ ...prev, tags: value }))}
          placeholder="Runway excursion, Weather"
        />
      </div>
      <TextAreaField
        id="case-summary"
        label="Summary"
        value={caseInfo.summary}
        onChange={(value) => setCaseInfo((prev) => ({ ...prev, summary: value }))}
        placeholder="Briefly describe the occurrence, known factors, or urgent follow-up items."
      />
    </div>
  );

  const renderInvestigatorStep = () => (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-gray-800">Investigator Information</h3>
      <p className="text-sm text-gray-600">Tell us who owns this case so we can keep them informed.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TextField
          id="investigator-name"
          label="Name"
          value={investigator.name}
          onChange={(value) => setInvestigator((prev) => ({ ...prev, name: value }))}
          placeholder="Capt. Khalid"
          required
        />
        <TextField
          id="investigator-organization"
          label="Organization"
          value={investigator.organization}
          onChange={(value) => setInvestigator((prev) => ({ ...prev, organization: value }))}
          placeholder="GCAA"
        />
        <TextField
          id="investigator-phone"
          label="Phone"
          value={investigator.phone}
          onChange={(value) => setInvestigator((prev) => ({ ...prev, phone: value }))}
          placeholder="+971-50-123-4567"
        />
        <TextField
          id="investigator-email"
          label="Email"
          type="email"
          value={investigator.email}
          onChange={(value) => setInvestigator((prev) => ({ ...prev, email: value }))}
          placeholder="investigator@gcaa.gov"
        />
      </div>
      <TextAreaField
        id="investigator-notes"
        label="Notes"
        value={investigator.notes}
        onChange={(value) => setInvestigator((prev) => ({ ...prev, notes: value }))}
        placeholder="Additional context for the investigation team"
      />
    </div>
  );

  const renderAircraftStep = () => (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-gray-800">Aircraft Information</h3>
      <p className="text-sm text-gray-600">
        Capture the aircraft details associated with this occurrence.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TextField
          id="aircraft-number"
          label="Aircraft Tail Number"
          value={aircraft.aircraftNumber}
          onChange={(value) => setAircraft((prev) => ({ ...prev, aircraftNumber: value }))}
          placeholder="A6-ADQ"
        />
        <TextField
          id="aircraft-type"
          label="Aircraft Type"
          value={aircraft.aircraftType}
          onChange={(value) => setAircraft((prev) => ({ ...prev, aircraftType: value }))}
          placeholder="Airbus A320"
        />
        <TextField
          id="aircraft-operator"
          label="Operator"
          value={aircraft.operator}
          onChange={(value) => setAircraft((prev) => ({ ...prev, operator: value }))}
          placeholder="Emirates Airlines"
        />
        <TextField
          id="flight-number"
          label="Flight Number"
          value={aircraft.flightNumber}
          onChange={(value) => setAircraft((prev) => ({ ...prev, flightNumber: value }))}
          placeholder="EK204"
        />
        <TextField
          id="aircraft-location"
          label="Location"
          value={aircraft.location}
          onChange={(value) => setAircraft((prev) => ({ ...prev, location: value }))}
          placeholder="Dubai Creek"
        />
        <TextField
          id="date-of-flight"
          label="Date of Flight"
          type="date"
          value={aircraft.dateOfFlight}
          onChange={(value) => setAircraft((prev) => ({ ...prev, dateOfFlight: value }))}
        />
      </div>
    </div>
  );

  const renderFdrStep = () => (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-gray-800">FDR Data Uploading</h3>
      <p className="text-sm text-gray-600">
        Upload the processed FDR dataset when it becomes available. You can opt to upload it later and leave a note for the team.
      </p>
      <FileUploadField
        id="fdr-upload"
        label="Upload the processed FDR CSV"
        helperText="Supported formats: .csv, .xls, .xlsx"
        accept=".csv,.xls,.xlsx"
        file={fdrUpload.file}
        willUploadLater={fdrUpload.willUploadLater}
        onToggleLater={(value) =>
          setFdrUpload((prev) => ({
            ...prev,
            willUploadLater: value,
            file: value ? null : prev.file,
          }))
        }
        onChange={(file) =>
          setFdrUpload((prev) => ({
            ...prev,
            file,
            willUploadLater: !file ? prev.willUploadLater : false,
          }))
        }
        notes={fdrUpload.notes}
        onNotesChange={(value) => setFdrUpload((prev) => ({ ...prev, notes: value }))}
      />
    </div>
  );

  const renderCvrStep = () => {
    const { module, status, analyses } = derivedData;

    return (
      <div className="space-y-6">
        <h3 className="text-xl font-semibold text-gray-800">CVR Upload & Review</h3>
        <p className="text-sm text-gray-600">
          Upload the general CVR audio and/or individual cockpit channels. Before finishing, review the automatically generated case status below.
        </p>
        <div className="space-y-4">
          <FileUploadField
            id="cvr-general-upload"
            label="General CVR audio (full mix)"
            helperText="Supported formats: .wav, .mp3"
            accept=".wav,.mp3"
            file={cvrGeneralUpload.file}
            willUploadLater={cvrGeneralUpload.willUploadLater}
            onToggleLater={(value) =>
              setCvrGeneralUpload((prev) => ({
                ...prev,
                willUploadLater: value,
                file: value ? null : prev.file,
              }))
            }
            onChange={(file) =>
              setCvrGeneralUpload((prev) => ({
                ...prev,
                file,
                willUploadLater: !file ? prev.willUploadLater : false,
              }))
            }
            notes={cvrGeneralUpload.notes}
            onNotesChange={(value) => setCvrGeneralUpload((prev) => ({ ...prev, notes: value }))}
          />
          {cvrUploads.map((channel) => (
            <FileUploadField
              key={channel.channelId}
              id={`cvr-${channel.channelId}`}
              label={channel.label}
              helperText="Supported formats: .wav, .mp3"
              accept=".wav,.mp3"
              file={channel.file}
              willUploadLater={channel.willUploadLater}
              onToggleLater={(value) =>
                setCvrUploads((prev) =>
                  prev.map((entry) =>
                    entry.channelId === channel.channelId
                      ? { ...entry, willUploadLater: value, file: value ? null : entry.file }
                      : entry,
                  ),
                )
              }
              onChange={(file) =>
                setCvrUploads((prev) =>
                  prev.map((entry) =>
                    entry.channelId === channel.channelId
                      ? { ...entry, file, willUploadLater: !file ? entry.willUploadLater : false }
                      : entry,
                  ),
                )
              }
              notes={channel.notes}
              onNotesChange={(value) =>
                setCvrUploads((prev) =>
                  prev.map((entry) =>
                    entry.channelId === channel.channelId ? { ...entry, notes: value } : entry,
                  ),
                )
              }
            />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-4">
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Overall Status</p>
            <p className="mt-2 text-lg font-semibold text-emerald-900">{status}</p>
            <p className="mt-1 text-sm text-emerald-700">Data uploaded: {module}</p>
          </div>
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-800">FDR</p>
            <p className="mt-1 text-sm text-gray-600">{analyses.fdr.status}</p>
            <p className="mt-2 text-xs text-gray-500">{analyses.fdr.summary}</p>
          </div>
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-800">CVR</p>
            <p className="mt-1 text-sm text-gray-600">{analyses.cvr.status}</p>
            <p className="mt-2 text-xs text-gray-500">{analyses.cvr.summary}</p>
          </div>
          <div className="rounded-xl border border-gray-200 p-4 lg:col-span-3">
            <p className="text-sm font-semibold text-gray-800">Correlation</p>
            <p className="mt-1 text-sm text-gray-600">{analyses.correlate.status}</p>
            <p className="mt-2 text-xs text-gray-500">{analyses.correlate.summary}</p>
          </div>
        </div>

        {(localError || errorMessage) && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
            {localError || errorMessage}
          </p>
        )}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleBack}
            className="px-5 py-3 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
            disabled={isSubmitting || isProcessing}
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="px-6 py-3 rounded-lg font-semibold text-white shadow-md"
            style={{ backgroundColor: '#019348' }}
            disabled={isSubmitting || isProcessing}
          >
            {isProcessing ? 'Uploading…' : isSubmitting ? 'Creating…' : 'Create Case'}
          </button>
        </div>
      </div>
    );
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return renderCaseDetailsStep();
      case 1:
        return renderInvestigatorStep();
      case 2:
        return renderAircraftStep();
      case 3:
        return renderFdrStep();
      default:
        return renderCvrStep();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 py-10 overflow-y-auto">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl p-6 md:p-10 relative max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={closeWizard}
          className="absolute right-6 top-6 text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="mb-10 pr-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Start New Case</h2>
          <p className="text-gray-600">
            Follow the guided steps to capture the investigation context. Data uploads can be deferred — the case will be
            marked as incomplete until everything is available.
          </p>
        </div>

        <StepIndicator currentStep={currentStep} />

        {currentStep < steps.length - 1 && (localError || (!localError && currentStep < 3 && errorMessage)) && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-4">
            {localError || errorMessage}
          </p>
        )}

        {renderStepContent()}

        {currentStep < steps.length - 1 && (
          <div className="flex items-center justify-between mt-10">
            <button
              type="button"
              onClick={handleBack}
              disabled={currentStep === 0}
              className={`px-5 py-3 rounded-lg border font-medium transition-colors ${currentStep === 0
                  ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
            >
              Back
            </button>

            <button
              type="button"
              onClick={handleNext}
              className="px-6 py-3 rounded-lg font-semibold text-white shadow-md"
              style={{ backgroundColor: '#019348' }}
            >
              Next Step
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default NewCaseWizard;
