import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CaseDetails from './CaseDetails';

const navigateMock = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ caseNumber: 'CASE-1' }),
}));

jest.mock('../api/cases', () => ({
  fetchCaseByNumber: jest.fn(),
  updateCase: jest.fn(),
  updateInvestigatorSummary: jest.fn(),
}));

jest.mock('../api/report-exports', () => ({
  fetchReportExports: jest.fn(),
}));

jest.mock('../components/NotesPanel', () => () => null);

jest.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

const { fetchCaseByNumber } = require('../api/cases');
const { fetchReportExports } = require('../api/report-exports');

const caseResponse = {
  caseNumber: 'CASE-1',
  caseName: 'Test Case',
  status: 'Analysis Started',
  owner: 'Owner',
  organization: 'Org',
  examiner: 'Exam',
  aircraftType: 'A1',
  lastUpdated: '2024-01-01',
  investigator: {},
  aircraft: {},
  analyses: {
    fdr: { summary: 'FDR summary' },
    cvr: {},
    correlate: {},
  },
  attachments: [
    {
      type: 'FDR',
      name: 'fdr-data.csv',
      uploadedAt: '2024-01-01T12:00:00Z',
      storage: { objectKey: 'fdr-key' },
    },
  ],
  timeline: [
    {
      id: 'run-1',
      kind: 'fdr_detection_completed',
      action: 'Behavioral anomaly detection completed',
      timestamp: '2024-01-02T12:00:00Z',
      actor: { name: 'Analyst One' },
      metadata: [{ label: 'Status', value: 'Success' }],
      links: { runId: 'run-1' },
    },
  ],
};

describe('CaseDetails latest results button', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchCaseByNumber.mockResolvedValue(caseResponse);
    fetchReportExports.mockResolvedValue([]);
  });

  test('enables latest results button and navigates to latest run', async () => {
    render(<CaseDetails />);

    const latestResultsButton = await screen.findByRole('button', { name: /view latest results/i });
    expect(latestResultsButton).toBeEnabled();

    fireEvent.click(latestResultsButton);

    expect(navigateMock).toHaveBeenCalledWith('/cases/CASE-1/fdr?runId=run-1');
  });
});
