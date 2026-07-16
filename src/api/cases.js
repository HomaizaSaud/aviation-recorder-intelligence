import request from './client';

const serializeCasePayload = (payload) => ({
  ...payload,
  tags: Array.isArray(payload.tags)
    ? payload.tags
    : (payload.tags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
});

export const fetchCases = async ({ page, pageSize } = {}) => {
  const params = new URLSearchParams();
  if (Number.isFinite(page)) {
    params.set('page', String(page));
  }
  if (Number.isFinite(pageSize)) {
    params.set('pageSize', String(pageSize));
  }

  const query = params.toString();
  return request(`/cases${query ? `?${query}` : ''}`);
};

export const fetchCaseByNumber = async (caseNumber) => request(`/cases/${caseNumber}`);

export const createCase = async (payload) => request('/cases', {
  method: 'POST',
  body: JSON.stringify(serializeCasePayload(payload)),
});

export const updateCase = async (caseNumber, payload) => request(`/cases/${caseNumber}`, {
  method: 'PUT',
  body: JSON.stringify(serializeCasePayload(payload)),
});

export const updateInvestigatorSummary = async (caseNumber, payload) =>
  request(`/cases/${caseNumber}/investigator-summary`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

export const deleteCase = async (caseNumber) =>
  request(`/cases/${caseNumber}`, {
    method: 'DELETE',
  });

const buildCvrPath = (caseNumber, path) => `/cases/${caseNumber}/cvr/${path}`;

export const runCvrDenoise = async (caseNumber, payload = {}) =>
  request(buildCvrPath(caseNumber, 'denoise'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const runCvrTranscription = async (caseNumber, payload = {}) =>
  request(buildCvrPath(caseNumber, 'transcription'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const runCvrRoleIdentification = async (caseNumber, payload = {}) =>
  request(`/cases/${caseNumber}/cvr/roles`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const runCvrEventDetection = async (caseNumber, payload = {}) =>
  request(`/cases/${caseNumber}/cvr/events`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const runCvrChannelSeparation = async (caseNumber, payload = {}) =>
  request(buildCvrPath(caseNumber, 'channels'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const runCvrEmotionAnalysis = async (caseNumber, payload = {}) =>
  request(`/cases/${caseNumber}/emotion-analysis`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const deleteCvrDenoiseOutput = async (caseNumber, outputId) =>
  request(buildCvrPath(caseNumber, `denoise/${encodeURIComponent(outputId)}`), {
    method: 'DELETE',
  });

export const updateCvrPipeline = async (caseNumber, pipeline) =>
  request(buildCvrPath(caseNumber, 'pipeline'), {
    method: 'PUT',
    body: JSON.stringify({ pipeline }),
  });
