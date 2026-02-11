import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, Download, FileText, Layers, Search, Sparkles } from "lucide-react";
import { fetchCaseByNumber, fetchCases } from "../api/cases";
import { fetchNotes } from "../api/notes";
import { createDownloadTarget } from "../api/storage";
import {
  fetchReportAvailability,
  fetchReportExports,
  generateReportExport,
} from "../api/report-exports";
import { useAuth } from "../hooks/useAuth";
import { resolveCaseStatusLabel } from "../utils/statuses";
import { resolveActor } from "../utils/timeline";

const sectionOptions = [
  {
    id: "fdr",
    title: "FDR Analysis Results",
    description: "Latest run summary with key anomaly highlights.",
  },
  {
    id: "cvr",
    title: "CVR Analysis / Transcript",
    description: "CVR analysis summary and transcript overview.",
  },
  {
    id: "correlation",
    title: "Correlation Summary",
    description: "Highlights where CVR and FDR timelines intersect.",
  },
  {
    id: "notes",
    title: "Investigator Notes",
    description: "Captured observations and analyst notes for this case.",
  },
];

const exportFormats = [
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "Word (.docx)" },
];

const formatNoteAuthor = (author = {}) => {
  const name = `${author.firstName || ""} ${author.lastName || ""}`.trim();
  return name || author.email || "Unknown";
};

const formatNoteTimestamp = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
};

const getExportErrorMessage = (error) => {
  const message = error?.message || "";
  if (message.includes("Case not found")) {
    return "We couldn't find that case to export. Please reload and try again.";
  }
  if (message.toLowerCase().includes("no analyzed results")) {
    return "No analyzed results are available for the selected sections yet.";
  }
  return "We couldn't export the report. Please try again in a moment.";
};

