---

## Frontend Integration Requirements
Every task must be visible in the UI. Claude Code must edit BOTH the Python
backend AND the React frontend files together.

---

### ✅ Task 6 — Flight Segmentation UI [COMPLETE]
IMPLEMENTED: services/fdr_anomaly/segment.py, run_segment.py,
  python_model/inference_service.py (/segment endpoint),
  server/src/services/anomaly.js (segmentFlightsForCase),
  server/src/routes/cases.js (POST /:n/fdr/segments),
  src/api/anomaly.js (fetchFdrSegments),
  src/pages/FDR.js (FlightSegmentSelector, filteredRows useMemo)
WHAT WAS ADDED:
- GA-adaptive segmentation (IAS → altitude → ground speed fallback)
- 120s gap merge for touch-and-go circuits
- "Flights Detected" card with pill selectors; single-flight shows info line
- Detection method badge (green/amber/gray)
- All charts filter to selected flight; amber border when filtered

---

### ✅ Task 7 — Phase Detection UI [COMPLETE]
IMPLEMENTED: services/fdr_anomaly/phase.py, run_phase.py,
  python_model/inference_service.py (/phases endpoint),
  server/src/services/anomaly.js (detectPhasesForCase),
  server/src/routes/cases.js (POST /:n/fdr/phases),
  src/api/anomaly.js (fetchFdrPhases),
  src/pages/FDR.js (phase bar, groupedPhases, ReferenceArea bands, chartRows)
WHAT WAS ADDED:
- Phase detection engine: VS > 200 → CLIMB, VS < -200 → DESCENT, else CRUISE
  with TAKEOFF/LANDING overrides (first/last 60s + altitude < ground+200ft)
- Proportional phase bar (5 solid blocks max, 36px, 2px gaps, click-to-filter)
- ReferenceArea bands on every chart (TAKEOFF/LANDING 0.12 opacity, rest 0.08)
- Detection badge (green=VS+IAS / amber=VS only / gray=altitude fallback)
- groupedPhases useMemo caps render to max 5 elements regardless of Python output

---

### ✅ Task 8 — Occurrence Highlight UI [COMPLETE]
IMPLEMENTED: server/src/services/cases.js (getFdrOccurrence, setFdrOccurrence),
  server/src/routes/cases.js (GET + PATCH /:n/fdr/occurrence),
  src/api/anomaly.js (fetchFdrOccurrence, saveFdrOccurrence),
  src/pages/FDR.js (occurrenceWindow state, drag handlers, chart overlays, info strip,
                    auto-derive from analysis result, auto-scroll)
STORAGE: analyses.fdr.occurrenceWindow JSONB sub-key (no schema migration needed)
WHAT WAS ADDED:
- Amber ReferenceArea band on every chart at occurrence window
- Dashed center ReferenceLine with "Occurrence · PHASE" label
- Live preview band while dragging (lighter amber, dashed stroke)
- Drag gesture: mousedown = set start, global mouseup = set end, auto-saves
- Phase label auto-derived from midpoint of window against flightPhases
- Info strip above charts showing window times + duration + phase badge
- Clear button resets window and patches server to null
- Auto-loads saved window on case open
- AUTO-DERIVE (PRIMARY): after Run Analysis completes, picks highest score_peak segment
  (tiebreak: severity high > med > low); sets occurrence window automatically if
  end_time - start_time >= 1s; saves to DB; skips single-point local-fallback segments
- AUTO-SCROLL: after auto-derive, scrolls Flight Parameter Overview into view (300ms delay)
- Manual drag still works to OVERRIDE or ADJUST the auto-derived window

---

### ✅ Problem 1 — File Format Detection [COMPLETE]
IMPLEMENTED: services/fdr_anomaly/fdr_format.py (new shared module),
  services/fdr_anomaly/autoencoder.py, segment.py, phase.py (use normalize_dataframe),
  src/pages/FDR.js (normalizeFdrRows, detectFdrCsvFormat, timeColumnExclusions)
WHAT WAS FIXED:
- NASA DFDAU Excel files (.mat → .xlsx via mat_to_excel.py) showed garbage column names
- Binary Excel detected via "PK" magic bytes prefix; shows info message instead of crashing
- NASA format: GMT_HOUR/GMT_MINUTE/GMT_SEC → synthetic "Session Time" (elapsed seconds)
- Units row (Row 2 all-strings) skipped by _skip_units_row() in Python and JS
- format: "ga" | "nasa" | "generic" propagated through all Python entry points

---

### ✅ Problem 2 — Anomaly Results UI Redesign [COMPLETE]
IMPLEMENTED: src/pages/FDR.js
WHAT WAS CHANGED:
- "Flagged Events (Evidence View)" → "All Findings (N)" with filter tabs All/High/Med/Low
- Each segment row split into two buttons: left=jump-to-charts, right=expand evidence (▼/▲)
- Left button shows: severity badge · phase · time range · score · top-2 drivers with % deviation
- Empty state is filter-aware
- Footer: "and N more low-severity findings omitted" when extra_segments_omitted > 0
- "Latest Analysis Results (read-only)" panel → "Analysis Complete" banner + "Most Critical
  Finding" hero card with severity, phase, time, drivers, deviation, "View on charts ↗" button

---

### ✅ Problem 3 — Occurrence Band on Score Chart [COMPLETE]
IMPLEMENTED: src/pages/FDR.js (Behavioral Deviation Score Timeline chart)
WHAT WAS ADDED:
- ReferenceArea (amber, fillOpacity=0.2) on score timeline for occurrenceWindow
- Dashed center ReferenceLine with "Occurrence · PHASE" label
- Mirrors same pattern as parameter charts; auto-appears when occurrence window is set

