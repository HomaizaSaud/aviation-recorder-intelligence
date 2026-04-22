import request, { buildAuthHeaders, buildRequestUrl } from './client';

export const fetchReportExports = async (caseNumber, { limit } = {}) => {
  const query = Number.isInteger(limit) ? `?limit=${limit}` : '';
  return request(`/cases/${caseNumber}/report-exports${query}`);
};

export const createReportExport = async (caseNumber, payload) =>
  request(`/cases/${caseNumber}/report-exports`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const fetchReportAvailability = async (caseNumber) =>
  request(`/cases/${caseNumber}/report-availability`);

export const deleteReportExport = async (caseNumber, reportId) =>
  request(`/cases/${caseNumber}/report-exports/${reportId}`, {
    method: 'DELETE',
  });

const parseContentDisposition = (value) => {
  if (!value) {
    return null;
  }

  const match = /filename="?([^";]+)"?/i.exec(value);
  return match ? match[1] : null;
};

export const generateReportExport = async (caseNumber, payload) => {
  const response = await fetch(
    buildRequestUrl(`/cases/${caseNumber}/report-exports/generate`),
    {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: JSON.stringify(payload),
    },
  );

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    const message = errorPayload?.error || 'Unable to export report.';
    const error = new Error(message);
    error.details = errorPayload?.details;
    throw error;
  }

  if (contentType.includes('application/pdf')) {
    const blob = await response.blob();
    return {
      type: 'pdf',
      blob,
      fileName: parseContentDisposition(response.headers.get('content-disposition')),
    };
  }

  if (contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
    const blob = await response.blob();
    return {
      type: 'docx',
      blob,
      fileName: parseContentDisposition(response.headers.get('content-disposition')),
    };
  }

  const data = await response.json().catch(() => ({}));
  return { type: 'json', data };
};

const reportExportsApi = {
  fetchReportExports,
  createReportExport,
  fetchReportAvailability,
  deleteReportExport,
  generateReportExport,
};

export default reportExportsApi;
