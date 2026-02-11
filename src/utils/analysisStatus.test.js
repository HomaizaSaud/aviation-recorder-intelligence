import {
  ANALYSIS_STATUS_STATES,
  getAnalysisStatusStyles,
  normalizeAnalysisStatus,
} from './analysisStatus';

describe('analysisStatus', () => {
  describe('normalizeAnalysisStatus', () => {
    it('treats Not Started as not started instead of running', () => {
      expect(normalizeAnalysisStatus('Not Started')).toBe(ANALYSIS_STATUS_STATES.NOT_STARTED);
    });

    it('keeps running states mapped to running', () => {
      expect(normalizeAnalysisStatus('Running')).toBe(ANALYSIS_STATUS_STATES.RUNNING);
      expect(normalizeAnalysisStatus('Analysis Started')).toBe(ANALYSIS_STATUS_STATES.RUNNING);
    });

    it('keeps completed and failed states mapped correctly', () => {
      expect(normalizeAnalysisStatus('Analyzed/Completed')).toBe(ANALYSIS_STATUS_STATES.COMPLETED);
      expect(normalizeAnalysisStatus('Failed')).toBe(ANALYSIS_STATUS_STATES.FAILED);
    });
  });

  describe('getAnalysisStatusStyles', () => {
    it('returns neutral gray style for Not Started', () => {
      expect(getAnalysisStatusStyles('Not Started')).toBe('bg-gray-100 text-gray-500 border border-gray-200');
    });

    it('returns amber for Running and green for Completed', () => {
      expect(getAnalysisStatusStyles('Running')).toBe('bg-amber-100 text-amber-700');
      expect(getAnalysisStatusStyles('Analyzed/Completed')).toBe('bg-emerald-100 text-emerald-700');
    });
  });
});
