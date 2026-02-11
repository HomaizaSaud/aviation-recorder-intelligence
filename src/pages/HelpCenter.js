import React from 'react';
import { HelpCircle, Flag, UploadCloud, Activity, FileText, Wrench } from 'lucide-react';

const HelpCenter = () => {
  const sections = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      description: 'Create a case and upload data so the investigation workspace is ready.',
      icon: Flag,
      steps: [
        'Select “Start New Case” from the Cases area.',
        'Enter the occurrence details (date, aircraft registration, and recorder identifiers).',
        'Upload CVR/FDR files from your workstation or secure recorder (if not available, the case can be edited and the files can be added later).',
        'Confirm the ingestion summary and proceed to the case dashboard.',
      ],
    },
    {
      id: 'fdr-workflow',
      title: 'FDR Module workflow',
      description: 'Run analysis, interpret the timeline score, and review evidence.',
      icon: Activity,
      steps: [
        'Open the FDR module from the case dashboard and select “Run Analysis”.',
        'Review the timeline and note the behavioral deviation score highlights.',
        'Click a highlighted point to open evidence segments for that interval.',
        'Use the evidence panel to step through segment details and correlate findings.',
        'Open the summary view to capture findings for reporting.',
      ],
    },
    {
      id: 'reports-workflow',
      title: 'Reports workflow',
      description: 'Generate reports and export them in the required format.',
      icon: FileText,
      steps: [
        'Choose “Generate Report” from the Reports area.',
        'Review the investigation notes that will be included in the generated report.',
        'Export to PDF or DOCX and save it to your case archive.',
      ],
    },
    {
      id: 'troubleshooting',
      title: 'Troubleshooting',
      description: 'Common issues and how to resolve them quickly.',
      icon: Wrench,
      steps: [
        'Missing data: verify the recorder upload completed and re-upload any corrupt files.',
        'Slow analysis: close unused modules and rerun during low-traffic periods.',
        'Rerun: choose “Rerun” only after data updates.',
        'Export not showing: confirm the export finished and check your browser download location.',
      ],
    },
  ];

  const glossary = [
    {
      term: 'Behavioral deviation score',
      definition:
        'A score that highlights how far observed flight behavior deviates from expected patterns during the timeline.',
    },
    {
      term: 'Threshold',
      definition:
        'The score value that triggers a timeline highlight or alert for further review.',
    },
    {
      term: 'Segment',
      definition:
        'A bounded slice of the flight timeline used to group evidence and data points.',
    },
    {
      term: 'Evidence panel',
      definition:
        'The workspace view that lists segments, audio snippets, and parameter traces for the selected timeline interval.',
    },
  ];

  return (
    <div className="space-y-8">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
        <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-emerald-50 text-emerald-700 text-sm font-semibold">
          <HelpCircle className="w-4 h-4" />
          Help Center Manual
        </div>
        <h1 className="mt-4 text-3xl font-bold text-gray-900">CVR/FDR Investigation User Manual</h1>
        <p className="mt-3 text-gray-600 max-w-3xl">
          Use this step-by-step guide to start a case, run analysis, review evidence, and publish reports.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        <aside className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm h-fit lg:sticky lg:top-6">
          <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">Sections</p>
          <nav className="mt-4 space-y-3 text-sm">
            {sections.map(({ id, title }) => (
              <a
                key={id}
                href={`#${id}`}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-gray-600 hover:text-emerald-700 hover:bg-emerald-50"
              >
                <span>{title}</span>
                <UploadCloud className="w-4 h-4 text-emerald-400" />
              </a>
            ))}
            <a
              href="#glossary"
              className="flex items-center justify-between rounded-lg px-3 py-2 text-gray-600 hover:text-emerald-700 hover:bg-emerald-50"
            >
              <span>Glossary</span>
              <UploadCloud className="w-4 h-4 text-emerald-400" />
            </a>
          </nav>
        </aside>

        <div className="space-y-6">
          {sections.map(({ id, title, description, icon: Icon, steps }) => (
            <section
              key={id}
              id={id}
              className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm"
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600">
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
                  <p className="text-sm text-gray-600">{description}</p>
                </div>
              </div>
              <ol className="mt-4 space-y-3 text-sm text-gray-700 list-decimal list-inside">
                {steps.map((step) => (
                  <li key={step} className="leading-relaxed">
                    {step}
                  </li>
                ))}
              </ol>
            </section>
          ))}

          <section id="glossary" className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Glossary</h2>
            <dl className="mt-4 space-y-4">
              {glossary.map(({ term, definition }) => (
                <div key={term}>
                  <dt className="text-sm font-semibold text-gray-800">{term}</dt>
                  <dd className="mt-1 text-sm text-gray-600">{definition}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
};

export default HelpCenter;
