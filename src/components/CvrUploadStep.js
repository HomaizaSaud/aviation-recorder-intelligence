import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, UploadCloud } from 'lucide-react';
import { updateCase } from '../api/cases';
import { createDownloadTarget } from '../api/storage';
import { uploadAttachmentToObjectStore } from '../utils/storage';
import { deriveCaseStatus, deriveDataStatus } from '../utils/statuses';
import { formatFileSize } from '../utils/files';
import { resolveActor } from '../utils/timeline';
import { useAuth } from '../hooks/useAuth';
import CvrPhaseStepper from './CvrPhaseStepper';

const buildInitialSlots = (cvrChannelOptions) =>
  cvrChannelOptions.map((channel) => ({
    channelId: channel.id,
    label: channel.label,
    file: null,
    notes: '',
    previewUrl: '',
  }));

const CvrUploadStep = ({ caseNumber, caseData, cvrChannelOptions, onUploaded, bannerMessage }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const actor = useMemo(() => resolveActor({ user }), [user]);

  const [slots, setSlots] = useState(() => buildInitialSlots(cvrChannelOptions));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [existingAudioUrls, setExistingAudioUrls] = useState({});
  const previewUrlsRef = useRef(new Set());

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const existingByChannel = useMemo(() => {
    const map = new Map();
    (caseData?.attachments || []).forEach((attachment) => {
      if (String(attachment?.type || '').toUpperCase() === 'CVR') {
        map.set(attachment.channel || 'general', attachment);
      }
    });
    return map;
  }, [caseData]);

  const isEditMode = existingByChannel.size > 0;
  const hasAnyFile = slots.some((slot) => slot.file);

  const loadExistingAudio = async (attachment) => {
    if (!attachment?.storage?.bucket || !attachment?.storage?.objectKey) {
      return;
    }
    const key = attachment.storage.objectKey;
    try {
      const target = await createDownloadTarget({
        bucket: attachment.storage.bucket,
        objectKey: key,
        fileName: attachment.name || 'cvr-audio.wav',
        contentType: attachment.contentType || 'audio/wav',
      });
      setExistingAudioUrls((prev) => ({ ...prev, [key]: target?.downloadUrl || '' }));
    } catch (_error) {
      setExistingAudioUrls((prev) => ({ ...prev, [key]: '' }));
    }
  };

  const handleFileChange = (channelId) => (event) => {
    const file = event.target.files?.[0] || null;
    const previewUrl = file ? URL.createObjectURL(file) : '';
    if (previewUrl) {
      previewUrlsRef.current.add(previewUrl);
    }
    setSlots((prev) =>
      prev.map((slot) => {
        if (slot.channelId !== channelId) {
          return slot;
        }
        if (slot.previewUrl) {
          URL.revokeObjectURL(slot.previewUrl);
          previewUrlsRef.current.delete(slot.previewUrl);
        }
        return { ...slot, file, previewUrl };
      }),
    );
  };

  const handleNotesChange = (channelId) => (event) => {
    const notes = event.target.value;
    setSlots((prev) =>
      prev.map((slot) => (slot.channelId === channelId ? { ...slot, notes } : slot)),
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hasAnyFile && !isEditMode) {
      setSubmitError('Upload at least one audio file (the full mix or an individual channel) to continue.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const uploadedBy = actor?.name || 'Unknown';
      const newAttachments = [];

      for (const slot of slots) {
        if (!slot.file) {
          continue;
        }

        const result = await uploadAttachmentToObjectStore({
          caseNumber,
          attachmentType: 'CVR',
          channel: slot.channelId,
          file: slot.file,
          existingAttachments: [...(caseData.attachments || []), ...newAttachments],
        });

        newAttachments.push({
          type: 'CVR',
          channel: slot.channelId,
          channelLabel: slot.label,
          name: slot.file.name,
          size: formatFileSize(slot.file.size),
          sizeBytes: slot.file.size,
          uploadedBy,
          notes: slot.notes || '',
          status: 'Uploaded',
          storage: result.storage,
          contentType: result.contentType,
          uploadedAt: result.uploadedAt,
          checksum: result.checksum,
        });
      }

      if (newAttachments.length === 0 && isEditMode) {
        // Nothing new chosen; keep existing data as-is and just move on.
        onUploaded(caseData);
        return;
      }

      // Replace any channel that already had an attachment with the newly uploaded one.
      const replacedChannels = new Set(newAttachments.map((item) => item.channel));
      const carriedOverAttachments = (caseData.attachments || []).filter(
        (item) => !(String(item?.type || '').toUpperCase() === 'CVR' && replacedChannels.has(item.channel)),
      );
      const nextAttachments = [...carriedOverAttachments, ...newAttachments];
      const analyses = {
        ...caseData.analyses,
        cvr: {
          status: 'Not Started',
          lastRun: null,
          summary: 'CVR data uploaded and ready for analysis.',
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
      setSubmitError(error.message || 'Unable to upload CVR audio.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <CvrPhaseStepper
        currentPhase="upload"
        onPhaseClick={() => navigate('/cases/cvr', { state: { editCaseNumber: caseNumber } })}
      />
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <UploadCloud className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">
              CVR Module · Step 2 of 4 · {caseNumber}
            </p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">
              {isEditMode ? 'Edit CVR Audio' : 'CVR Upload'}
            </h1>
            <p className="text-gray-600 mt-2">
              {isEditMode
                ? 'This case already has CVR audio. Replace a channel below if needed, or continue as-is.'
                : 'Upload the cockpit voice recorder audio for this case. You can upload the full mix, individual channels, or both.'}
            </p>
          </div>
        </div>

        {bannerMessage && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {bannerMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {slots.map((slot) => {
            const existingAttachment = existingByChannel.get(slot.channelId);
            const existingKey = existingAttachment?.storage?.objectKey;
            const existingUrl = existingKey ? existingAudioUrls[existingKey] : '';

            return (
              <div key={slot.channelId} className="rounded-xl border border-gray-200 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="sm:w-48 shrink-0 min-w-0">
                    <p className="text-sm font-semibold text-gray-800">{slot.label}</p>
                    {slot.file ? (
                      <p className="text-xs text-gray-500 mt-1 truncate" title={slot.file.name}>
                        {slot.file.name} · {formatFileSize(slot.file.size)}
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
                      accept="audio/*"
                      id={`cvr-upload-file-${slot.channelId}`}
                      onChange={handleFileChange(slot.channelId)}
                      className="sr-only"
                    />
                    <label
                      htmlFor={`cvr-upload-file-${slot.channelId}`}
                      className="shrink-0 cursor-pointer rounded-lg bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
                    >
                      {existingAttachment ? 'Replace File' : 'Choose File'}
                    </label>
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-500" title={slot.file?.name || ""}>
                      {slot.file ? slot.file.name : existingAttachment ? existingAttachment.name : "No file chosen"}
                    </span>
                    {!slot.file && existingAttachment && !existingUrl && (
                      <button
                        type="button"
                        onClick={() => loadExistingAudio(existingAttachment)}
                        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                      >
                        Load audio
                      </button>
                    )}
                  </div>
                  <div className="flex-1">
                    <input
                      type="text"
                      value={slot.notes}
                      onChange={handleNotesChange(slot.channelId)}
                      placeholder="Notes (optional)"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    />
                  </div>
                </div>
                {slot.previewUrl && (
                  <audio controls preload="metadata" src={slot.previewUrl} className="w-full" />
                )}
                {!slot.previewUrl && existingUrl && (
                  <audio controls preload="metadata" src={existingUrl} className="w-full" />
                )}
              </div>
            );
          })}

          {submitError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {submitError}
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => navigate('/cases/cvr', { state: { editCaseNumber: caseNumber } })}
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
              {isSubmitting ? 'Saving…' : 'Next: Review'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CvrUploadStep;
