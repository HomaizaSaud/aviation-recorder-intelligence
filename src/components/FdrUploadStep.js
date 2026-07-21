import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, UploadCloud } from 'lucide-react';
import { updateCase } from '../api/cases';
import { createDownloadTarget } from '../api/storage';
import { uploadAttachmentToObjectStore } from '../utils/storage';
import { deriveCaseStatus, deriveDataStatus } from '../utils/statuses';
import { formatFileSize } from '../utils/files';
import { resolveActor } from '../utils/timeline';
import { useAuth } from '../hooks/useAuth';
import FdrPhaseStepper from './FdrPhaseStepper';

const FdrUploadStep = ({ caseNumber, caseData, onUploaded, bannerMessage }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const actor = useMemo(() => resolveActor({ user }), [user]);

  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [existingAudioUrl, setExistingAudioUrl] = useState('');
  const [isLoadingExisting, setIsLoadingExisting] = useState(false);

  const existingAttachment = useMemo(
    () => (caseData?.attachments || []).find((item) => String(item?.type || '').toUpperCase() === 'FDR'),
    [caseData],
  );
  const isEditMode = Boolean(existingAttachment);

  const handleLoadExisting = async () => {
    if (!existingAttachment?.storage?.bucket || !existingAttachment?.storage?.objectKey) {
      return;
    }
    setIsLoadingExisting(true);
    try {
      const target = await createDownloadTarget({
        bucket: existingAttachment.storage.bucket,
        objectKey: existingAttachment.storage.objectKey,
        fileName: existingAttachment.name || 'fdr-data.csv',
        contentType: existingAttachment.contentType || 'text/csv',
      });
      setExistingAudioUrl(target?.downloadUrl || '');
    } catch (_error) {
      setExistingAudioUrl('');
    } finally {
      setIsLoadingExisting(false);
    }
  };

  const handleFileChange = (event) => {
    setFile(event.target.files?.[0] || null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!file && !isEditMode) {
      setSubmitError('Upload the processed FDR data file to continue.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      if (!file && isEditMode) {
        // Nothing new chosen; keep existing data as-is and just move on.
        onUploaded(caseData);
        return;
      }

      const uploadedBy = actor?.name || 'Unknown';
      const result = await uploadAttachmentToObjectStore({
        caseNumber,
        attachmentType: 'FDR',
        file,
        existingAttachments: caseData.attachments || [],
      });

      const newAttachment = {
        type: 'FDR',
        name: file.name,
        size: formatFileSize(file.size),
        sizeBytes: file.size,
        uploadedBy,
        notes: notes || '',
        status: 'Uploaded',
        storage: result.storage,
        contentType: result.contentType,
        uploadedAt: result.uploadedAt,
        checksum: result.checksum,
      };

      const carriedOverAttachments = (caseData.attachments || []).filter(
        (item) => String(item?.type || '').toUpperCase() !== 'FDR',
      );
      const nextAttachments = [...carriedOverAttachments, newAttachment];
      const analyses = {
        ...caseData.analyses,
        fdr: {
          status: 'Not Started',
          lastRun: null,
          summary: 'FDR data uploaded and ready for analysis.',
        },
      };
      const module = deriveDataStatus(nextAttachments);
      const status = deriveCaseStatus({ ...caseData, attachments: nextAttachments, analyses });

      const updated = await updateCase(caseNumber, {
        ...caseData,
        attachments: nextAttachments,
        analyses,
        module,
        status,
      });

      onUploaded(updated);
    } catch (error) {
      setSubmitError(error.message || 'Unable to upload FDR data.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <FdrPhaseStepper
        currentPhase="upload"
        onPhaseClick={() => navigate('/cases/fdr', { state: { editCaseNumber: caseNumber } })}
      />
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <UploadCloud className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">
              FDR Module · Step 2 of 6 · {caseNumber}
            </p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">
              {isEditMode ? 'Edit FDR Data' : 'FDR Upload'}
            </h1>
            <p className="text-gray-600 mt-2">
              {isEditMode
                ? 'This case already has FDR data. Replace the file below if needed, or continue as-is.'
                : 'Upload the processed flight data recorder file for this case (CSV, XLS, or XLSX).'}
            </p>
          </div>
        </div>

        {bannerMessage && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {bannerMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="sm:w-48 shrink-0 min-w-0">
                <p className="text-sm font-semibold text-gray-800">FDR data file</p>
                {file ? (
                  <p className="text-xs text-gray-500 mt-1 truncate" title={file.name}>
                    {file.name} · {formatFileSize(file.size)}
                  </p>
                ) : existingAttachment ? (
                  <p className="text-xs text-emerald-600 mt-1 truncate" title={existingAttachment.name}>
                    Uploaded: {existingAttachment.name}
                  </p>
                ) : null}
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-3">
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  id="fdr-upload-file"
                  onChange={handleFileChange}
                  className="sr-only"
                />
                <label
                  htmlFor="fdr-upload-file"
                  className="shrink-0 cursor-pointer rounded-lg bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  {existingAttachment ? 'Replace File' : 'Choose File'}
                </label>
                <span className="min-w-0 flex-1 truncate text-sm text-gray-500" title={file?.name || ''}>
                  {file ? file.name : existingAttachment ? existingAttachment.name : 'No file chosen'}
                </span>
                {!file && existingAttachment && !existingAudioUrl && (
                  <button
                    type="button"
                    onClick={handleLoadExisting}
                    disabled={isLoadingExisting}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    {isLoadingExisting ? 'Loading…' : 'Get download link'}
                  </button>
                )}
                {existingAudioUrl && (
                  <a
                    href={existingAudioUrl}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    Download current file
                  </a>
                )}
              </div>
              <div className="flex-1">
                <input
                  type="text"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Notes (optional)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                />
              </div>
            </div>
          </div>

          {submitError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {submitError}
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => navigate('/cases/fdr', { state: { editCaseNumber: caseNumber } })}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
            >
              {isSubmitting ? 'Saving…' : 'Next: Data Analysis'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default FdrUploadStep;
