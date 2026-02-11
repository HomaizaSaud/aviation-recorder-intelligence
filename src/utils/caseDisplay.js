const formatCaseDate = (value) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
};

export const buildCasePreview = (caseData) => {
    if (!caseData) {
        return null;
    }

    const {
        caseNumber,
        caseName,
        summary,
        aircraft = {},
        aircraftType,
        lastUpdated,
        createdAt,
        updatedAt,
        date,
        location,
    } = caseData;

  const aircraftLabel =
    aircraft?.model || aircraft?.type || aircraftType || aircraft?.registration || 'Aircraft TBD';

  const displayDate = formatCaseDate(updatedAt || lastUpdated || createdAt || date);

    return {
        id: caseNumber || caseData.id || '',
        title: caseName || caseData.title || 'Untitled Case',
        date: displayDate || 'Date TBD',
        summary: summary || 'No summary provided yet.',
        aircraft: aircraftLabel,
        location: location || caseData.location || '',
        source: caseData,
    };
};
