import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, PlaneTakeoff } from 'lucide-react';
import { createCase, fetchCaseByNumber, fetchCases, updateCase } from '../api/cases';
import { getCaseDataAvailability } from '../utils/analysisAvailability';
import { deriveCaseModuleDisplayStatuses, deriveCaseStatus, deriveDataStatus } from '../utils/statuses';
import { resolveActor } from '../utils/timeline';
import { useAuth } from '../hooks/useAuth';
import FdrPhaseStepper from './FdrPhaseStepper';

const initialCaseInfo = {
  caseNumber: '',
  caseName: '',
  occurrenceDate: '',
  summary: '',
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

const buildCreatePayload = ({ caseInfo, investigator, aircraft }) => {
  const analyses = {
    fdr: { status: 'Data Not Uploaded', lastRun: null, summary: 'Upload required before analysis can begin.' },
    cvr: { status: 'Data Not Uploaded', lastRun: null, summary: 'Upload required before analysis can begin.' },
    correlate: { status: 'Blocked', lastRun: null, summary: 'Requires both FDR and CVR datasets to proceed.' },
  };

  return {
    caseNumber: caseInfo.caseNumber,
    caseName: caseInfo.caseName,
    owner: investigator.name,
    organization: investigator.organization,
    examiner: investigator.name,
    module: deriveDataStatus([]),
    status: deriveCaseStatus({ analyses }),
    summary: caseInfo.summary,
    date: caseInfo.occurrenceDate,
    location: aircraft.location,
    aircraftType: aircraft.aircraftType,
    analyses,
    attachments: [],
    timeline: [],
    investigator: { ...investigator },
    aircraft: { ...aircraft },
  };
};

const FdrCaseDetailsStep = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const actor = useMemo(() => resolveActor({ user }), [user]);

  const editCaseNumber = location.state?.editCaseNumber || '';
  const [mode, setMode] = useState('create');
  const [editingCase, setEditingCase] = useState(null);
  const [isLoadingEdit, setIsLoadingEdit] = useState(Boolean(editCaseNumber));
  const [loadEditError, setLoadEditError] = useState('');

  const [caseInfo, setCaseInfo] = useState(initialCaseInfo);
  const [investigator, setInvestigator] = useState(initialInvestigator);
  const [aircraft, setAircraft] = useState(initialAircraft);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    if (actor?.name && actor.name !== 'Unknown' && !investigator.name && !editCaseNumber) {
      setInvestigator((prev) => ({ ...prev, name: actor.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, investigator.name]);

  useEffect(() => {
    if (!editCaseNumber) {
      return;
    }

    let isMounted = true;
    setIsLoadingEdit(true);
    setLoadEditError('');

    fetchCaseByNumber(editCaseNumber)
      .then((data) => {
        if (!isMounted) {
          return;
        }
        setEditingCase(data);
        setCaseInfo({
          caseNumber: data.caseNumber || '',
          caseName: data.caseName || '',
          occurrenceDate: (data.date || '').slice(0, 10),
          summary: data.summary || '',
        });
        setInvestigator({ ...initialInvestigator, ...(data.investigator || {}) });
        setAircraft({ ...initialAircraft, ...(data.aircraft || {}) });
      })
      .catch((error) => {
        if (isMounted) {
          setLoadEditError(error.message || 'Unable to load case details');
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingEdit(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [editCaseNumber]);

  const [existingCases, setExistingCases] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [loadExistingError, setLoadExistingError] = useState('');
  const [selectedExistingCaseNumber, setSelectedExistingCaseNumber] = useState('');

  useEffect(() => {
    let isMounted = true;

    const loadCases = async () => {
      setLoadingExisting(true);
      setLoadExistingError('');
      try {
        const response = await fetchCases({ pageSize: 200 });
        if (!isMounted) {
          return;
        }
        const data = Array.isArray(response) ? response : response?.data;
        setExistingCases(Array.isArray(data) ? data : []);
      } catch (error) {
        if (isMounted) {
          setLoadExistingError(error.message || 'Unable to load cases');
        }
      } finally {
        if (isMounted) {
          setLoadingExisting(false);
        }
      }
    };

    loadCases();

    return () => {
      isMounted = false;
    };
  }, []);

  const buildOption = (item) => {
    const { fdrDisplayStatus, cvrDisplayStatus } = deriveCaseModuleDisplayStatuses(item);
    return {
      caseNumber: item.caseNumber,
      caseName: item.caseName,
      fdrLabel: fdrDisplayStatus.label,
      cvrLabel: cvrDisplayStatus.label,
    };
  };

  const casesForCvrAttach = useMemo(
    () =>
      existingCases
        .filter((item) => {
          const availability = getCaseDataAvailability(item);
          return availability.hasCvr && !availability.hasFdr;
        })
        .map(buildOption),
    [existingCases],
  );

  const casesForFdrResume = useMemo(
    () =>
      existingCases
        .filter((item) => getCaseDataAvailability(item).hasFdr)
        .map(buildOption),
    [existingCases],
  );

  const handleCaseInfoChange = (field) => (event) => {
    setCaseInfo((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleInvestigatorChange = (field) => (event) => {
    setInvestigator((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleAircraftChange = (field) => (event) => {
    setAircraft((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleCreateSubmit = async (event) => {
    event.preventDefault();
    if (!caseInfo.caseNumber.trim() || !caseInfo.caseName.trim() || !investigator.name.trim()) {
      setCreateError('Case number, case name, and investigator name are required.');
      return;
    }

    setIsSubmitting(true);
    setCreateError('');
    try {
      const payload = buildCreatePayload({ caseInfo, investigator, aircraft });
      const created = await createCase(payload);
      navigate(`/cases/${created.caseNumber}/fdr`, { state: { viaCaseDetailsFlow: true } });
    } catch (error) {
      setCreateError(error.message || 'Unable to create case');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    if (!caseInfo.caseName.trim() || !investigator.name.trim()) {
      setCreateError('Case name and investigator name are required.');
      return;
    }

    setIsSubmitting(true);
    setCreateError('');
    try {
      await updateCase(editCaseNumber, {
        ...editingCase,
        caseName: caseInfo.caseName,
        owner: investigator.name,
        organization: investigator.organization,
        examiner: investigator.name,
        summary: caseInfo.summary,
        date: caseInfo.occurrenceDate,
        location: aircraft.location,
        aircraftType: aircraft.aircraftType,
        investigator: { ...investigator },
        aircraft: { ...aircraft },
      });
      navigate(`/cases/${editCaseNumber}/fdr`, { state: { viaCaseDetailsFlow: true } });
    } catch (error) {
      setCreateError(error.message || 'Unable to save case details');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelEdit = () => {
    navigate(`/cases/${editCaseNumber}/fdr`, { state: { viaCaseDetailsFlow: true } });
  };

  const handleAttachExisting = () => {
    if (!selectedExistingCaseNumber) {
      return;
    }
    navigate(`/cases/${selectedExistingCaseNumber}/fdr`, { state: { viaCaseDetailsFlow: true } });
  };

  const handleModeChange = (nextMode) => {
    setMode(nextMode);
    setSelectedExistingCaseNumber('');
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <FdrPhaseStepper currentPhase="details" />
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <PlaneTakeoff className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-600 uppercase tracking-wide">FDR Module · Step 1 of 6</p>
            <h1 className="text-3xl font-bold text-gray-900 mt-1">
              {editCaseNumber ? 'Edit Case Details' : 'Case Details'}
            </h1>
            <p className="text-gray-600 mt-2">
              {editCaseNumber
                ? `Update the details for ${editCaseNumber}, then continue back to where you left off.`
                : 'Start a flight data recorder analysis by creating a new case, adding FDR to a case already created for CVR, or resuming an FDR case already in progress.'}
            </p>
          </div>
        </div>

        {editCaseNumber && loadEditError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadEditError}
          </div>
        )}

        {editCaseNumber && isLoadingEdit && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
            Loading case details…
          </div>
        )}

        {!editCaseNumber && (
        <div className="inline-flex flex-wrap rounded-xl border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            onClick={() => handleModeChange('create')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              mode === 'create' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Create new case
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('attachCvr')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              mode === 'attachCvr' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Create FDR for existing CVR case
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('loadFdr')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              mode === 'loadFdr' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Load existing FDR case
          </button>
        </div>
        )}

        {(editCaseNumber ? !isLoadingEdit && !loadEditError : mode === 'create') && (
          <form onSubmit={editCaseNumber ? handleEditSubmit : handleCreateSubmit} className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-case-number">
                  Case number
                </label>
                <input
                  id="fdr-case-number"
                  type="text"
                  value={caseInfo.caseNumber}
                  onChange={handleCaseInfoChange('caseNumber')}
                  disabled={Boolean(editCaseNumber)}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:bg-gray-100 disabled:text-gray-500"
                  placeholder="AAI-UAE-2026-XXX"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-case-name">
                  Case name
                </label>
                <input
                  id="fdr-case-name"
                  type="text"
                  value={caseInfo.caseName}
                  onChange={handleCaseInfoChange('caseName')}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  placeholder="Short incident title"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-occurrence-date">
                  Occurrence date
                </label>
                <input
                  id="fdr-occurrence-date"
                  type="date"
                  value={caseInfo.occurrenceDate}
                  onChange={handleCaseInfoChange('occurrenceDate')}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                />
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-800">Investigator</p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-investigator-name">
                    Name
                  </label>
                  <input
                    id="fdr-investigator-name"
                    type="text"
                    value={investigator.name}
                    onChange={handleInvestigatorChange('name')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-investigator-org">
                    Organization
                  </label>
                  <input
                    id="fdr-investigator-org"
                    type="text"
                    value={investigator.organization}
                    onChange={handleInvestigatorChange('organization')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-investigator-phone">
                    Phone
                  </label>
                  <input
                    id="fdr-investigator-phone"
                    type="text"
                    value={investigator.phone}
                    onChange={handleInvestigatorChange('phone')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-investigator-email">
                    Email
                  </label>
                  <input
                    id="fdr-investigator-email"
                    type="email"
                    value={investigator.email}
                    onChange={handleInvestigatorChange('email')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-investigator-notes">
                  Investigator notes
                </label>
                <textarea
                  id="fdr-investigator-notes"
                  value={investigator.notes}
                  onChange={handleInvestigatorChange('notes')}
                  rows={2}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                />
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-800">Aircraft</p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-number">
                    Aircraft registration
                  </label>
                  <input
                    id="fdr-aircraft-number"
                    type="text"
                    value={aircraft.aircraftNumber}
                    onChange={handleAircraftChange('aircraftNumber')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    placeholder="e.g. A6-XYZ"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-type">
                    Aircraft type
                  </label>
                  <input
                    id="fdr-aircraft-type"
                    type="text"
                    value={aircraft.aircraftType}
                    onChange={handleAircraftChange('aircraftType')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    placeholder="e.g. A320-214"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-operator">
                    Operator
                  </label>
                  <input
                    id="fdr-aircraft-operator"
                    type="text"
                    value={aircraft.operator}
                    onChange={handleAircraftChange('operator')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-flight-number">
                    Flight number
                  </label>
                  <input
                    id="fdr-aircraft-flight-number"
                    type="text"
                    value={aircraft.flightNumber}
                    onChange={handleAircraftChange('flightNumber')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-location">
                    Location
                  </label>
                  <input
                    id="fdr-aircraft-location"
                    type="text"
                    value={aircraft.location}
                    onChange={handleAircraftChange('location')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-aircraft-date-of-flight">
                    Date of flight
                  </label>
                  <input
                    id="fdr-aircraft-date-of-flight"
                    type="date"
                    value={aircraft.dateOfFlight}
                    onChange={handleAircraftChange('dateOfFlight')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fdr-summary">
                Summary
              </label>
              <textarea
                id="fdr-summary"
                value={caseInfo.summary}
                onChange={handleCaseInfoChange('summary')}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                placeholder="Brief description of the occurrence"
              />
            </div>

            {createError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {createError}
              </div>
            )}

            <div className="flex justify-end gap-3">
              {editCaseNumber && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-5 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {editCaseNumber
                  ? isSubmitting
                    ? 'Saving…'
                    : 'Save & Continue'
                  : isSubmitting
                  ? 'Creating case…'
                  : 'Continue to FDR Upload'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}

        {(mode === 'attachCvr' || mode === 'loadFdr') && (
          <div className="space-y-4">
            {loadExistingError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {loadExistingError}
              </div>
            )}

            <label className="block text-sm font-medium text-gray-700" htmlFor="fdr-existing-case">
              {mode === 'attachCvr' ? 'Choose a case with CVR data but no FDR yet' : 'Choose a case with FDR in progress'}
            </label>
            <select
              id="fdr-existing-case"
              value={selectedExistingCaseNumber}
              onChange={(event) => setSelectedExistingCaseNumber(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              <option value="" disabled>
                {loadingExisting ? 'Loading cases…' : 'Select a case number'}
              </option>
              {(mode === 'attachCvr' ? casesForCvrAttach : casesForFdrResume).map((item) => (
                <option key={item.caseNumber} value={item.caseNumber}>
                  {item.caseNumber} — {item.caseName} · FDR: {item.fdrLabel} · CVR: {item.cvrLabel}
                </option>
              ))}
            </select>

            {!loadingExisting &&
              (mode === 'attachCvr' ? casesForCvrAttach : casesForFdrResume).length === 0 && (
                <p className="text-sm text-gray-500">
                  {mode === 'attachCvr'
                    ? 'No CVR cases are waiting on FDR data right now.'
                    : 'No FDR cases are in progress right now.'}
                </p>
              )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleAttachExisting}
                disabled={!selectedExistingCaseNumber}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FdrCaseDetailsStep;
