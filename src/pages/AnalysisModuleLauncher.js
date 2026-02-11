import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AudioLines, ArrowLeft, ArrowRight, Info, PlaneTakeoff, Workflow } from 'lucide-react';
import { fetchCases } from '../api/cases';
import { buildCasePreview } from '../utils/caseDisplay';
import {
  describeModuleRequirement,
  evaluateModuleReadiness,
  getModuleTitle,
} from '../utils/analysisAvailability';

const moduleConfig = {
  fdr: {
    icon: PlaneTakeoff,
    heading: 'Select a case for FDR analysis',
    description:
      'Choose an investigation to open the Flight Data Recorder module. You can only continue with cases that include uploaded FDR datasets.',
  },
  cvr: {
    icon: AudioLines,
    heading: 'Select a case for CVR analysis',
    description:
      'Choose an investigation to open the Cockpit Voice Recorder module. You can only continue with cases that include uploaded CVR datasets.',
  },
  correlate: {
    icon: Workflow,
    heading: 'Select a case to correlate FDR & CVR',
    description:
      'Choose an investigation to run the correlation workflow. This module requires both FDR and CVR datasets for the selected case.',
  },
};

const buildOptionLabel = (caseItem, readinessLabel) =>
  `${caseItem.caseNumber} — ${caseItem.caseName}${readinessLabel ? ` (${readinessLabel})` : ''}`;

const readinessLabel = (evaluation) => (evaluation.ready ? 'Ready' : 'Missing data');

const AnalysisModuleLauncher = ({ moduleKey }) => {
  const normalizedModuleKey = moduleKey?.toLowerCase() || 'fdr';
  const config = moduleConfig[normalizedModuleKey] || moduleConfig.fdr;
  const Icon = config.icon;
  const navigate = useNavigate();
  const location = useLocation();
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedCaseNumber, setSelectedCaseNumber] = useState('');
  const [validationMessage, setValidationMessage] = useState('');
  const [preselectedCase, setPreselectedCase] = useState(location.state?.attemptedCase || '');

  const requirement = describeModuleRequirement(normalizedModuleKey);
  const moduleTitle = getModuleTitle(normalizedModuleKey);

  useEffect(() => {
    if (location.state?.analysisError) {
      setValidationMessage(location.state.analysisError);
    }

    if (location.state?.attemptedCase) {
      setPreselectedCase(location.state.attemptedCase);
    }

    if (location.state) {
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location, navigate]);

  useEffect(() => {
    let isMounted = true;

    const loadCases = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const response = await fetchCases();
        if (!isMounted) {
          return;
        }

        const data = Array.isArray(response) ? response : response?.data;
        setCases(Array.isArray(data) ? data : []);
      } catch (error) {
        if (isMounted) {
          setLoadError(error.message || 'Unable to load cases');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadCases();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!preselectedCase || cases.length === 0) {
      return;
    }

    const exists = cases.some((item) => item.caseNumber === preselectedCase);
    if (exists) {
      setSelectedCaseNumber(preselectedCase);
    }
  }, [cases, preselectedCase]);

  const casesWithReadiness = useMemo(
    () =>
      cases.map((caseItem) => ({
        data: caseItem,
        preview: buildCasePreview(caseItem),
        evaluation: evaluateModuleReadiness(caseItem, normalizedModuleKey),
      })),
    [cases, normalizedModuleKey],
  );

  const selectedCaseEntry = useMemo(
    () => casesWithReadiness.find((item) => item.data.caseNumber === selectedCaseNumber) || null,
    [casesWithReadiness, selectedCaseNumber],
  );

  useEffect(() => {
    if (selectedCaseNumber) {
      setValidationMessage('');
    }
  }, [selectedCaseNumber]);

  const handleContinue = () => {
    if (!selectedCaseEntry) {
      setValidationMessage('Please choose a case before continuing.');
      return;
    }

    const { evaluation, data } = selectedCaseEntry;
    if (!evaluation.ready) {
      setValidationMessage(evaluation.message);
      return;
    }

    navigate(`/cases/${data.caseNumber}/${normalizedModuleKey}`);
  };

  const handleUploadMissingData = () => {
    if (!selectedCaseEntry) {
      return;
    }

    navigate('/cases', {
      state: {
        editCaseNumber: selectedCaseEntry.data.caseNumber,
        focusUpload: normalizedModuleKey === 'fdr' ? 'fdr' : 'cvr',
        attemptedCase: selectedCaseEntry.data.caseNumber,
      },
    });
  };

  const canOfferUpload =
    Boolean(selectedCaseEntry) && !selectedCaseEntry.evaluation.ready;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <button
        type="button"
        onClick={() => navigate('/cases')}
        className="inline-flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Cases
      </button>

      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <Icon className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">{moduleTitle}</p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">{config.heading}</h1>
            <p className="text-gray-600 mt-2">{config.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          <Info className="w-4 h-4" />
          <span>{requirement}</span>
        </div>

        {loadError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{loadError}</div>
        )}

        {!loadError && (
          <div className="space-y-4">
            <label htmlFor="case-selection" className="block text-sm font-medium text-gray-700">
              Choose a case
            </label>
            <select
              id="case-selection"
              value={selectedCaseNumber}
              onChange={(event) => setSelectedCaseNumber(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              <option value="" disabled>
                {loading ? 'Loading cases…' : 'Select a case number'}
              </option>
              {casesWithReadiness.map(({ data, evaluation }) => (
                <option key={data.caseNumber} value={data.caseNumber}>
                  {buildOptionLabel(data, readinessLabel(evaluation))}
                </option>
              ))}
            </select>

            {loading && casesWithReadiness.length === 0 && (
              <p className="text-sm text-gray-500">Loading available cases…</p>
            )}

            {!loading && casesWithReadiness.length === 0 && (
              <p className="text-sm text-gray-500">
                No cases are available yet. Create a case to begin analysis.
              </p>
            )}

            {selectedCaseEntry && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-5 space-y-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold text-gray-800">{selectedCaseEntry.data.caseName}</p>
                  <span className="text-xs text-gray-500">{selectedCaseEntry.data.caseNumber}</span>
                </div>
                <p className="text-sm text-gray-600">{selectedCaseEntry.preview?.summary}</p>
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                      selectedCaseEntry.evaluation.ready
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-current" />
                    {selectedCaseEntry.evaluation.ready ? 'Data ready' : 'Data missing'}
                  </span>
                  {!selectedCaseEntry.evaluation.ready && (
                    <span className="text-xs text-amber-700">{selectedCaseEntry.evaluation.message}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {validationMessage && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {validationMessage}
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate('/cases')}
            className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-emerald-600"
          >
            Browse all cases
          </button>
          <div className="flex flex-wrap items-center gap-3">
            {canOfferUpload && (
              <button
                type="button"
                onClick={handleUploadMissingData}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
              >
                Upload missing audio
              </button>
            )}
            <button
              type="button"
              onClick={handleContinue}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalysisModuleLauncher;
