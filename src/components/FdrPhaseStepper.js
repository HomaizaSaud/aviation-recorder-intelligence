import React from 'react';
import { Check } from 'lucide-react';

const PHASES = [
  { key: 'details', title: 'Step 1', subtitle: 'Case Details' },
  { key: 'upload', title: 'Step 2', subtitle: 'FDR Upload' },
  { key: 'dataAnalysis', title: 'Step 3', subtitle: 'Data Analysis' },
  { key: 'normalParameters', title: 'Step 4', subtitle: 'Normal Parameters' },
  { key: 'abnormalParameters', title: 'Step 5', subtitle: 'Abnormal Parameters' },
  { key: 'report', title: 'Step 6', subtitle: 'Report' },
];

const FdrPhaseStepper = ({ currentPhase, onPhaseClick }) => {
  const currentIndex = PHASES.findIndex((phase) => phase.key === currentPhase);

  return (
    <ol className="grid grid-cols-3 sm:grid-cols-6 gap-4 mb-8">
      {PHASES.map((phase, index) => {
        const status =
          index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
        const isClickable = Boolean(onPhaseClick) && index < currentIndex;
        const Wrapper = isClickable ? 'button' : 'div';

        return (
          <li key={phase.key} className="flex flex-col items-center">
            <Wrapper
              type={isClickable ? 'button' : undefined}
              onClick={isClickable ? () => onPhaseClick(phase.key) : undefined}
              className={`flex flex-col items-center ${isClickable ? 'cursor-pointer group' : ''}`}
            >
              <div
                className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all ${
                  status === 'complete'
                    ? `border-emerald-500 bg-emerald-500 text-white ${isClickable ? 'group-hover:bg-emerald-600' : ''}`
                    : status === 'current'
                    ? 'border-emerald-500 text-emerald-600 bg-white'
                    : 'border-gray-300 text-gray-400 bg-white'
                }`}
              >
                {status === 'complete' ? <Check className="w-5 h-5" /> : index + 1}
              </div>
              <div className="mt-2 text-center">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{phase.title}</p>
                <p
                  className={`text-xs font-medium text-gray-700 ${isClickable ? 'group-hover:text-emerald-700 group-hover:underline' : ''}`}
                >
                  {phase.subtitle}
                </p>
              </div>
            </Wrapper>
          </li>
        );
      })}
    </ol>
  );
};

export default FdrPhaseStepper;
