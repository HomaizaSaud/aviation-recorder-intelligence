import React from 'react';
import { Check } from 'lucide-react';

const PHASES = [
  { key: 'details', title: 'Step 1', subtitle: 'Case Details' },
  { key: 'upload', title: 'Step 2', subtitle: 'CVR Upload' },
  { key: 'review', title: 'Step 3', subtitle: 'Review' },
  { key: 'analysis', title: 'Step 4', subtitle: 'Analysis' },
];

const CvrPhaseStepper = ({ currentPhase, onPhaseClick }) => {
  const currentIndex = PHASES.findIndex((phase) => phase.key === currentPhase);

  return (
    <ol className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
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
                className={`flex items-center justify-center w-12 h-12 rounded-full border-2 transition-all ${
                  status === 'complete'
                    ? `border-emerald-500 bg-emerald-500 text-white ${isClickable ? 'group-hover:bg-emerald-600' : ''}`
                    : status === 'current'
                    ? 'border-emerald-500 text-emerald-600 bg-white'
                    : 'border-gray-300 text-gray-400 bg-white'
                }`}
              >
                {status === 'complete' ? <Check className="w-6 h-6" /> : index + 1}
              </div>
              <div className="mt-3 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{phase.title}</p>
                <p
                  className={`text-sm font-medium text-gray-700 ${isClickable ? 'group-hover:text-emerald-700 group-hover:underline' : ''}`}
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

export default CvrPhaseStepper;