export default function Reports() {
  const location = useLocation();
  const { user } = useAuth();
  const [cases, setCases] = useState([]);
  const [caseLoadError, setCaseLoadError] = useState("");
  const [selectedCaseNumber, setSelectedCaseNumber] = useState("");
  const [selectedCaseDetails, setSelectedCaseDetails] = useState(null);
  const [exportFormat, setExportFormat] = useState("pdf");
  const [caseQuery, setCaseQuery] = useState("");
  const [isCaseListOpen, setIsCaseListOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportSuccess, setExportSuccess] = useState("");
  const [lastExport, setLastExport] = useState(null);
  const [recentExports, setRecentExports] = useState([]);
  const [recentExportsError, setRecentExportsError] = useState("");
  const [recentExportsLoading, setRecentExportsLoading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadingExportId, setDownloadingExportId] = useState("");
  const [availability, setAvailability] = useState(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [investigatorNotes, setInvestigatorNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");
  const comboboxRef = useRef(null);

  const normalizeCase = (caseItem) => ({
    caseNumber: caseItem.caseNumber,
    caseName: caseItem.caseName,
    module: caseItem.module || "No Data Uploaded",
    status: resolveCaseStatusLabel(caseItem),
    lead: caseItem.owner || caseItem.examiner || "Unknown",
    lastUpdated:
      caseItem.lastUpdated ||
      (caseItem.updatedAt ? caseItem.updatedAt.slice(0, 10) : "") ||
      "—",
    summary: caseItem.summary || "",
    computedStatus: caseItem.computedStatus,
    computedStatusLabel: caseItem.computedStatusLabel,
  });

  useEffect(() => {
    let isMounted = true;
    fetchCases()
      .then((response) => {
        if (!isMounted) {
          return;
        }
        const data = Array.isArray(response) ? response : response?.data;
        const normalized = (Array.isArray(data) ? data : []).map(normalizeCase);
        if (normalized.length > 0) {
          setCases(normalized);
          setSelectedCaseNumber((prev) =>
            normalized.some((item) => item.caseNumber === prev)
              ? prev
              : normalized[0].caseNumber
          );
          setCaseLoadError("");
        } else {
          setCases([]);
          setSelectedCaseNumber("");
        }
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setCaseLoadError(error.message || "Unable to load cases.");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedCaseNumber) {
      setSelectedCaseDetails(null);
      return;
    }

    let isMounted = true;
    fetchCaseByNumber(selectedCaseNumber)
      .then((data) => {
        if (!isMounted) {
          return;
        }
        const normalized = normalizeCase(data);
        setSelectedCaseDetails(normalized);
        setCases((prev) =>
          prev.map((item) => (item.caseNumber === normalized.caseNumber ? normalized : item))
        );
      })
      .catch((_error) => {
        if (isMounted) {
          setSelectedCaseDetails(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCaseNumber]);

  const selectedCase = useMemo(
    () =>
      selectedCaseDetails ||
      cases.find((caseItem) => caseItem.caseNumber === selectedCaseNumber),
    [cases, selectedCaseDetails, selectedCaseNumber]
  );

  const filteredCases = useMemo(() => {
    const normalizedQuery = caseQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return cases;
    }

    return cases.filter((caseItem) => {
      const searchableText = `${caseItem.caseNumber} ${caseItem.caseName} ${caseItem.module}`.toLowerCase();

      return searchableText.includes(normalizedQuery);
    });
  }, [caseQuery, cases]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const caseParam = params.get("caseId") || params.get("case");
    if (caseParam) {
      const matchedCase = cases.find((caseItem) => caseItem.caseNumber === caseParam);
      if (matchedCase) {
        setSelectedCaseNumber(matchedCase.caseNumber);
      }
    }
  }, [cases, location.search]);

  useEffect(() => {
    const stateCase = location.state?.caseNumber;
    if (!stateCase) {
      return;
    }
    setSelectedCaseNumber(stateCase);
    setSelectedCaseDetails(null);
    setIsCaseListOpen(false);
    setCaseQuery("");
    setExportError(null);
    setExportSuccess("");
  }, [location.state]);

  useEffect(() => {
    if (!selectedCaseNumber) {
      setInvestigatorNotes([]);
      setNotesError("");
      return;
    }

    let isMounted = true;
    setNotesLoading(true);
    setNotesError("");

    Promise.all([
      fetchNotes(selectedCaseNumber, { module: "GENERAL" }),
      fetchNotes(selectedCaseNumber, { module: "FDR" }),
    ])
      .then(([generalNotes, fdrNotes]) => {
        if (!isMounted) {
          return;
        }
        const combined = [...(generalNotes || []), ...(fdrNotes || [])].filter(Boolean);
        combined.sort((a, b) => {
          const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime;
        });
        setInvestigatorNotes(combined);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setNotesError(error.message || "Unable to load investigator notes.");
        setInvestigatorNotes([]);
      })
      .finally(() => {
        if (isMounted) {
          setNotesLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCaseNumber]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (comboboxRef.current && !comboboxRef.current.contains(event.target)) {
        setIsCaseListOpen(false);
        setCaseQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isCaseListOpen) {
      return;
    }

    if (caseQuery.trim()) {
      setHighlightedIndex(0);
      return;
    }

    const selectedIndex = filteredCases.findIndex(
      (caseItem) => caseItem.caseNumber === selectedCaseNumber
    );

    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [caseQuery, filteredCases, isCaseListOpen, selectedCaseNumber]);

  useEffect(() => {
    if (!selectedCaseNumber) {
      setRecentExports([]);
      return;
    }

    let isMounted = true;
    setRecentExportsLoading(true);
    setRecentExportsError("");

    fetchReportExports(selectedCaseNumber, { limit: 5 })
      .then((exportsList) => {
        if (!isMounted) {
          return;
        }

        const normalizedExports = Array.isArray(exportsList) ? [...exportsList] : [];
        normalizedExports.sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());
        setRecentExports(normalizedExports);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setRecentExportsError(error.message || "Unable to load recent exports.");
      })
      .finally(() => {
        if (isMounted) {
          setRecentExportsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCaseNumber]);

  useEffect(() => {
    if (!selectedCaseNumber) {
      setAvailability(null);
      return;
    }

    let isMounted = true;
    setAvailabilityLoading(true);
    setAvailabilityError("");

    fetchReportAvailability(selectedCaseNumber)
      .then((data) => {
        if (!isMounted) {
          return;
        }
        setAvailability(data);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setAvailabilityError(error.message || "Unable to load available sections.");
        setAvailability(null);
      })
      .finally(() => {
        if (isMounted) {
          setAvailabilityLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCaseNumber]);

  const availableSections = useMemo(() => {
    if (!availability) {
      return [];
    }

    return sectionOptions.filter((section) => {
      if (section.id === "fdr") {
        return availability.has_fdr_results;
      }
      if (section.id === "cvr") {
        return availability.has_cvr_results;
      }
      if (section.id === "correlation") {
        return availability.has_correlation_results;
      }
      if (section.id === "notes") {
        return (availability.notes_count || 0) > 0;
      }
      return false;
    });
  }, [availability]);

  const handleSelectCase = (caseItem) => {
    setSelectedCaseNumber(caseItem.caseNumber);
    setSelectedCaseDetails(null);
    setIsCaseListOpen(false);
    setCaseQuery("");
    setExportError(null);
    setExportSuccess("");
  };

  const handleCaseInputFocus = (event) => {
    setIsCaseListOpen(true);
    setCaseQuery("");
    event.target.select();
  };

  const handleCaseInputChange = (event) => {
    setCaseQuery(event.target.value);
    setIsCaseListOpen(true);
  };

  const handleCaseInputKeyDown = (event) => {
    if (!isCaseListOpen && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      setIsCaseListOpen(true);
      return;
    }

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setHighlightedIndex((prevIndex) =>
          Math.min(prevIndex + 1, Math.max(filteredCases.length - 1, 0))
        );
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        setHighlightedIndex((prevIndex) => Math.max(prevIndex - 1, 0));
        break;
      }
      case "Enter": {
        if (filteredCases[highlightedIndex]) {
          event.preventDefault();
          handleSelectCase(filteredCases[highlightedIndex]);
        }
        break;
      }
      case "Escape": {
        setIsCaseListOpen(false);
        setCaseQuery("");
        break;
      }
      default:
        break;
    }
  };

  const handleGenerateReport = useCallback(async () => {
    if (!selectedCaseNumber || !selectedCase) {
      return;
    }

    setIsExporting(true);
    setExportError(null);
    setExportSuccess("");

    try {
      const selectedSectionItems = availableSections;

      const payload = {
        case_number: selectedCaseNumber,
        selected_sections: selectedSectionItems.map((section) => section.id),
        fdr_run_id: availability?.latest_fdr_run_id || undefined,
        cvr_run_id: availability?.latest_cvr_run_id || undefined,
        correlation_run_id: availability?.latest_corr_run_id || undefined,
        format: exportFormat,
      };

      const result = await generateReportExport(selectedCaseNumber, payload);
      const actor = resolveActor({
        user,
        fallback: selectedCase.lead || "Unknown",
      });

      if (result.type === "pdf" || result.type === "docx") {
        const extension = result.type === "docx" ? "docx" : "pdf";
        const fileName = result.fileName || `${selectedCaseNumber}_Report.${extension}`;
        const url = window.URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      } else if (result.type === "json") {
        if (result.data?.download_url) {
          window.open(result.data.download_url, "_blank", "noopener,noreferrer");
        }
        if (result.data?.export) {
          setRecentExports((prev) => [result.data.export, ...prev].slice(0, 5));
          setLastExport({
            timestamp: result.data.export.createdAt,
            actor: actor.name,
            format: result.data.export.format || "PDF",
          });
        }
      }

      setExportSuccess("Report exported successfully.");
      setTimeout(() => setExportSuccess(""), 4000);
      try {
        const exportsList = await fetchReportExports(selectedCaseNumber, { limit: 5 });
        const normalizedExports = Array.isArray(exportsList) ? [...exportsList] : [];
        normalizedExports.sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());
        setRecentExports(normalizedExports);
        if (normalizedExports[0]) {
          setLastExport({
            timestamp: normalizedExports[0].createdAt,
            actor: actor.name,
            format: normalizedExports[0].format || exportFormat.toUpperCase(),
          });
        }
        const refreshedCase = await fetchCaseByNumber(selectedCaseNumber);
        const normalizedCase = normalizeCase(refreshedCase);
        setSelectedCaseDetails(normalizedCase);
        setCases((prev) =>
          prev.map((item) =>
            item.caseNumber === normalizedCase.caseNumber ? normalizedCase : item
          )
        );
      } catch (_error) {
        // Ignore refresh errors after a successful export.
      }
    } catch (error) {
      setExportError({
        message: getExportErrorMessage(error),
        details: error.details || error.message || "Unknown error",
      });
    } finally {
      setIsExporting(false);
    }
  }, [availableSections, exportFormat, selectedCase, selectedCaseNumber, user]);


  const handleDownloadExport = async (exportItem) => {
    if (!exportItem?.storagePath) {
      setDownloadError("No download is available for this report.");
      return;
    }

    setDownloadError("");
    setDownloadingExportId(exportItem.exportId);
    try {
      const target = await createDownloadTarget({
        bucket: exportItem.storageBucket,
        objectKey: exportItem.storagePath,
        fileName: exportItem.filename,
      });
      window.open(target.downloadUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setDownloadError(error.message || "Unable to download the report.");
    } finally {
      setDownloadingExportId("");
    }
  };

  const handleCopyDetails = async () => {
    if (!exportError?.details) {
      return;
    }

    try {
      await navigator.clipboard.writeText(String(exportError.details));
      setExportSuccess("Technical details copied.");
      setTimeout(() => setExportSuccess(""), 3000);
    } catch (_error) {
      setExportSuccess("Unable to copy technical details.");
      setTimeout(() => setExportSuccess(""), 3000);
    }
  };


  const includedSections = useMemo(() => {
    const sections = [
      { id: "case-summary", title: "Case Summary", available: true },
      { id: "fdr", title: "FDR Analysis", available: availability?.has_fdr_results },
      { id: "cvr", title: "CVR", available: availability?.has_cvr_results },
      { id: "correlation", title: "Correlation", available: availability?.has_correlation_results },
      { id: "notes", title: "Investigator Notes", available: (availability?.notes_count || 0) > 0 },
    ];

    return sections.filter((section) => section.available);
  }, [availability]);

  const selectedCount = includedSections.length;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {exportSuccess && (
        <div className="fixed right-6 top-6 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 shadow-lg">
          {exportSuccess}
        </div>
      )}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-800">Reports</h2>
          <p className="text-gray-600">
            Compile findings for the selected case with tailored sections and export formats.
          </p>
        </div>
        {/* <button
          type="button"
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          <FileText className="w-4 h-4" />
          View History
        </button> */}
      </div>
      {caseLoadError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {caseLoadError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <div className="bg-white rounded-xl shadow-md p-6 space-y-6">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-800">Case</h3>
            <p className="text-sm text-gray-500">Choose the investigation you would like to generate a report for.</p>
            <div className="relative max-w-lg" ref={comboboxRef}>
              <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-200">
                <Search className="h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  role="combobox"
                  aria-expanded={isCaseListOpen}
                  aria-controls="case-combobox-list"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    isCaseListOpen && filteredCases[highlightedIndex]
                      ? `case-option-${filteredCases[highlightedIndex].caseNumber}`
                      : undefined
                  }
                  onFocus={handleCaseInputFocus}
                  onChange={handleCaseInputChange}
                  onKeyDown={handleCaseInputKeyDown}
                  value={caseQuery || (selectedCase ? `${selectedCase.caseNumber} — ${selectedCase.caseName}` : "")}
                  placeholder="Search cases by number, name, or module"
                  className="h-8 w-full border-none bg-transparent text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
                />
              </div>
              {isCaseListOpen && (
                <div
                  id="case-combobox-list"
                  role="listbox"
                  className="absolute z-10 mt-2 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
                >
                  {filteredCases.length > 0 ? (
                    filteredCases.map((caseItem, index) => {
                      const isHighlighted = index === highlightedIndex;
                      const isSelected = caseItem.caseNumber === selectedCaseNumber;

                      return (
                        <button
                          key={caseItem.caseNumber}
                          type="button"
                          role="option"
                          id={`case-option-${caseItem.caseNumber}`}
                          aria-selected={isSelected}
                          onMouseEnter={() => setHighlightedIndex(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSelectCase(caseItem)}
                          className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left text-sm transition-colors ${isHighlighted
                              ? "bg-emerald-50 text-emerald-900"
                              : "text-gray-700 hover:bg-emerald-50/70"
                            } ${isSelected ? "font-semibold" : "font-normal"}`}
                        >
                          <span>
                            {caseItem.caseNumber} — {caseItem.caseName}
                          </span>
                          <span className="text-xs text-gray-500">
                            Module: {caseItem.module} · Status: {caseItem.status}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-4 py-6 text-center text-sm text-gray-500">
                      No cases match your search. Try a different case number or keyword.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <Layers className="w-4 h-4 text-emerald-500" />
              Included sections
            </div>
            {availabilityLoading ? (
              <p className="text-sm text-gray-500">Loading included sections…</p>
            ) : availabilityError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {availabilityError}
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-600 space-y-3">
                <p className="font-semibold text-gray-700">
                  Included sections (auto-detected)
                </p>
                {includedSections.length > 1 ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-semibold text-emerald-700">
                      View details
                    </summary>
                    <ul className="mt-3 space-y-2">
                      {includedSections.map((section) => (
                        <li key={section.id} className="flex items-start gap-2 text-sm text-gray-700">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
                          <span>{section.title}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <ul className="space-y-2">
                    {includedSections.map((section) => (
                      <li key={section.id} className="flex items-start gap-2 text-sm text-gray-700">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
                        <span>{section.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {availableSections.length === 0 && (
                  <p className="text-xs text-gray-500">
                    Run the analysis module to include technical sections.{" "}
                    <a
                      href={`/cases/${selectedCaseNumber}/fdr`}
                      className="font-semibold text-emerald-600 hover:text-emerald-700"
                    >
                      Go to analysis
                    </a>
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <FileText className="w-4 h-4 text-emerald-500" />
              Investigator Notes
            </div>
            {notesLoading ? (
              <p className="text-sm text-gray-500">Loading notes…</p>
            ) : notesError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {notesError}
              </div>
            ) : investigatorNotes.length === 0 ? (
              <p className="text-sm text-gray-500">No investigator notes captured yet.</p>
            ) : (
              <ul className="max-h-64 space-y-3 overflow-y-auto pr-1">
                {investigatorNotes.map((note) => (
                  <li key={`${note.id}-${note.createdAt}`} className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                    <p className="text-xs font-semibold text-gray-700">
                      {formatNoteTimestamp(note.createdAt)} · {formatNoteAuthor(note.author)}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{note.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-1">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                <Sparkles className="w-4 h-4 text-emerald-500" />
                Export Options
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-600" htmlFor="export-format">
                  Export format
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <Download className="h-4 w-4 text-gray-400" />
                  <select
                    id="export-format"
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.target.value)}
                    className="w-full bg-transparent text-sm text-gray-700 focus:outline-none"
                  >
                    {exportFormats.map((format) => (
                      <option key={format.id} value={format.id}>
                        {format.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-start gap-4 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-gray-500">
              {lastExport ? (
                <>
                  Last generated on{" "}
                  <span className="font-medium text-gray-700">
                    {new Date(lastExport.timestamp).toLocaleDateString()}
                  </span>{" "}
                  by <span className="font-medium text-gray-700">{lastExport.actor}</span>
                </>
              ) : (
                <>
                  Last generated on <span className="font-medium text-gray-700">—</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={handleGenerateReport}
              disabled={isExporting || availabilityLoading || selectedCount === 0}
              className="flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3 text-white shadow-md transition hover:shadow-lg sm:w-auto"
              style={{ backgroundColor: "#019348" }}
            >
              <Download className="w-4 h-4" />
              {isExporting ? "Generating..." : "Generate Report"}
            </button>
          </div>
          {exportError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <p className="font-semibold">{exportError.message}</p>
              <details className="mt-3 text-xs text-rose-700/80">
                <summary className="cursor-pointer font-semibold text-rose-700">
                  Copy technical details
                </summary>
                <div className="mt-2 flex flex-col gap-2 rounded-md border border-rose-200 bg-white/60 p-3">
                  <pre className="whitespace-pre-wrap text-[11px] text-rose-800">
                    {exportError.details}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyDetails}
                    className="self-start rounded-md border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                  >
                    Copy details
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>

        {selectedCase && (
          <aside className="space-y-4">
            <div className="rounded-xl border border-emerald-100 bg-white p-6 shadow-md">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-emerald-600">Selected Case</p>
                  <h3 className="text-lg font-semibold text-gray-900">{selectedCase.caseName}</h3>
                  <p className="text-sm text-gray-500">{selectedCase.caseNumber}</p>
                </div>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                  {selectedCase.module}
                </span>
              </div>
              <p className="mt-4 text-sm text-gray-600">{selectedCase.summary}</p>
              <dl className="mt-6 space-y-3 text-sm text-gray-600">
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Status</dt>
                  <dd className="font-medium text-gray-800">{selectedCase.status}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Lead Investigator</dt>
                  <dd className="font-medium text-gray-800">{selectedCase.lead}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Last updated</dt>
                  <dd className="font-medium text-gray-800">{selectedCase.lastUpdated}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-md">
              <h4 className="text-sm font-semibold text-gray-800">Recent exports for this case</h4>
              {downloadError && <p className="mt-3 text-xs text-rose-600">{downloadError}</p>}
              {recentExportsError && (
                <p className="mt-3 text-xs text-rose-600">{recentExportsError}</p>
              )}
              {recentExportsLoading ? (
                <p className="mt-3 text-xs text-gray-500">Loading exports…</p>
              ) : recentExports.length === 0 ? (
                <p className="mt-3 text-xs text-gray-500">No exports generated yet.</p>
              ) : (
                <ul className="mt-4 space-y-3 text-sm text-gray-600">
                  {recentExports.map((item) => (
                    <li key={item.exportId} className="space-y-1 rounded-lg border border-gray-100 px-3 py-2">
                      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                        <span>{item.format}</span>
                        <span>{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "—"}</span>
                      </div>
                      <p className="text-sm font-medium text-gray-800">{item.filename}</p>
                      {item.linkedRunId && (
                        <p className="text-xs text-gray-500">Run {item.linkedRunId}</p>
                      )}
                      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                        <span>
                          {item.createdBy?.firstName || item.createdBy?.lastName
                            ? `${item.createdBy?.firstName || ""} ${item.createdBy?.lastName || ""}`.trim()
                            : item.createdBy?.email || "Unknown"}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDownloadExport(item)}
                          disabled={downloadingExportId === item.exportId}
                          className="text-emerald-600 hover:text-emerald-700 disabled:cursor-not-allowed disabled:text-emerald-300"
                        >
                          {downloadingExportId === item.exportId ? "Preparing…" : "Download"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
