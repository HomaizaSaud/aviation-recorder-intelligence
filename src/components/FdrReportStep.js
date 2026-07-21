import React, { useState } from 'react';
import { ArrowLeft, Download, FileText } from 'lucide-react';
import { generateReportExport } from '../api/report-exports';
import FdrWizardStepper from './FdrWizardStepper';

const formatGeneratedDate = () =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());

const SEVERITY_LABEL = { high: 'High', med: 'Medium', low: 'Low' };

const FdrReportStep = ({
  caseNumber,
  selectedCase,
  fdrReportData,
  corrections = [],
  investigatorName,
  maxReachableStep,
  onStepClick,
  onBack,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  const source = selectedCase?.source || {};
  const fdrRunId =
    source?.fdrAnalysisLatestRun?.runId || source?.fdrLatestRunId || source?.fdrLastRunId || null;

  const handleDownload = async () => {
    if (!caseNumber) {
      return;
    }
    setIsGenerating(true);
    setGenerateError('');
    try {
      const result = await generateReportExport(caseNumber, {
        format: 'pdf',
        selected_sections: ['fdr'],
        fdr_run_id: fdrRunId,
        fdr_report_data: fdrReportData,
      });

      if (result.type === 'pdf') {
        const fileName = result.fileName || `${caseNumber}_FDR_Analysis_Report.pdf`;
        const url = window.URL.createObjectURL(result.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      } else {
        setGenerateError('The report could not be generated as a PDF.');
      }
    } catch (error) {
      setGenerateError(error.message || 'Unable to generate the FDR analysis report.');
    } finally {
      setIsGenerating(false);
    }
  };

  if (!fdrReportData) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <FdrWizardStepper currentStep={6} maxReachableStep={maxReachableStep} onStepClick={onStepClick} />
        <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 text-center space-y-4">
          <h1 className="text-2xl font-bold text-gray-900">Report unavailable</h1>
          <p className="text-sm text-gray-600">Run anomaly detection for this case to generate the FDR analysis report.</p>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
      </div>
    );
  }

  const { flightSummary, anomalySummary, topFindings, phaseBreakdown } = fdrReportData;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <FdrWizardStepper currentStep={6} maxReachableStep={maxReachableStep} onStepClick={onStepClick} />

      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">
              FDR Module · Step 6 of 6 · {caseNumber}
            </p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">FDR Analysis Report</h1>
            <p className="text-gray-600 mt-2">
              Review the summary below, then download the investigator-ready PDF report for this case.
            </p>
          </div>
        </div>

        <section className="rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Flight Summary</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs text-gray-500">Duration</p>
              <p className="text-sm font-semibold text-gray-900">{flightSummary?.durationLabel || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Max altitude</p>
              <p className="text-sm font-semibold text-gray-900">{flightSummary?.maxAltitudeLabel || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Phases detected</p>
              <p className="text-sm font-semibold text-gray-900">
                {flightSummary?.phasesDetected?.length ? flightSummary.phasesDetected.join(', ') : '—'}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Anomaly Summary</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">Total findings</p>
              <p className="text-xl font-semibold text-gray-900">{anomalySummary?.total ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">High</p>
              <p className="text-xl font-semibold text-red-600">{anomalySummary?.high ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Medium</p>
              <p className="text-xl font-semibold text-amber-600">{anomalySummary?.med ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Low</p>
              <p className="text-xl font-semibold text-blue-600">{anomalySummary?.low ?? 0}</p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Top 5 Findings</h2>
          {topFindings?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-400">
                  <tr>
                    <th className="pb-2 pr-4">Parameter</th>
                    <th className="pb-2 pr-4">Deviation</th>
                    <th className="pb-2 pr-4">Phase</th>
                    <th className="pb-2">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {topFindings.map((finding, index) => (
                    <tr key={`${finding.parameter}-${index}`}>
                      <td className="py-2 pr-4 font-medium text-gray-800">{finding.parameter}</td>
                      <td className="py-2 pr-4 text-gray-600">{finding.deviation}</td>
                      <td className="py-2 pr-4 text-gray-600">{finding.phase}</td>
                      <td className="py-2 text-gray-600">{finding.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No findings recorded for this run.</p>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Phase Breakdown</h2>
          {phaseBreakdown?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-400">
                  <tr>
                    <th className="pb-2 pr-4">Phase</th>
                    <th className="pb-2 pr-4">Rows</th>
                    <th className="pb-2 pr-4">Segments</th>
                    <th className="pb-2">Worst severity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {phaseBreakdown.map((row) => (
                    <tr key={row.phase}>
                      <td className="py-2 pr-4 font-medium text-gray-800">{row.phase}</td>
                      <td className="py-2 pr-4 text-gray-600">{row.n_rows ?? '—'}</td>
                      <td className="py-2 pr-4 text-gray-600">{row.segments_found ?? 0}</td>
                      <td className="py-2 text-gray-600">
                        {SEVERITY_LABEL[row.worst_severity] || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No phase breakdown available for this run.</p>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
            Investigator Corrections Log
          </h2>
          {corrections.length ? (
            <ul className="space-y-1 text-sm text-gray-700">
              {corrections.map((correction) => (
                <li key={correction.id} className="flex items-center justify-between">
                  <span>
                    {correction.type.replace(/_/g, ' ')} — {correction.investigator}
                  </span>
                  <span className="text-xs text-gray-400">
                    {new Date(correction.timestamp).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">No corrections logged.</p>
          )}
        </section>

        <div className="rounded-xl border border-dashed border-gray-200 p-5 text-sm text-gray-500 space-y-1">
          <p>Generated: {formatGeneratedDate()}</p>
          <p>Investigator Signature: {investigatorName || '______________________'}</p>
        </div>

        {generateError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {generateError}
          </div>
        )}

        <div className="flex justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={isGenerating}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
          >
            <Download className="w-4 h-4" />
            {isGenerating ? 'Generating…' : 'Download PDF Report'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FdrReportStep;
