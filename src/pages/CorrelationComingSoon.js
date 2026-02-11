import React from 'react';
import { useParams } from 'react-router-dom';

const CorrelationComingSoon = () => {
  const { caseNumber } = useParams();

  return (
    <div className="max-w-3xl mx-auto rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600">Correlation Module</p>
      <h1 className="mt-2 text-2xl font-bold text-gray-900">Coming soon</h1>
      <p className="mt-3 text-sm text-gray-600">
        Correlation module will be available in a future release.
      </p>
      {caseNumber && (
        <p className="mt-4 text-xs text-gray-500">
          Case: <span className="font-semibold text-gray-700">{caseNumber}</span>
        </p>
      )}
    </div>
  );
};

export default CorrelationComingSoon;