---

### ✅ Problem 4 — Severity Scoring Fix [COMPLETE]
IMPLEMENTED: services/fdr_anomaly/autoencoder.py
WHAT WAS FIXED:
- Root cause: inclusion threshold AND high threshold both at 97th percentile
- Fix: inclusion lowered to 85th percentile; severity uses full-distribution percentiles
  (97th = high, 90th = med) computed independently of inclusion threshold
- Cap: max 10 segments, sorted by severity then score_peak; extra_segments_omitted in summary

---

### Task 9 — Per-Phase Baselines UI
WHERE: Replace current anomaly detection results section
WHAT TO ADD:
- Show baseline stats per phase (mean ± std) for key parameters
- Anomaly score shown per phase, not globally
- A phase breakdown chart: which phases had the most anomalies

---

### Task 11 — Explainability UI
WHERE: In each flagged segment card (currently shows "Top drivers: X, Y, Z")
WHAT TO ADD:
- Expand each flagged segment to show a table:
  | Parameter | Phase | Baseline | Actual | Deviation | Type |
  | Pitch     | Climb | 4.2°     | 11.8°  | +7.6°     | Spike |
- Deviation type shown as a badge: Spike / Drift / Drop / Exceedance
- A mini sparkline chart showing the parameter value around the anomaly moment

---

### ✅ Task 12 — Multi-Parameter Synchronized Timeline [COMPLETE]
IMPLEMENTED: src/pages/FDR.js
WHAT WAS ADDED:
- "Parameter Correlation View" section in workflowStage === "analysis", positioned
  between the occurrence info strip and Flight Parameter Overview
- Searchable pill-button selector grouped by fdrParameterConfig categories + "Other"
  bucket for unlisted parameters; cap at 8 selected params with UI warning
- Default selection: Indicated Airspeed + Vertical Speed + Pitch + Roll (first present)
- Single ComposedChart with normalized (0–1) per-param Y-axis so mixed units
  (knots, ft/min, deg) are co-readable; tooltip shows raw value + unit
- Phase ReferenceArea bands (same pattern as individual parameter cards)
- Occurrence amber ReferenceArea + dashed ReferenceLine (same pattern)
- Drag-to-mark occurrence window (reuses handleChartMouseDown/handleChartMouseMove)
- Recharts Legend at bottom; colors consistent with parameterDisplayMap
- Selector panel collapsible (defaults open); "Hide selector ▲ / Edit selection ▼"
- correlationRanges useMemo computes min/max per param for normalization + tooltip
- correlationChartData useMemo: builds raw multi-key rows, downsampleSeries(raw,1200),
  then normalizes in-place, stores __raw keys for tooltip un-normalization

---

### Task 13 — Map UI
WHERE: New tab in FDR Module called "Flight Track"
WHAT TO ADD:
- A map (use Leaflet.js — already in most React projects, or add it)
- Aircraft track drawn as a colored polyline, color = flight phase
- A scrubber/slider below the map — dragging it moves an aircraft marker
  along the track and updates all parameter charts to that time position
- Show: departure point, arrival point, max altitude point
- Clicking any point on the map highlights that moment on the parameter charts

---

### Task 14 — Parameter Prioritization UI
WHERE: At the top of Flight Parameter Overview section
WHAT TO ADD:
- A "Suggested Parameters" banner based on case description keywords
- E.g. if case says "landing deviation" → surface: Pitch, Roll, Airspeed,
  Glideslope, Vertical Speed first
- Investigator can dismiss or pin suggestions

---

### Task 15 — Correction UI
WHERE: On each phase band, each anomaly segment, each chart
WHAT TO ADD:
- An edit icon on phase bands → investigator can drag phase boundaries
  or reassign a phase label
- An "Override" button on each anomaly segment → mark as false positive
  or reclassify severity
- All corrections saved to DB with timestamp + investigator name
- A "Corrections Log" visible in the case details

---

## File Editing Guide for Claude Code
These are the files that need to change for each task:

TASK 6:
- python_model/inference_service.py → add segment_flights() endpoint
- server/src/routes/ → add /api/fdr/segments route
- src/pages/FDRModule/ → add FlightSegmentSelector component

TASK 7:
- python_model/inference_service.py → add detect_phases() endpoint  
- server/src/routes/ → add /api/fdr/phases route
- src/pages/FDRModule/ → add PhaseTimeline component, update all charts

TASK 8:
- src/pages/FDRModule/ → add OccurrenceMarker overlay to all charts

TASK 9:
- python_model/inference_service.py → update anomaly detection to be per-phase
- src/pages/FDRModule/ → update AnomalyResults component

TASK 11:
- python_model/inference_service.py → add explainability output to anomaly results
- src/pages/FDRModule/ → update flagged segment cards with deviation table

TASK 12:
- src/pages/FDRModule/ → add ParameterCorrelation tab with synced charts

TASK 13:
- src/pages/FDRModule/ → add FlightTrack tab with Leaflet map + scrubber
- server/src/routes/ → add /api/fdr/track route

TASK 14:
- server/src/routes/ → add keyword matching logic in case description
- src/pages/FDRModule/ → add SuggestedParameters banner

TASK 15:
- server/src/routes/ → add /api/fdr/corrections route
- server/db/schema.sql → add corrections table
- src/pages/FDRModule/ → add correction controls + corrections log