import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ClipboardCheck } from 'lucide-react';
import { createDownloadTarget } from '../api/storage';
import CvrPhaseStepper from './CvrPhaseStepper';

const CvrReviewStep = ({ caseNumber, caseData, onBack, onConfirm }) => {
  const navigate = useNavigate();
  const [audioUrls, setAudioUrls] = useState({});
  const [isConfirming, setIsConfirming] = useState(false);

  const investigator = caseData?.investigator || {};
  const aircraft = caseData?.aircraft || {};
  const cvrAttachments = useMemo(
    () => (Array.isArray(caseData?.attachments) ? caseData.attachments : []).filter(
      (item) => String(item?.type || '').toUpperCase() === 'CVR',
    ),
    [caseData],
  );

  const loadAttachmentAudio = async (attachment) => {
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
      setAudioUrls((prev) => ({ ...prev, [key]: target?.downloadUrl || '' }));
    } catch (_error) {
      setAudioUrls((prev) => ({ ...prev, [key]: '' }));
    }
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <CvrPhaseStepper
        currentPhase="review"
        onPhaseClick={(key) => {
          if (key === 'details') {
            navigate('/cases/cvr', { state: { editCaseNumber: caseNumber } });
          } else if (key === 'upload') {
            onBack();
          }
        }}
      />
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <ClipboardCheck className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">
              CVR Module · Step 3 of 4 · {caseNumber}
            </p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">Review</h1>
            <p className="text-gray-600 mt-2">
              Confirm the case details and uploaded audio below before starting analysis.
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Case number</p>
            <p className="text-sm font-medium text-gray-800">{caseData?.caseNumber || '—'}</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Case name</p>
            <p className="text-sm font-medium text-gray-800">{caseData?.caseName || '—'}</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Investigator</p>
            <p className="text-sm font-medium text-gray-800">
              {investigator.name || '—'}
              {investigator.organization ? ` · ${investigator.organization}` : ''}
            </p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Aircraft</p>
            <p className="text-sm font-medium text-gray-800">
              {aircraft.aircraftType || caseData?.aircraftType || '—'}
              {aircraft.aircraftNumber ? ` · ${aircraft.aircraftNumber}` : ''}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-3">
          <p className="text-sm font-semibold text-gray-900">
            Uploaded CVR audio ({cvrAttachments.length})
          </p>
          {cvrAttachments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
              No CVR audio uploads found for this case.
            </div>
          ) : (
            <div className="space-y-3">
              {cvrAttachments.map((attachment) => {
                const key = attachment.storage?.objectKey;
                const url = key ? audioUrls[key] : '';
                return (
                  <div key={attachment.id || key} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{attachment.name || 'CVR audio'}</p>
                        <p className="text-xs text-gray-500">{attachment.channelLabel || attachment.channel || 'Mix'}</p>
                      </div>
                      {!url ? (
                        <button
                          type="button"
                          onClick={() => loadAttachmentAudio(attachment)}
                          className="inline-flex items-center gap-2 rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          Load audio
                        </button>
                      ) : null}
                    </div>
                    {url && (
                      <audio controls preload="none" src={url} className="mt-3 w-full rounded-xl border border-gray-200" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to CVR Upload
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirming}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
          >
            {isConfirming ? 'Continuing…' : 'Confirm & Continue to Analysis'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CvrReviewStep;
