import React from 'react';
import { Check } from 'lucide-react';

const STEPS = [
  { key: 1, title: 'Step 1', subtitle: 'Case Details' },
  { key: 2, title: 'Step 2', subtitle: 'FDR Upload' },
  { key: 3, title: 'Step 3', subtitle: 'Data Analysis' },
  { key: 4, title: 'Step 4', subtitle: 'Normal Parameters' },
  { key: 5, title: 'Step 5', subtitle: 'Abnormal Parameters' },
  { key: 6, title: 'Step 6', subtitle: 'Analysis Report' },
];

const FdrWizardStepper = ({ currentStep, maxReachableStep = currentStep, onStepClick }) => {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Step {currentStep} of {STEPS.length}
      </p>
      <ol className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {STEPS.map((step) => {
          const status =
            step.key < currentStep ? 'complete' : step.key === currentStep ? 'current' : 'upcoming';
          const isClickable = Boolean(onStepClick) && step.key !== currentStep && step.key <= maxReachableStep;
          const Wrapper = isClickable ? 'button' : 'div';

          return (
            <li key={step.key} className="flex flex-col items-center">
              <Wrapper
                type={isClickable ? 'button' : undefined}
                onClick={isClickable ? () => onStepClick(step.key) : undefined}
                className={`flex flex-col items-center w-full ${isClickable ? 'cursor-pointer group' : ''}`}
              >
                <div
                  className={`flex items-center justify-center w-9 h-9 rounded-full border-2 text-sm font-semibold transition-all ${
                    status === 'complete'
                      ? `border-emerald-500 bg-emerald-500 text-white ${isClickable ? 'group-hover:bg-emerald-600' : ''}`
                      : status === 'current'
                      ? 'border-emerald-500 text-emerald-600 bg-white'
                      : 'border-gray-300 text-gray-400 bg-white'
                  }`}
                >
                  {status === 'complete' ? <Check className="w-4 h-4" /> : step.key}
                </div>
                <div className="mt-2 text-center">
                  <p
                    className={`text-xs font-medium leading-tight ${
                      status === 'upcoming' ? 'text-gray-400' : 'text-gray-700'
                    } ${isClickable ? 'group-hover:text-emerald-700 group-hover:underline' : ''}`}
                  >
                    {step.subtitle}
                  </p>
                </div>
              </Wrapper>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default FdrWizardStepper;
