import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Polyline, CircleMarker } from 'react-leaflet';
import {
    ResponsiveContainer,
    ComposedChart,
    CartesianGrid,
    XAxis,
    YAxis,
    Tooltip,
    Line,
    ReferenceLine,
    ReferenceArea,
    Legend,
} from "recharts";
import NotesPanel from "../components/NotesPanel";
import { fetchCaseByNumber, updateCase } from "../api/cases";
import { runFdrAnomalyDetection, fetchFdrSegments, fetchFdrPhases, fetchFdrOccurrence, saveFdrOccurrence, fetchFdrRules, fetchFdrCorrections, addFdrCorrection, deleteFdrCorrection } from "../api/anomaly";
import { useAuth } from "../hooks/useAuth";
import useRecentCases from "../hooks/useRecentCases";
import { buildCasePreview } from "../utils/caseDisplay";
import { evaluateModuleReadiness } from "../utils/analysisAvailability";
import { fetchAttachmentFromObjectStore } from "../utils/storage";
import { fdrParameterMap, fdrParameterConfig } from "../config/fdr-parameters";
import { createTimelineEntry, resolveActor } from "../utils/timeline";

const defaultCaseOptions = [
    {
        id: "AAI-UAE-2025-009",
        title: "Abu Dhabi Mid-Air Near Miss",
        aircraft: "A320-214",
        date: "12 Feb 2025",
        summary:
            "ATC intervention prevented conflict between Flight AZ217 and Flight FJ904 during climb out.",
    },
    {
        id: "AAI-UAE-2024-031",
        title: "Runway Excursion Investigation",
        aircraft: "Boeing 787-9",
        date: "28 Nov 2024",
        summary:
            "Aircraft veered left after touchdown in heavy crosswinds, triggering safety review.",
    },
    {
        id: "AAI-UAE-2025-014",
        title: "Engine Surge Event",
        aircraft: "A350-900",
        date: "04 Mar 2025",
        summary:
            "Crew reported repeated engine surges during climb with temporary loss of thrust.",
    },
];

const colorPalette = [
    "#059669",
    "#0ea5e9",
    "#f59e0b",
    "#6366f1",
    "#334155",
    "#10b981",
    "#34d399",
    "#22d3ee",
    "#0284c7",
    "#a855f7",
    "#f97316",
    "#ef4444",
    "#3b82f6",
    "#14b8a6",
    "#f472b6",
];

const normalizeHeader = (value = "") => String(value || "").trim().toLowerCase();

const knownParameterMetadata = fdrParameterMap.map((entry) => ({
    ...entry,
    normalizedId: normalizeHeader(entry.id),
    normalizedLabel: normalizeHeader(entry.label),
}));

const timeColumnExclusions = new Set([
    "session time",
    "system time",
    "gps date & time",
    // NASA DFDAU time components (synthesised into elapsed seconds)
    "gmt_hour",
    "gmt_minute",
    "gmt_min",
    "gmt_sec",
    // mat_to_excel row counter
    "sample #",
]);

const parameterGroupDefinitions = [
    {
        key: "engines-fuel",
        title: "Engines & Fuel",
        keywords: [
            "rpm",
            "manifold pressure",
            "fuel flow",
            "fuel pressure",
            "fuel level",
            "percent power",
            "egt",
            "cht",
            "thermocouple",
        ],
    },
    {
        key: "flight-dynamics-energy",
        title: "Flight Dynamics – Energy / Kinematics",
        keywords: [
            "indicated airspeed",
            "true airspeed",
            "ground speed",
            "vertical speed",
            "pressure altitude",
            "gps altitude",
            "density altitude",
            "angle of attack",
            "acceleration",
        ],
    },
    {
        key: "flight-dynamics-attitude",
        title: "Flight Dynamics – Attitude",
        keywords: ["pitch", "roll", "turn rate", "magnetic heading"],
    },
    {
        key: "navigation",
        title: "Navigation",
        keywords: [
            "latitude",
            "longitude",
            "ground track",
            "cross track error",
            "bearing",
            "range to destination",
        ],
    },
    {
        key: "environment",
        title: "Environment",
        keywords: ["oat", "wind speed", "wind direction", "barometer setting"],
    },
    {
        key: "autopilot-systems",
        title: "Autopilot/Systems",
        prefixes: ["ap", "cdi", "transponder"],
    },
    {
        key: "other",
        title: "Other / GP Inputs",
        keywords: ["gp input"],
        fallback: true,
    },
];

// Task 14 — keyword→parameter hint map for case description analysis.
// keywords: stem/partial strings matched anywhere in the description (e.g. "land" matches
// "landing", "landed"). paramKeywords: substrings matched against available parameter IDs/labels.
const DESCRIPTION_KEYWORD_PARAM_MAP = [
    {
        label: "Landing / Approach",
        keywords: ["land", "approach", "touch", "final", "flare", "glide"],
        paramKeywords: ["pitch", "roll", "ias", "indicated airspeed", "vertical speed", "gps alt", "glideslope", "glide slope"],
    },
    {
        label: "Engine / Power",
        keywords: ["engine", "power", "rpm", "throttle", "torque", "cylinder", "magneto"],
        paramKeywords: ["rpm", "manifold", "egt", "cht", "oil", "fuel flow", "torque"],
    },
    {
        label: "Turbulence / Weather",
        keywords: ["turbulence", "weather", "wind", "storm", "gust", "icing", "convect"],
        paramKeywords: ["vert accel", "vertical accel", "lat accel", "lateral accel", "wind speed", "wind dir", "oat", "outside air"],
    },
    {
        label: "Stall / Attitude",
        keywords: ["stall", "attitude", "nose up", "nose down", "pitch up", "pitch down", "aoa"],
        paramKeywords: ["aoa", "angle of attack", "pitch", "airspeed", "stall"],
    },
    {
        label: "Navigation / GPS",
        keywords: ["navig", "course", "deviat", "off course", "gps", "posit", "track", "bearing"],
        paramKeywords: ["cdi", "course", "heading", "gps fix", "cross track", "xtk", "latitude", "longitude", "ground track"],
    },
    {
        label: "Autopilot",
        keywords: ["autopilot", " ap "],
        paramKeywords: ["ap ", "autopilot"],
    },
    {
        label: "Tail / Pressure / Structural",
        keywords: ["tail", "press", "struct", "baro", "altim", "density"],
        paramKeywords: ["pitch", "roll", "vert accel", "vertical accel", "lat accel", "lateral accel", "baro", "barometr", "density alt", "pressure alt"],
    },
    {
        label: "Fuel",
        keywords: ["fuel", "tank", "reserve", "endurance"],
        paramKeywords: ["fuel remain", "fuel qty", "fuel flow", "fuel"],
    },
    {
        label: "Speed",
        keywords: ["overspeed", "underspeed", "vne", "vmo", "speed exceedance"],
        paramKeywords: ["indicated airspeed", "true airspeed", "ground speed", "ias", "tas"],
    },
    {
        label: "Vibration",
        keywords: ["vibrat", "shake", "shudder", "buffet", "roughness"],
        paramKeywords: ["vert accel", "vertical accel", "lat accel", "lateral accel"],
    },
];

const defaultVisibleChartsPerGroup = 3;
const maxChartPoints = 1200;
const timeSources = {
    session: "session",
    gps: "gps",
    index: "index",
};

const sampleNormalizedRows = [
    {
        time: 0,
        sessionTime: 0,
        "GPS Altitude (feet)": 1200,
        "Pressure Altitude (ft)": 1185,
        "Indicated Airspeed (knots)": 145,
        "Ground Speed (knots)": 140,
        "True Airspeed (knots)": 148,
        "Vertical Speed (ft/min)": 450,
        "Magnetic Heading (deg)": 92,
        "RPM L": 2200,
        "RPM R": 2180,
        "Fuel Flow 1 (gal/hr)": 8.2,
        "OAT (deg C)": 18,
        "Latitude (deg)": 24.45,
        "Longitude (deg)": 54.38,
        "Pitch (deg)": 3,
        "Roll (deg)": 0.2,
    },
    {
        time: 10,
        sessionTime: 10,
"GPS Altitude (feet)": 1800,
        "Pressure Altitude (ft)": 1782,
        "Indicated Airspeed (knots)": 152,
        "Ground Speed (knots)": 149,
        "True Airspeed (knots)": 156,
        "Vertical Speed (ft/min)": 520,
        "Magnetic Heading (deg)": 94,
        "RPM L": 2250,
        "RPM R": 2230,
        "Fuel Flow 1 (gal/hr)": 8.6,
        "OAT (deg C)": 17.5,
        "Latitude (deg)": 24.46,
        "Longitude (deg)": 54.39,
        "Pitch (deg)": 3.4,
        "Roll (deg)": 0.1,
    },
    {
        time: 20,
        sessionTime: 20,
        "GPS Altitude (feet)": 2400,
        "Pressure Altitude (ft)": 2388,
        "Indicated Airspeed (knots)": 160,
        "Ground Speed (knots)": 157,
        "True Airspeed (knots)": 164,
        "Vertical Speed (ft/min)": 580,
        "Magnetic Heading (deg)": 96,
        "RPM L": 2310,
        "RPM R": 2290,
        "Fuel Flow 1 (gal/hr)": 9.1,
        "OAT (deg C)": 17,
        "Latitude (deg)": 24.47,
        "Longitude (deg)": 54.41,
        "Pitch (deg)": 3.9,
        "Roll (deg)": -0.1,
    },
    {
        time: 30,
        sessionTime: 30,
        "GPS Altitude (feet)": 2900,
        "Pressure Altitude (ft)": 2885,
        "Indicated Airspeed (knots)": 166,
        "Ground Speed (knots)": 164,
        "True Airspeed (knots)": 171,
        "Vertical Speed (ft/min)": 540,
        "Magnetic Heading (deg)": 99,
        "RPM L": 2360,
        "RPM R": 2340,
        "Fuel Flow 1 (gal/hr)": 9.4,
        "OAT (deg C)": 16.4,
        "Latitude (deg)": 24.48,
        "Longitude (deg)": 54.42,
        "Pitch (deg)": 4.1,
        "Roll (deg)": -0.3,
    },
    {
        time: 40,
        sessionTime: 40,
        "GPS Altitude (feet)": 3200,
        "Pressure Altitude (ft)": 3190,
        "Indicated Airspeed (knots)": 170,
        "Ground Speed (knots)": 168,
        "True Airspeed (knots)": 176,
        "Vertical Speed (ft/min)": 510,
        "Magnetic Heading (deg)": 101,
        "RPM L": 2385,
        "RPM R": 2365,
        "Fuel Flow 1 (gal/hr)": 9.6,
        "OAT (deg C)": 16,
        "Latitude (deg)": 24.49,
        "Longitude (deg)": 54.43,
        "Pitch (deg)": 4.2,
        "Roll (deg)": -0.6,
    },
    {
        time: 50,
        sessionTime: 50,
        "GPS Altitude (feet)": 3600,
        "Pressure Altitude (ft)": 3592,
        "Indicated Airspeed (knots)": 176,
        "Ground Speed (knots)": 174,
        "True Airspeed (knots)": 181,
        "Vertical Speed (ft/min)": 470,
        "Magnetic Heading (deg)": 102,
        "RPM L": 2410,
        "RPM R": 2388,
        "Fuel Flow 1 (gal/hr)": 9.8,
        "OAT (deg C)": 15.6,
        "Latitude (deg)": 24.5,
        "Longitude (deg)": 54.44,
        "Pitch (deg)": 4.3,
        "Roll (deg)": -0.4,
    },
];

const detectionTrendKeys = [
    "GPS Altitude (feet)",
    "Indicated Airspeed (knots)",
    "RPM L",
    "RPM R",
    "Vertical Speed (ft/min)",
];

const analysisLabel = "Behavioral Anomaly Detection (Unsupervised)";
const INTERPRETATION_NOTE =
    "Interpretation is suggestive and requires investigator review.";
const interpretationRules = [
    {
        tag: "Vertical profile / maneuver",
        keywords: [
            "vertical speed",
            "pitch",
            "pressure altitude",
            "gps altitude",
            "vertical accel",
        ],
    },
    {
        tag: "Lateral maneuver / heading change",
        keywords: [
            "roll",
            "turn rate",
            "lateral accel",
            "ground track",
            "magnetic heading",
        ],
    },
    {
        tag: "Powerplant / propulsion change",
        keywords: [
            "rpm",
            "manifold pressure",
            "fuel flow",
            "oil pressure",
            "oil temp",
            "cht",
            "egt",
        ],
    },
    {
        tag: "Navigation / GPS signal quality",
        keywords: [
            "gps fix quality",
            "number of satellites",
            "mag var",
            "cross track error",
        ],
    },
    {
        tag: "Autopilot / control activity",
        keywords: [
            "ap roll force",
            "ap pitch force",
            "ap roll position",
            "ap pitch position",
            "ap engaged",
            "ap roll mode",
        ],
    },
];

const toNumber = (value) => {
    if (value === undefined || value === null) {
        return null;
    }

    const trimmedValue = typeof value === "string" ? value.trim() : value;
    if (trimmedValue === "") {
        return null;
    }

    const numeric = Number(trimmedValue);
    return Number.isFinite(numeric) ? numeric : null;
};

const parseSessionTime = (value) => {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    const raw = String(value).trim();
    if (!raw) {
        return null;
    }

    if (raw.includes(":")) {
        const parts = raw.split(":").map((part) => Number(part));
        if (parts.some((part) => Number.isNaN(part))) {
            return null;
        }

        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts;
            return hours * 3600 + minutes * 60 + seconds;
        }

        if (parts.length === 2) {
            const [minutes, seconds] = parts;
            return minutes * 60 + seconds;
        }
    }

    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
};

const getKnownParameterMatch = (header = "") => {
    const normalized = normalizeHeader(header);
    return (
        knownParameterMetadata.find(
            (entry) =>
                normalized === entry.normalizedId ||
                normalized === entry.normalizedLabel ||
                normalized.includes(entry.normalizedId)
        ) || null
    );
};

const parseParameterHeader = (header = "") => {
    const match = String(header).match(/\(([^)]+)\)\s*$/);
    const unit = match ? match[1].trim() : "";
    const label = match ? header.replace(match[0], "").trim() : header.trim();
    return { label, unit };
};

const getParameterDisplayMeta = (header = "") => {
    const known = getKnownParameterMatch(header);
    if (known) {
        return { label: known.label || header, unit: known.unit || "" };
    }

    return parseParameterHeader(header);
};

const getParameterLabel = (header) => getParameterDisplayMeta(header).label || header;

const isExcludedTimeColumn = (header = "") =>
    timeColumnExclusions.has(normalizeHeader(header));

const splitCsvLine = (line = "") => {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];

        if (char === "\"") {
            inQuotes = !inQuotes;
            continue;
        }

        if (char === "," && !inQuotes) {
            cells.push(current.trim());
            current = "";
            continue;
        }

        current += char;
    }

    cells.push(current.trim());
    return cells;
};

const parseCsvRows = (text) => {
    if (!text) {
        return { headers: [], rows: [] };
    }

    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length < 2) {
        return { headers: [], rows: [] };
    }

    const headers = splitCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => {
        const cells = splitCsvLine(line);
        const row = {};

        headers.forEach((header, index) => {
            row[header] = cells[index] || "";
        });

        return row;
    });

    return { headers, rows };
};

const formatSessionTime = (value) => {
    if (value === null || value === undefined) {
        return "";
    }

    const seconds = Math.max(0, Math.floor(value));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
            2,
            "0"
        )}:${String(remainingSeconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(
        2,
        "0"
    )}`;
};

const formatNumericValue = (value) => {
    if (!Number.isFinite(value)) {
        return "—";
    }
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
};

// ── Phase detection constants (Task 7) ────────────────────────────────────────
const PHASE_COLORS = {
    TAKEOFF: "#22c55e",
    CLIMB:   "#3b82f6",
    CRUISE:  "#94a3b8",
    DESCENT: "#f97316",
    LANDING: "#ef4444",
};

const PHASE_OPACITY = {
    TAKEOFF: 0.12,
    CLIMB:   0.08,
    CRUISE:  0.08,
    DESCENT: 0.08,
    LANDING: 0.12,
};

const PHASE_ORDER = ["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "LANDING"];

const formatPhaseDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const formatAnalysisTimestamp = (value) => {
    if (!value) {
        return "—";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
};

const formatAnalysisRunLabel = (timestamp, runMeta) => {
    const base = formatAnalysisTimestamp(timestamp);
    const createdBy = runMeta?.createdBy?.name || runMeta?.createdBy?.email;
    return createdBy ? `${base} by ${createdBy}` : base;
};

const detectFdrCsvFormat = (headers) => {
    const set = new Set(headers.map((h) => h.trim()));
    if (set.has("Session Time")) return "ga";
    if (set.has("GMT_HOUR")) return "nasa";
    return "generic";
};

const normalizeFdrRows = (csvText) => {
    // Binary Excel (xlsx = ZIP file) starts with the PK magic bytes.
    // response.text() on a binary file decodes them as "PK" + control chars.
    if (csvText.startsWith("PK")) {
        const err = new Error(
            "Excel (.xlsx) files cannot be previewed in the browser. " +
            "Convert the file to CSV to see parameter charts here. " +
            "The analysis will still run using the uploaded Excel file."
        );
        err.isExcelFormat = true;
        throw err;
    }

    const { headers, rows: rawRows } = parseCsvRows(csvText);
    const format = detectFdrCsvFormat(headers);

    // NASA mat_to_excel exports have a units row (all strings) as the first data row.
    // Detect it by checking whether the first row has no numeric values at all.
    let dataRows = rawRows;
    if (format === "nasa" && rawRows.length > 0) {
        const firstIsUnits = headers.every((h) => toNumber(rawRows[0][h]) === null);
        if (firstIsUnits) dataRows = rawRows.slice(1);
    }

    const numericHeaders = headers.filter(
        (header) =>
            !isExcludedTimeColumn(header) &&
            dataRows.some((row) => toNumber(row[header]) !== null)
    );

    // Pre-compute NASA base time so elapsed seconds start near 0.
    let nasaBaseSeconds = 0;
    if (format === "nasa" && dataRows.length > 0) {
        const first = dataRows[0];
        const h = toNumber(first["GMT_HOUR"]) ?? 0;
        const m = toNumber(first["GMT_MINUTE"] !== undefined ? first["GMT_MINUTE"] : first["GMT_MIN"]) ?? 0;
        const s = toNumber(first["GMT_SEC"]) ?? 0;
        nasaBaseSeconds = h * 3600 + m * 60 + s;
    }

    const rows = dataRows.map((row, index) => {
        let normalizedTime = index;

        if (format === "ga") {
            const sessionSeconds = parseSessionTime(row["Session Time"]);
            normalizedTime = sessionSeconds !== null ? sessionSeconds : index;
        } else if (format === "nasa") {
            const h = toNumber(row["GMT_HOUR"]) ?? 0;
            const m = toNumber(row["GMT_MINUTE"] !== undefined ? row["GMT_MINUTE"] : row["GMT_MIN"]) ?? 0;
            const s = toNumber(row["GMT_SEC"]) ?? 0;
            normalizedTime = h * 3600 + m * 60 + s - nasaBaseSeconds;
        } else {
            // generic: use first time-like numeric column found
            const timeCol = headers.find(
                (h) => /time|sec|elapsed/i.test(h) && !isExcludedTimeColumn(h)
            );
            if (timeCol) {
                const t = toNumber(row[timeCol]);
                if (t !== null) normalizedTime = t;
            }
        }

        const normalized = { time: normalizedTime, sessionTime: normalizedTime, rowIndex: index };
        numericHeaders.forEach((header) => {
            const value = toNumber(row[header]);
            if (value !== null) normalized[header] = value;
        });
        return normalized;
    });

    const sortedRows = [...rows].sort((a, b) => a.time - b.time);
    return { rows: sortedRows, numericHeaders, timeSource: timeSources.session };
};

const hasNumericValue = (row, keys) =>
    keys.some((key) => typeof row[key] === "number" && !Number.isNaN(row[key]));

const downsampleSeries = (series, maxPoints = maxChartPoints) => {
    if (series.length <= maxPoints) {
        return series;
    }
    const bucketSize = Math.ceil(series.length / maxPoints);
    const sampled = [];
    for (let i = 0; i < series.length; i += bucketSize) {
        const bucket = series.slice(i, i + bucketSize);
        if (!bucket.length) {
            continue;
        }
        const sums = {};
        const counts = {};
        let timeSum = 0;
        let timeCount = 0;
        bucket.forEach((point) => {
            if (Number.isFinite(point.time)) {
                timeSum += point.time;
                timeCount += 1;
            }
            Object.entries(point).forEach(([key, value]) => {
                if (key === "time") {
                    return;
                }
                if (typeof value === "number" && !Number.isNaN(value)) {
                    sums[key] = (sums[key] || 0) + value;
                    counts[key] = (counts[key] || 0) + 1;
                }
            });
        });
        if (!timeCount) {
            continue;
        }
        const averaged = { time: timeSum / timeCount };
        Object.keys(sums).forEach((key) => {
            averaged[key] = sums[key] / counts[key];
        });
        sampled.push(averaged);
    }
    return sampled;
};

const downsampleEvidenceSeries = (series, maxPoints = 800) => {
    if (series.length <= maxPoints) {
        return series;
    }
    const bucketSize = Math.ceil(series.length / maxPoints);
    const sampled = [];
    for (let i = 0; i < series.length; i += bucketSize) {
        const bucket = series.slice(i, i + bucketSize);
        if (!bucket.length) {
            continue;
        }
        let timeSum = 0;
        let timeCount = 0;
        let valueSum = 0;
        let valueCount = 0;
        bucket.forEach((point) => {
            if (Number.isFinite(point.time)) {
                timeSum += point.time;
                timeCount += 1;
            }
            if (typeof point.value === "number" && !Number.isNaN(point.value)) {
                valueSum += point.value;
                valueCount += 1;
            }
        });
        if (!timeCount || !valueCount) {
            continue;
        }
        sampled.push({
            time: timeSum / timeCount,
            value: valueSum / valueCount,
        });
    }
    return sampled;
};

const deriveAvailableParameters = (rows, orderedHeaders = []) => {
    const available = new Set();

    orderedHeaders.forEach((header) => {
        if (rows.some((row) => hasNumericValue(row, [header]))) {
            available.add(header);
        }
    });

    if (available.size === 0) {
        rows.forEach((row) => {
            Object.entries(row).forEach(([key, value]) => {
                if (
                    key !== "time" &&
                    key !== "sessionTime" &&
                    key !== "rowIndex" &&
                    typeof value === "number" &&
                    !Number.isNaN(value)
                ) {
                    available.add(key);
                }
            });
        });
    }

    return Array.from(available);
};

const buildParameterTable = (rows, parameters) =>
    parameters
        .map((parameter) => {
            const values = rows
                .map((row) => row[parameter])
                .filter((value) => typeof value === "number" && !Number.isNaN(value));

            if (values.length === 0) {
                return null;
            }

            const min = Math.min(...values);
            const max = Math.max(...values);
            const { label, unit } = getParameterDisplayMeta(parameter);

            return {
                parameter: label || parameter,
                unit: unit || "",
                min: Number(min.toFixed(1)),
                max: Number(max.toFixed(1)),
            };
        })
        .filter(Boolean);

const buildDetectionTrendSeries = (rows) =>
    downsampleSeries(
        rows
            .filter(
                (row) =>
                    typeof row.time === "number" &&
                    hasNumericValue(row, detectionTrendKeys)
            )
            .map((row) => {
                const entry = { time: row.time };
                detectionTrendKeys.forEach((key) => {
                    if (row[key] !== undefined) {
                        entry[key] = row[key];
                    }
                });
                return entry;
            }),
        480
    );

const buildScoreTimelineSeries = (timeline, mapTimeValue) => {
    if (!timeline || !Array.isArray(timeline.time) || !Array.isArray(timeline.score)) {
        return [];
    }

    const length = Math.min(timeline.time.length, timeline.score.length);
    const series = Array.from({ length }, (_, index) => ({
        time: mapTimeValue ? mapTimeValue(Number(timeline.time[index])) : Number(timeline.time[index]),
        score: timeline.score[index],
    }))
        .filter((entry) => Number.isFinite(entry.time))
        .sort((a, b) => a.time - b.time);

    return downsampleSeries(series, 480);
};

const deriveInterpretationTags = (driverLabels = []) => {
    const normalizedLabels = driverLabels
        .map((label) => normalizeHeader(label))
        .filter(Boolean);

    const rankedTags = interpretationRules
        .map((rule, index) => {
            const matches = normalizedLabels.filter((label) =>
                rule.keywords.some((keyword) =>
                    label.includes(normalizeHeader(keyword))
                )
            );
            return {
                tag: rule.tag,
                count: matches.length,
                index,
            };
        })
        .filter((entry) => entry.count > 0)
        .sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return a.index - b.index;
        });

    return rankedTags.slice(0, 2).map((entry) => entry.tag);
};

const summarizeSeriesProfile = (data = [], key) => {
    const values = data
        .map((row) => row?.[key])
        .filter((value) => typeof value === "number" && !Number.isNaN(value));

    if (values.length === 0) {
        return { isBinary: false, isLowCardinality: false, isMultiScale: false };
    }

    const uniqueValues = new Set(values);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const spread = max - min;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const isBinary =
        uniqueValues.size <= 2 &&
        Array.from(uniqueValues).every((value) => value === 0 || value === 1);
    const isLowCardinality = uniqueValues.size <= 6;
    const isMultiScale = Math.abs(spread) > Math.max(1000, Math.abs(mean) * 25);

    return { isBinary, isLowCardinality, isMultiScale };
};

const getSeriesRenderConfig = (data = [], key) => {
    summarizeSeriesProfile(data, key);
    return { variant: "line", lineType: "monotone" };
};

const getEvidenceSeriesRenderConfig = (data = [], key) => {
    const profile = summarizeSeriesProfile(data, key);
    const lineType =
        profile.isBinary || profile.isLowCardinality ? "stepAfter" : "monotone";
    return { variant: "line", lineType };
};

const sampleParameterHeaders = Object.keys(sampleNormalizedRows[0] || {}).filter(
    (key) => key !== "time" && key !== "sessionTime" && key !== "rowIndex"
);
const defaultAvailableParameters = deriveAvailableParameters(
    sampleNormalizedRows,
    sampleParameterHeaders
);
const defaultParameterTableRows = buildParameterTable(
    sampleNormalizedRows,
    defaultAvailableParameters
);
const defaultDetectionTrendSamples = buildDetectionTrendSeries(sampleNormalizedRows);
const PENDING_FDR_RUN_KEY = "fdrPendingRun";

const readPendingFdrRun = () => {
    if (typeof window === "undefined") {
        return null;
    }

    try {
        const stored = window.localStorage.getItem(PENDING_FDR_RUN_KEY);
        return stored ? JSON.parse(stored) : null;
    } catch (_error) {
        return null;
    }
};

const writePendingFdrRun = (payload) => {
    if (typeof window === "undefined") {
        return;
    }

    try {
        window.localStorage.setItem(PENDING_FDR_RUN_KEY, JSON.stringify(payload));
    } catch (_error) {
        // Ignore storage errors.
    }
};

const clearPendingFdrRun = () => {
    if (typeof window === "undefined") {
        return;
    }

    try {
        window.localStorage.removeItem(PENDING_FDR_RUN_KEY);
    } catch (_error) {
        // Ignore storage errors.
    }
};

const isNewerTimestamp = (candidate, baseline) => {
    if (!candidate) {
        return false;
    }

    const candidateTime = new Date(candidate).getTime();
    if (!Number.isFinite(candidateTime)) {
        return false;
    }

    if (!baseline) {
        return true;
    }

    const baselineTime = new Date(baseline).getTime();
    if (!Number.isFinite(baselineTime)) {
        return true;
    }

    return candidateTime > baselineTime;
};

export default function FDR({ caseNumber: propCaseNumber }) {
    const { caseNumber: routeCaseNumber } = useParams();
    const caseNumber = propCaseNumber || routeCaseNumber;
    const navigate = useNavigate();
    const { user } = useAuth();
    const [selectedCase, setSelectedCase] = useState(null);
    const [isRunningDetection, setIsRunningDetection] = useState(false);
    const [detectionTrendData, setDetectionTrendData] = useState(
        defaultDetectionTrendSamples
    );
    const [parameterTableRows, setParameterTableRows] = useState(
        defaultParameterTableRows
    );
    const [availableParameters, setAvailableParameters] = useState(
        defaultAvailableParameters
    );
    const [normalizedRows, setNormalizedRows] = useState(sampleNormalizedRows);
    const [chartFilterText, setChartFilterText] = useState("");
    const [expandedGroups, setExpandedGroups] = useState(() => new Set());
    const [expandedSegments, setExpandedSegments] = useState(() => new Set());
    const [anomalyResult, setAnomalyResult] = useState(null);
    const [anomalyError, setAnomalyError] = useState("");
    const [flightSegments, setFlightSegments] = useState(null);
    const [selectedFlightIndex, setSelectedFlightIndex] = useState(null);
    const [segmentDetectionMethod, setSegmentDetectionMethod] = useState("");
    const [segmentDetectionBadge, setSegmentDetectionBadge] = useState("groundspeed");
    const [isLoadingSegments, setIsLoadingSegments] = useState(false);
    const [segmentError, setSegmentError] = useState("");
    const [flightPhases, setFlightPhases] = useState(null);
    const [selectedPhaseKey, setSelectedPhaseKey] = useState(null);
    const [phaseDetectionBadge, setPhaseDetectionBadge] = useState("vs_ias");
    const [isLoadingPhases, setIsLoadingPhases] = useState(false);
    const [phaseError, setPhaseError] = useState("");
    const [occurrenceWindow, setOccurrenceWindow] = useState(null); // {start, end, label}
    const [dragStartTime, setDragStartTime] = useState(null);
    const [dragCurrentTime, setDragCurrentTime] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [correlationParams, setCorrelationParams] = useState([]);
    const [correlationSearch, setCorrelationSearch] = useState("");
    const [correlationSelectorOpen, setCorrelationSelectorOpen] = useState(true);
    const [suggestionDismissed, setSuggestionDismissed] = useState(false);
    const [whyExpanded, setWhyExpanded] = useState(false);
    const [mapTrackOpen, setMapTrackOpen] = useState(false);
    const [mapScrubTime, setMapScrubTime] = useState(null);
    const [rulesResult, setRulesResult] = useState(null);
    const [rulesWasAttempted, setRulesWasAttempted] = useState(false);
    const [detectionMethodFilter, setDetectionMethodFilter] = useState("all");
    const [rulesCheckedOpen, setRulesCheckedOpen] = useState(false);
    const [corrections, setCorrections] = useState([]);
    const [correctionForms, setCorrectionForms] = useState({});
    const [correctionsLogOpen, setCorrectionsLogOpen] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState(null);
    const [dismissedOpen, setDismissedOpen] = useState(false);
    const [phaseEditMode, setPhaseEditMode] = useState(false);
    const [phaseCorrectionForm, setPhaseCorrectionForm] = useState({});
    const [phaseEditNote, setPhaseEditNote] = useState('');
    const [isLoadingFdrData, setIsLoadingFdrData] = useState(false);
    const [fdrDataError, setFdrDataError] = useState("");
    const [caseSummaryCopied, setCaseSummaryCopied] = useState(false);
    const [analysisTimestamp, setAnalysisTimestamp] = useState(null);
    const [analysisRunMeta, setAnalysisRunMeta] = useState(null);
    const selectedCaseRef = useRef(null);
    const detectionStartRef = useRef(null);
    const chartsRef = useRef(null);
    const isLinkedRoute = Boolean(caseNumber);
    const [workflowStage, setWorkflowStage] = useState(
        isLinkedRoute ? "analysis" : "caseSelection"
    );
    const [analysisEntryChoice, setAnalysisEntryChoice] = useState(null);
    const pendingRunRef = useRef(null);
    const detectionScopeLabel =
        availableParameters.length > 0
            ? "All numeric parameters"
            : "No numeric parameters were detected in the uploaded file.";
    const parameterDisplayMap = useMemo(() => {
        const map = {};
        (availableParameters || []).forEach((parameter, index) => {
            const display = getParameterDisplayMeta(parameter);
            map[parameter] = {
                ...display,
                label: display.label || parameter,
                color: colorPalette[index % colorPalette.length],
            };
        });
        return map;
    }, [availableParameters]);

    useEffect(() => {
        selectedCaseRef.current = selectedCase;
    }, [selectedCase]);

    useEffect(() => {
        if (!caseNumber) {
            pendingRunRef.current = null;
            return;
        }

        const pending = readPendingFdrRun();
        if (!pending || pending.caseNumber !== caseNumber) {
            pendingRunRef.current = null;
            return;
        }

        pendingRunRef.current = pending;
        setIsRunningDetection(true);
        setWorkflowStage("detectionRunning");
        setAnomalyError("");
    }, [caseNumber]);

    useEffect(() => {
        if (!caseNumber) {
            setAnalysisEntryChoice(null);
            return;
        }

        setAnalysisEntryChoice(null);
    }, [caseNumber]);

    const resolveTimelineActor = useCallback(() => {
        const fallback =
            selectedCaseRef.current?.source?.owner ||
            selectedCaseRef.current?.source?.examiner ||
            selectedCaseRef.current?.source?.investigator?.name ||
            "Unknown";
        return resolveActor({ user, fallback });
    }, [user]);

    const formatDuration = useCallback((durationMs) => {
        if (!Number.isFinite(durationMs)) {
            return "—";
        }

        const totalSeconds = Math.max(Math.round(durationMs / 1000), 0);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        }

        return `${seconds}s`;
    }, []);

    const formatAnalysisActor = useCallback((actor) => {
        if (!actor) {
            return "Unknown";
        }

        if (typeof actor === "string") {
            return actor;
        }

        return actor.name || actor.email || "Unknown";
    }, []);

    const appendTimelineEntry = useCallback(
        async ({ entry, extraUpdates = {} }) => {
            const current = selectedCaseRef.current?.source;
            if (!current || !caseNumber) {
                return;
            }

            const existingTimeline = Array.isArray(current.timeline)
                ? current.timeline
                : [];
            const nextTimeline = [...existingTimeline, entry];
            const nextSource = { ...current, ...extraUpdates, timeline: nextTimeline };

            setSelectedCase((prev) =>
                prev ? { ...prev, source: nextSource } : prev
            );

            try {
                const updated = await updateCase(caseNumber, nextSource);
                if (updated) {
                    setSelectedCase(buildCasePreview(updated));
                }
            } catch (_error) {
                // Ignore timeline update failures for now.
            }
        },
        [caseNumber]
    );
    const filteredParameters = useMemo(() => {
        const filter = chartFilterText.trim().toLowerCase();
        if (!filter) {
            return availableParameters;
        }

        return (availableParameters || []).filter((parameter) => {
            const meta = parameterDisplayMap[parameter];
            const label = meta?.label || parameter;
            return (
                label.toLowerCase().includes(filter) ||
                parameter.toLowerCase().includes(filter)
            );
        });
    }, [availableParameters, chartFilterText, parameterDisplayMap]);
    const groupedParameters = useMemo(() => {
        const groups = parameterGroupDefinitions.map((definition) => ({
            ...definition,
            parameters: [],
        }));
        const fallbackGroup = groups.find((group) => group.fallback);

        const matchGroup = (parameter) => {
            const meta = parameterDisplayMap[parameter];
            const label = meta?.label || parameter;
            const normalized = normalizeHeader(`${label} ${parameter}`);

            return (
                groups.find((group) => {
                    if (group.keywords?.length) {
                        return group.keywords.some((keyword) =>
                            normalized.includes(normalizeHeader(keyword))
                        );
                    }

                    if (group.prefixes?.length) {
                        return group.prefixes.some((prefix) => {
                            const normalizedPrefix = normalizeHeader(prefix);
                            return (
                                normalizeHeader(parameter).startsWith(normalizedPrefix) ||
                                normalizeHeader(label).startsWith(normalizedPrefix)
                            );
                        });
                    }

                    return false;
                }) || fallbackGroup
            );
        };

        filteredParameters.forEach((parameter) => {
            const group = matchGroup(parameter);
            if (group) {
                group.parameters.push(parameter);
            }
        });

        return groups.filter((group) => group.parameters.length > 0);
    }, [filteredParameters, parameterDisplayMap]);
    const analyzedParameters = useMemo(() => {
        const labels = (availableParameters || []).map((parameter) => {
            const meta = parameterDisplayMap[parameter];
            return meta?.label || parameter;
        });
        return Array.from(new Set(labels));
    }, [availableParameters, parameterDisplayMap]);
    const segments = useMemo(() => {
        if (!anomalyResult) {
            return [];
        }

        const list =
            anomalyResult.segments ||
            anomalyResult.segment ||
            anomalyResult.anomalies ||
            anomalyResult.sampleRows ||
            anomalyResult.samples;

        // Hard frontend cap — guards against stale DB records (pre-cap) or
        // any future Python path that bypasses the server-side 10-segment limit.
        const raw = Array.isArray(list) ? list : [];
        return raw.slice(0, 10);
    }, [anomalyResult]);
    const analysisTitle = analysisLabel;
    const timeAxisLabel = "Session Time";
    const formatFlightTime = useCallback(
        (value) => {
            if (!Number.isFinite(value)) {
                return "";
            }
            return formatSessionTime(value);
        },
        []
    );

    const handleChartMouseDown = useCallback((chartEvent) => {
        const time = chartEvent?.activeLabel;
        if (typeof time !== "number" || !Number.isFinite(time)) return;
        setDragStartTime(time);
        setDragCurrentTime(time);
        setIsDragging(true);
    }, []);

    const handleChartMouseMove = useCallback((chartEvent) => {
        if (!isDragging) return;
        const time = chartEvent?.activeLabel;
        if (typeof time === "number" && Number.isFinite(time)) {
            setDragCurrentTime(time);
        }
    }, [isDragging]);

    const timeDomain = useMemo(() => {
        const values = normalizedRows
            .map((row) => row.time)
            .filter((value) => Number.isFinite(value));
        if (values.length === 0) {
            return null;
        }
        return { min: Math.min(...values), max: Math.max(...values) };
    }, [normalizedRows]);

    // Rows visible in charts — sliced to the selected flight segment when active.
    const filteredRows = useMemo(() => {
        if (selectedFlightIndex === null || !flightSegments || flightSegments.length === 0) {
            return normalizedRows;
        }
        const seg = flightSegments.find((s) => s.flight_index === selectedFlightIndex);
        if (!seg) return normalizedRows;
        return normalizedRows.filter(
            (r) => typeof r.time === "number" && r.time >= seg.start_time && r.time <= seg.end_time
        );
    }, [normalizedRows, flightSegments, selectedFlightIndex]);

    const filteredParameterTableRows = useMemo(
        () => buildParameterTable(filteredRows, availableParameters),
        [filteredRows, availableParameters]
    );

    // Detection badge styling for the FlightSegmentSelector.
    const segmentBadgeClass = useMemo(() => {
        if (segmentDetectionBadge === "ias") {
            return "bg-emerald-100 text-emerald-800 border border-emerald-200";
        }
        if (segmentDetectionBadge === "altitude") {
            return "bg-amber-100 text-amber-800 border border-amber-200";
        }
        return "bg-gray-100 text-gray-600 border border-gray-200";
    }, [segmentDetectionBadge]);

    const segmentBadgeLabel = useMemo(() => {
        if (segmentDetectionBadge === "ias") return "IAS-based";
        if (segmentDetectionBadge === "altitude") return "Altitude-based";
        return "Ground speed fallback";
    }, [segmentDetectionBadge]);

    // Rows visible in phase-filtered charts — stacks on top of filteredRows.
    const chartRows = useMemo(() => {
        if (!selectedPhaseKey || !flightPhases || flightPhases.length === 0) {
            return filteredRows;
        }
        const phaseSegs = flightPhases.filter((p) => p.phase === selectedPhaseKey);
        if (phaseSegs.length === 0) return filteredRows;
        return filteredRows.filter(
            (r) =>
                typeof r.time === "number" &&
                phaseSegs.some((seg) => r.time >= seg.start_time && r.time <= seg.end_time)
        );
    }, [filteredRows, flightPhases, selectedPhaseKey]);

    // Per-param min/max over the current chartRows — used to normalize values 0-1
    // and to un-normalize them in the tooltip formatter.
    const correlationRanges = useMemo(() => {
        if (correlationParams.length === 0) return {};
        const ranges = {};
        correlationParams.forEach((p) => {
            let min = Infinity;
            let max = -Infinity;
            chartRows.forEach((row) => {
                const v = row[p];
                if (typeof v === "number" && !Number.isNaN(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            });
            if (Number.isFinite(min) && Number.isFinite(max)) {
                ranges[p] = { min, max };
            }
        });
        return ranges;
    }, [chartRows, correlationParams]);

    // Multi-param chart data: raw values downsampled then normalized per-param to [0, 1].
    // Each row: { time, [param]: normalizedVal, [param+"__raw"]: actualVal }
    const correlationChartData = useMemo(() => {
        if (correlationParams.length === 0) return [];
        const raw = chartRows
            .filter((row) => typeof row.time === "number")
            .map((row) => {
                const point = { time: row.time };
                correlationParams.forEach((p) => {
                    const v = row[p];
                    if (typeof v === "number" && !Number.isNaN(v)) {
                        point[p] = v;
                    }
                });
                return point;
            });
        const sampled = downsampleSeries(raw, 1200);
        return sampled.map((point) => {
            const out = { time: point.time };
            correlationParams.forEach((p) => {
                const r = correlationRanges[p];
                const v = point[p];
                if (r && typeof v === "number" && !Number.isNaN(v)) {
                    const span = r.max - r.min;
                    out[p] = span > 0 ? (v - r.min) / span : 0.5;
                    out[p + "__raw"] = v;
                }
            });
            return out;
        });
    }, [chartRows, correlationParams, correlationRanges]);

    // Total duration per unique phase type (for legend display).
    const phaseAggregate = useMemo(() => {
        if (!flightPhases) return {};
        return flightPhases.reduce((acc, p) => {
            acc[p.phase] = (acc[p.phase] || 0) + p.duration_s;
            return acc;
        }, {});
    }, [flightPhases]);

    // Deduplicated/aggregated phases — guaranteed max 5 items regardless of
    // how many raw segments Python returned. Used for ReferenceArea bands and
    // the phase bar to prevent memory crashes on noisy high-frequency data.
    const groupedPhases = useMemo(() => {
        if (!flightPhases || flightPhases.length === 0) return [];
        const agg = {};
        flightPhases.forEach((seg) => {
            if (!agg[seg.phase]) {
                agg[seg.phase] = {
                    phase: seg.phase,
                    duration_s: seg.duration_s,
                    start_time: seg.start_time,
                    end_time: seg.end_time,
                };
            } else {
                agg[seg.phase].duration_s += seg.duration_s;
                agg[seg.phase].start_time = Math.min(agg[seg.phase].start_time, seg.start_time);
                agg[seg.phase].end_time = Math.max(agg[seg.phase].end_time, seg.end_time);
            }
        });
        return PHASE_ORDER.filter((ph) => agg[ph]).map((ph) => agg[ph]);
    }, [flightPhases]);

    const phaseBadgeClass = useMemo(() => {
        if (phaseDetectionBadge === "vs_ias") {
            return "bg-emerald-100 text-emerald-800 border border-emerald-200";
        }
        if (phaseDetectionBadge === "vs_only") {
            return "bg-amber-100 text-amber-800 border border-amber-200";
        }
        return "bg-gray-100 text-gray-600 border border-gray-200";
    }, [phaseDetectionBadge]);

    const phaseBadgeLabel = useMemo(() => {
        if (phaseDetectionBadge === "vs_ias") return "VS + IAS";
        if (phaseDetectionBadge === "vs_only") return "VS only";
        return "Altitude fallback";
    }, [phaseDetectionBadge]);

    // Auto-load flight segments whenever a new case with FDR data is opened.
    useEffect(() => {
        if (!caseNumber || !selectedCase?.source) {
            setFlightSegments(null);
            setSelectedFlightIndex(null);
            setSegmentError("");
            return;
        }

        const attachments = Array.isArray(selectedCase.source.attachments)
            ? selectedCase.source.attachments
            : [];
        const hasFdr = attachments.some((item) => {
            const type = (item?.type || "").toUpperCase();
            const name = (item?.name || "").toLowerCase();
            const key = item?.storage?.objectKey || item?.storage?.key;
            return Boolean(key) && (type === "FDR" || name.endsWith(".csv") || name.includes("fdr"));
        });

        if (!hasFdr) {
            setFlightSegments(null);
            return;
        }

        let isMounted = true;
        setIsLoadingSegments(true);
        setSegmentError("");
        setFlightSegments(null);
        setSelectedFlightIndex(null);

        fetchFdrSegments(caseNumber)
            .then((result) => {
                if (!isMounted) return;
                setFlightSegments(result?.segments || []);
                setSegmentDetectionMethod(result?.detection_method || "");
                setSegmentDetectionBadge(result?.detection_badge || "groundspeed");
            })
            .catch((err) => {
                if (!isMounted) return;
                setSegmentError(err?.message || "Unable to detect flight segments.");
            })
            .finally(() => {
                if (isMounted) setIsLoadingSegments(false);
            });

        return () => { isMounted = false; };
    }, [caseNumber, selectedCase]);

    // Auto-load flight phases in parallel with segment detection.
    useEffect(() => {
        if (!caseNumber || !selectedCase?.source) {
            setFlightPhases(null);
            setSelectedPhaseKey(null);
            setPhaseError("");
            return;
        }

        const attachments = Array.isArray(selectedCase.source.attachments)
            ? selectedCase.source.attachments
            : [];
        const hasFdr = attachments.some((item) => {
            const type = (item?.type || "").toUpperCase();
            const name = (item?.name || "").toLowerCase();
            const key = item?.storage?.objectKey || item?.storage?.key;
            return Boolean(key) && (type === "FDR" || name.endsWith(".csv") || name.includes("fdr"));
        });

        if (!hasFdr) {
            setFlightPhases(null);
            return;
        }

        let isMounted = true;
        setIsLoadingPhases(true);
        setPhaseError("");
        setFlightPhases(null);
        setSelectedPhaseKey(null);

        fetchFdrPhases(caseNumber)
            .then((result) => {
                if (!isMounted) return;
                setFlightPhases(result?.phases || []);
                setPhaseDetectionBadge(result?.detection_badge || "alt_only");
            })
            .catch((err) => {
                if (!isMounted) return;
                setPhaseError(err?.message || "Phase detection unavailable.");
            })
            .finally(() => {
                if (isMounted) setIsLoadingPhases(false);
            });

        return () => { isMounted = false; };
    }, [caseNumber, selectedCase]);

    // Auto-load saved occurrence window when a case opens.
    useEffect(() => {
        if (!caseNumber) {
            setOccurrenceWindow(null);
            return;
        }
        fetchFdrOccurrence(caseNumber)
            .then((result) => {
                if (result?.start != null && result?.end != null) {
                    setOccurrenceWindow(result);
                } else {
                    setOccurrenceWindow(null);
                }
            })
            .catch(() => setOccurrenceWindow(null));
    }, [caseNumber]);

    // Auto-load saved corrections when a case opens.
    useEffect(() => {
        if (!caseNumber) {
            setCorrections([]);
            return;
        }
        fetchFdrCorrections(caseNumber)
            .then((result) => setCorrections(Array.isArray(result) ? result : []))
            .catch(() => setCorrections([]));
    }, [caseNumber]);

    // Global mouseup listener — captures drag release even when mouse leaves chart.
    useEffect(() => {
        if (!isDragging) return;
        const handleMouseUp = () => {
            setIsDragging(false);
            setDragStartTime((startTime) => {
                setDragCurrentTime((currentTime) => {
                    if (startTime !== null && currentTime !== null) {
                        const start = Math.min(startTime, currentTime);
                        const end = Math.max(startTime, currentTime);
                        if (end - start >= 1) {
                            setFlightPhases((phases) => {
                                const mid = (start + end) / 2;
                                const matchedPhase = Array.isArray(phases)
                                    ? phases.find((p) => mid >= p.start_time && mid <= p.end_time)
                                    : null;
                                const label = matchedPhase?.phase ?? "";
                                const newWindow = { start, end, label };
                                setOccurrenceWindow(newWindow);
                                saveFdrOccurrence(caseNumber, newWindow).catch(() => {});
                                return phases; // no change to phases
                            });
                        }
                    }
                    return null;
                });
                return null;
            });
        };
        window.addEventListener("mouseup", handleMouseUp);
        return () => window.removeEventListener("mouseup", handleMouseUp);
    }, [isDragging, caseNumber]);

    const timeIndexMap = useMemo(() => {
        const map = new Map();
        normalizedRows.forEach((row) => {
            if (Number.isInteger(row.rowIndex) && Number.isFinite(row.time)) {
                map.set(row.rowIndex, row.time);
            }
        });
        return map;
    }, [normalizedRows]);
    const mapTimeValue = useCallback(
        (value) => {
            if (!Number.isFinite(value)) {
                return null;
            }
            if (!timeDomain) {
                return value;
            }
            if (value < timeDomain.min || value > timeDomain.max) {
                if (Number.isInteger(value) && timeIndexMap.has(value)) {
                    return timeIndexMap.get(value);
                }
            }
            return value;
        },
        [timeDomain, timeIndexMap]
    );
    useEffect(() => {
        if (!anomalyResult) {
            return;
        }

        const anomalyCountForLog =
            anomalyResult.summary?.segments_found ??
            anomalyResult.anomalyCount ??
            anomalyResult.detectedCount ??
            anomalyResult.anomalies?.length ??
            anomalyResult.count ??
            null;

        console.debug("[FDR] Detection result state updated", {
            anomalyCount: anomalyCountForLog,
            segments: segments.length,
            totalRows:
                anomalyResult.summary?.n_rows ??
                anomalyResult.totalRows ??
                anomalyResult.evaluatedRows ??
                anomalyResult.total ??
                anomalyResult.total_rows ??
                (Array.isArray(normalizedRows) ? normalizedRows.length : undefined),
        });
    }, [anomalyResult, normalizedRows, segments.length]);
    const { recentCases, loading: isRecentLoading, error: recentCasesError } =
        useRecentCases(3);
    const caseSelectionOptions = useMemo(() => {
        const mapped = recentCases
            .map((item) => buildCasePreview(item))
            .filter(Boolean);
        return mapped.length > 0 ? mapped : defaultCaseOptions;
    }, [recentCases]);
    const [linkError, setLinkError] = useState("");
    const [missingDataTypes, setMissingDataTypes] = useState([]);
    const lastLinkedCaseRef = useRef(null);

    useEffect(() => {
        if (!caseNumber) {
            lastLinkedCaseRef.current = null;
            setMissingDataTypes([]);
            return;
        }

        if (lastLinkedCaseRef.current === caseNumber) {
            return;
        }

        if (selectedCase?.id === caseNumber) {
            lastLinkedCaseRef.current = caseNumber;
            setWorkflowStage((prev) => (prev === "caseSelection" ? "analysis" : prev));
            return;
        }

        let isMounted = true;
        setLinkError("");
        setMissingDataTypes([]);

        fetchCaseByNumber(caseNumber)
            .then((data) => {
                if (!isMounted) {
                    return;
                }

                const evaluation = evaluateModuleReadiness(data, "fdr");
                if (!evaluation.ready) {
                    setLinkError(evaluation.message);
                    setMissingDataTypes(evaluation.missingTypes || []);
                    setSelectedCase(null);
                    setWorkflowStage("analysis");
                    return;
                }

                const preview = buildCasePreview(data);
                setSelectedCase(preview);
                setWorkflowStage("analysis");
                lastLinkedCaseRef.current = caseNumber;
                setLinkError("");
                setMissingDataTypes([]);
            })
            .catch((err) => {
                if (!isMounted) {
                    return;
                }

                setLinkError(err?.message || "Unable to open the selected case");
                setMissingDataTypes([]);
                setSelectedCase(null);
                setWorkflowStage(isLinkedRoute ? "analysis" : "caseSelection");
            });

        return () => {
            isMounted = false;
        };
    }, [caseNumber, navigate, selectedCase, isLinkedRoute]);

    useEffect(() => {
        if (!selectedCase?.source) {
            setAnalysisTimestamp(null);
            setAnalysisRunMeta(null);
            return;
        }

        const savedAnalysis = selectedCase?.source?.fdrAnalysis;
        const latestRun = selectedCase?.source?.fdrAnalysisLatestRun || null;
        const hasResults = Boolean(
            selectedCase?.source?.fdrHasResults || savedAnalysis
        );
        const savedTimestamp =
            latestRun?.createdAt || selectedCase?.source?.fdrAnalysisUpdatedAt || null;

        setAnalysisTimestamp(savedTimestamp);
        setAnalysisRunMeta(latestRun);

        if (!savedAnalysis) {
            setAnomalyResult(null);
        } else {
            setAnomalyResult(savedAnalysis);
        }

        if (hasResults && analysisEntryChoice === null) {
            setWorkflowStage((prev) =>
                prev === "analysis" || prev === "caseSelection" ? "analysisChoice" : prev
            );
            return;
        }

        if (
            pendingRunRef.current &&
            pendingRunRef.current.caseNumber === caseNumber &&
            isNewerTimestamp(savedTimestamp, pendingRunRef.current.previousAnalysisAt)
        ) {
            clearPendingFdrRun();
            pendingRunRef.current = null;
            setIsRunningDetection(false);
        }

        if (analysisEntryChoice === "new") {
            return;
        }

        if (savedAnalysis) {
            setWorkflowStage((prev) =>
                prev === "analysis" ||
                prev === "caseSelection" ||
                prev === "detectionRunning" ||
                prev === "detectionError"
                    ? "results"
                    : prev
            );
        }
    }, [selectedCase, caseNumber, analysisEntryChoice]);

    useEffect(() => {
        if (workflowStage !== "detectionRunning" || !caseNumber) {
            return;
        }

        const pending = pendingRunRef.current || readPendingFdrRun();
        if (!pending || pending.caseNumber !== caseNumber) {
            return;
        }

        let isMounted = true;
        const pollForResults = async () => {
            try {
                const data = await fetchCaseByNumber(caseNumber);
                if (!isMounted) {
                    return false;
                }

                const preview = buildCasePreview(data);
                const latestRun = data?.fdrAnalysisLatestRun || null;
                const latestTimestamp =
                    latestRun?.createdAt || data?.fdrAnalysisUpdatedAt || null;

                if (
                    latestTimestamp &&
                    isNewerTimestamp(
                        latestTimestamp,
                        pending.previousAnalysisAt || pending.startedAt
                    )
                ) {
                    clearPendingFdrRun();
                    pendingRunRef.current = null;
                    setSelectedCase(preview);
                    setIsRunningDetection(false);
                    setWorkflowStage("results");
                    return true;
                }

                return false;
            } catch (_error) {
                return false;
            }
        };

        const intervalId = window.setInterval(async () => {
            const completed = await pollForResults();
            if (completed) {
                window.clearInterval(intervalId);
            }
        }, 5000);

        pollForResults();

        return () => {
            isMounted = false;
            window.clearInterval(intervalId);
        };
    }, [workflowStage, caseNumber]);

    useEffect(() => {
        const caseData = selectedCase?.source;

        if (!caseData) {
            setDetectionTrendData(defaultDetectionTrendSamples);
            setParameterTableRows(defaultParameterTableRows);
            setAvailableParameters(defaultAvailableParameters);
            setFdrDataError("");
            setIsLoadingFdrData(false);
            return;
        }

        const attachments = Array.isArray(caseData.attachments)
            ? caseData.attachments
            : [];

        const fdrAttachment = attachments.find((item) => {
            const type = (item?.type || "").toUpperCase();
            const status = (item?.status || "").toLowerCase();
            const name = (item?.name || "").toLowerCase();
            const storageKey = item?.storage?.objectKey || item?.storage?.key;

            return (
                Boolean(storageKey) &&
                status !== "pending" &&
                !name.includes("pending upload") &&
                (type === "FDR" || name.endsWith(".csv") || name.includes("fdr"))
            );
        });

        if (!fdrAttachment) {
            setDetectionTrendData(defaultDetectionTrendSamples);
            setParameterTableRows(defaultParameterTableRows);
            setAvailableParameters([]);
            setNormalizedRows(sampleNormalizedRows);
            setFdrDataError("The selected case does not include an uploaded FDR file.");
            setIsLoadingFdrData(false);
            return;
        }

        const controller = new AbortController();
        setIsLoadingFdrData(true);
        setFdrDataError("");

        fetchAttachmentFromObjectStore({
            bucket: fdrAttachment.storage?.bucket,
            objectKey: fdrAttachment.storage?.objectKey || fdrAttachment.storage?.key,
            fileName: fdrAttachment.name,
            contentType: fdrAttachment.contentType,
            signal: controller.signal,
        })
            .then((text) => {
                if (controller.signal.aborted) {
                    return;
                }

                const { rows, numericHeaders } = normalizeFdrRows(text);
                if (rows.length === 0) {
                    throw new Error(
                        "The FDR file was downloaded but contained no readable rows."
                    );
                }

                const availability = deriveAvailableParameters(rows, numericHeaders);
                const parameterTable = buildParameterTable(rows, availability);
                const trends = buildDetectionTrendSeries(rows);
                setNormalizedRows(rows);

                setDetectionTrendData(
                    trends.length > 0 ? trends : defaultDetectionTrendSamples
                );

                setParameterTableRows(
                    parameterTable.length > 0
                        ? parameterTable
                        : defaultParameterTableRows
                );

                setAvailableParameters(
                    availability.length > 0
                        ? availability
                        : defaultAvailableParameters
                );
                setFdrDataError("");
            })
            .catch((error) => {
                if (controller.signal.aborted) {
                    return;
                }

                if (error?.isExcelFormat) {
                    // Excel file — analysis still runs server-side, just no client preview
                    setFdrDataError(error.message);
                    return;
                }

                setDetectionTrendData(defaultDetectionTrendSamples);
                setParameterTableRows(defaultParameterTableRows);
                setAvailableParameters([]);
                setNormalizedRows(sampleNormalizedRows);
                const status = error?.status ? ` (status ${error.status})` : "";
                setFdrDataError(
                    error?.message
                        ? `${error.message}${status}`
                        : "Unable to load the FDR attachment."
                );
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    setIsLoadingFdrData(false);
                }
            });

        return () => controller.abort();
    }, [selectedCase]);

    const handleNavigateToCases = () => {
        navigate("/cases");
    };

    const handleUploadMissingData = () => {
        if (!caseNumber) {
            return;
        }

        const normalizedMissing = missingDataTypes.map((type) => String(type || "").toLowerCase());
        const hasFdr = normalizedMissing.includes("fdr");
        const hasCvr = normalizedMissing.includes("cvr");

        let focusUpload = "";
        if (hasFdr && hasCvr) {
            focusUpload = "both";
        } else if (hasFdr) {
            focusUpload = "fdr";
        } else if (hasCvr) {
            focusUpload = "cvr";
        }

        navigate("/cases", {
            state: {
                editCaseNumber: caseNumber,
                focusUpload,
                attemptedCase: caseNumber,
            },
        });
    };

    const handleChangeCase = () => {
        if (isLinkedRoute) {
            navigate("/cases");
            return;
        }
        setWorkflowStage("caseSelection");
        setLinkError("");
        setMissingDataTypes([]);
    };

    const handleViewLatestResults = () => {
        const runId =
            selectedCaseRef.current?.source?.fdrLatestRunId ||
            selectedCaseRef.current?.source?.fdrAnalysisLatestRun?.runId ||
            null;
        if (caseNumber && runId) {
            navigate(`/cases/${caseNumber}/fdr?runId=${runId}`);
        }
        setAnalysisEntryChoice("view");
        setWorkflowStage("results");
    };

    const handleStartNewAnalysis = () => {
        setAnalysisEntryChoice("new");
        setWorkflowStage("analysis");
    };

    const handleToggleGroup = (groupKey) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupKey)) {
                next.delete(groupKey);
            } else {
                next.add(groupKey);
            }
            return next;
        });
    };

    const handleToggleSegment = (segmentKey) => {
        setExpandedSegments((prev) => {
            const next = new Set(prev);
            if (next.has(segmentKey)) {
                next.delete(segmentKey);
            } else {
                next.add(segmentKey);
            }
            return next;
        });
    };

    const handleRunDetection = async () => {
        if (availableParameters.length === 0 || !caseNumber || isRunningDetection) {
            return;
        }

        setIsRunningDetection(true);
        setAnomalyError("");
        setAnomalyResult(null);
        setRulesResult(null);
        setRulesWasAttempted(true);
        setDetectionMethodFilter("all");
        setWorkflowStage("detectionRunning");
        const detectionStartedAt = new Date().toISOString();
        detectionStartRef.current = detectionStartedAt;
        const previousAnalysisAt = analysisRunMeta?.createdAt || analysisTimestamp || null;
        const runLabel = previousAnalysisAt
            ? "New run (previous results preserved)"
            : "Initial run";
        const pendingPayload = {
            caseNumber,
            startedAt: detectionStartedAt,
            previousAnalysisAt,
        };
        pendingRunRef.current = pendingPayload;
        writePendingFdrRun(pendingPayload);

        await appendTimelineEntry({
            entry: createTimelineEntry({
                kind: "fdr_detection_started",
                action: "Behavioral anomaly detection started",
                actor: resolveTimelineActor(),
                timestamp: detectionStartedAt,
                metadata: [
                    {
                        label: "Run",
                        value: runLabel,
                    },
                    {
                        label: "Parameters evaluated",
                        value:
                            availableParameters.length > 0
                                ? `${availableParameters.length} parameters`
                                : "No parameters",
                    },
                ],
            }),
        });

        try {
            // Rules run in parallel with AI detection — fast (no ML training).
            // Failure is caught here so it never blocks the AI result.
            console.log('[FDR:rules:DEBUG] firing fetchFdrRules for case:', caseNumber);
            const rulesPromise = fetchFdrRules(caseNumber).catch((err) => {
                console.warn('[FDR:rules:DEBUG] fetchFdrRules FAILED:', err?.message, '| status:', err?.status);
                return null;
            });

            const result = await runFdrAnomalyDetection(caseNumber, {
                rows: normalizedRows,
            });
            const runMeta = result?.run_metadata || null;
            const updatedAt = runMeta?.createdAt || new Date().toISOString();
            const normalizedResult = {
                ...result,
                analysis_version: result?.analysis_version || "1.0",
            };
            setAnomalyResult(normalizedResult);

            // Auto-derive occurrence window from the highest-severity anomaly segment
            const autoSegments = normalizedResult?.segments;
            if (Array.isArray(autoSegments) && autoSegments.length > 0) {
                const SEVERITY_RANK = { high: 3, med: 2, low: 1 };
                const best = autoSegments.reduce((prev, cur) => {
                    if (cur.score_peak !== prev.score_peak)
                        return cur.score_peak > prev.score_peak ? cur : prev;
                    const curRank = SEVERITY_RANK[cur.severity?.toLowerCase()] ?? 0;
                    const prevRank = SEVERITY_RANK[prev.severity?.toLowerCase()] ?? 0;
                    return curRank > prevRank ? cur : prev;
                });
                if (best.end_time - best.start_time >= 1) {
                    const winStart = best.start_time;
                    const winEnd = best.end_time;
                    setFlightPhases((phases) => {
                        const mid = (winStart + winEnd) / 2;
                        const matched = Array.isArray(phases)
                            ? phases.find((p) => mid >= p.start_time && mid <= p.end_time)
                            : null;
                        const label = matched?.phase ?? "";
                        const newWindow = { start: winStart, end: winEnd, label };
                        setOccurrenceWindow(newWindow);
                        saveFdrOccurrence(caseNumber, newWindow).catch(() => {});
                        return phases;
                    });
                    setTimeout(() => {
                        chartsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }, 300);
                }
            }

            setAnalysisTimestamp(updatedAt);
            setAnalysisRunMeta(runMeta);
            setSelectedCase((prev) =>
                prev
                    ? {
                          ...prev,
                          source: {
                              ...prev.source,
                              fdrAnalysis: normalizedResult,
                              fdrAnalysisUpdatedAt: updatedAt,
                              fdrAnalysisLatestRun: runMeta,
                          },
                      }
                    : prev
            );
            const detectionFinishedAt = new Date().toISOString();
            const startTime = detectionStartRef.current;
            const durationMs = startTime
                ? new Date(detectionFinishedAt).getTime() -
                  new Date(startTime).getTime()
                : null;

            await appendTimelineEntry({
                entry: createTimelineEntry({
                    kind: "fdr_detection_completed",
                    action: "Behavioral anomaly detection completed",
                    actor: resolveTimelineActor(),
                    timestamp: detectionFinishedAt,
                    metadata: [
                        { label: "Status", value: "Success" },
                        {
                            label: "Duration",
                            value:
                                durationMs !== null ? formatDuration(durationMs) : "—",
                        },
                    ],
                    links: {
                        resultsUrl: `/cases/${caseNumber}/fdr`,
                        runId: runMeta?.runId || null,
                    },
                }),
                extraUpdates: {
                    fdrAnalysis: normalizedResult,
                    fdrAnalysisUpdatedAt: updatedAt,
                },
            });
            // Rules should already be resolved since they're faster than AI.
            const rulesData = await rulesPromise;
            console.log('[FDR:rules:DEBUG] rulesData received:', rulesData);
            console.log('[FDR:rules:DEBUG] findings count:', rulesData?.findings?.length ?? 'null/undefined');
            console.log('[FDR:rules:DEBUG] rules_checked count:', rulesData?.rules_checked?.length ?? 'null/undefined');
            setRulesResult(rulesData);

            clearPendingFdrRun();
            pendingRunRef.current = null;
            setWorkflowStage("results");
        } catch (error) {
            setAnomalyResult(null);
            setAnomalyError(
                error?.message || "Unable to run anomaly detection for this case."
            );
            clearPendingFdrRun();
            pendingRunRef.current = null;
            const detectionFinishedAt = new Date().toISOString();
            const startTime = detectionStartRef.current;
            const durationMs = startTime
                ? new Date(detectionFinishedAt).getTime() -
                  new Date(startTime).getTime()
                : null;

            await appendTimelineEntry({
                entry: createTimelineEntry({
                    kind: "fdr_detection_completed",
                    action: "Behavioral anomaly detection completed",
                    actor: resolveTimelineActor(),
                    timestamp: detectionFinishedAt,
                    metadata: [
                        { label: "Status", value: "Failure" },
                        {
                            label: "Duration",
                            value:
                                durationMs !== null ? formatDuration(durationMs) : "—",
                        },
                    ],
                    links: {
                        resultsUrl: `/cases/${caseNumber}/fdr`,
                    },
                }),
            });
            setWorkflowStage("detectionError");
        } finally {
            setIsRunningDetection(false);
        }
    };

    const totalRows =
        anomalyResult?.summary?.n_rows ??
        anomalyResult?.totalRows ??
        anomalyResult?.evaluatedRows ??
        anomalyResult?.total_rows ??
        anomalyResult?.total ??
        (Array.isArray(normalizedRows) ? normalizedRows.length : null);
    const anomalyCount =
        anomalyResult?.summary?.segments_found ??
        anomalyResult?.segments?.length ??
        anomalyResult?.anomalyCount ??
        anomalyResult?.detectedCount ??
        anomalyResult?.anomalies?.length ??
        anomalyResult?.count ??
        segments.length ??
        null;
    const flaggedRowCount =
        anomalyResult?.summary?.flaggedRowCount ??
        anomalyResult?.summary?.flagged_row_count ??
        anomalyResult?.flaggedRowCount ??
        anomalyResult?.flagged_row_count ??
        null;
    const flaggedPercent =
        anomalyResult?.summary?.flaggedPercent ??
        anomalyResult?.summary?.flagged_percent ??
        anomalyResult?.flaggedPercent ??
        anomalyResult?.flagged_percent ??
        null;
    const noAnomaliesDetected = Boolean(anomalyResult) && anomalyCount === 0;
    const notesRunId =
        analysisRunMeta?.runId ||
        selectedCase?.source?.fdrAnalysisLatestRun?.runId ||
        selectedCase?.source?.fdrLatestRunId ||
        null;
    const topAnomalyParameters = useMemo(() => {
        if (!anomalyResult) {
            return [];
        }

        const counts = new Map();
        const addCount = (name, value = 1) => {
            if (!name) {
                return;
            }

            const displayName = getParameterLabel(name) || name;
            const increment = Number.isFinite(value) ? value : 1;
            counts.set(displayName, (counts.get(displayName) || 0) + increment);
        };

        const parameterBreakdown =
            anomalyResult.summary?.top_parameters ||
            anomalyResult.topParameters ||
            anomalyResult.top_parameters ||
            anomalyResult.parameterCounts ||
            anomalyResult.parameter_counts ||
            anomalyResult.parameterBreakdown ||
            anomalyResult.parameter_breakdown;

        if (parameterBreakdown) {
            if (Array.isArray(parameterBreakdown)) {
                parameterBreakdown.forEach((item) =>
                    addCount(
                        item?.parameter || item?.name || item?.field,
                        item?.count || item?.anomalies || item?.total
                    )
                );
            } else if (typeof parameterBreakdown === "object") {
                Object.entries(parameterBreakdown).forEach(([key, value]) => {
                    addCount(key, Number(value));
                });
            }
        }

        if (Array.isArray(segments)) {
            segments.forEach((segment) => {
                const drivers = Array.isArray(segment?.top_drivers)
                    ? segment.top_drivers
                    : segment?.drivers;
                if (Array.isArray(drivers)) {
                    drivers.forEach((driver) =>
                        addCount(driver?.parameter || driver?.name || driver?.field)
                    );
                }
            });
        }

        return Array.from(counts.entries())
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count }));
    }, [anomalyResult, segments]);
    const allTopParameters = useMemo(() => {
        const providedTopParameters =
            anomalyResult?.summary?.top_parameters ||
            anomalyResult?.topParameters ||
            anomalyResult?.top_parameters;

        if (Array.isArray(providedTopParameters) && providedTopParameters.length > 0) {
            const normalizedTopParameters = providedTopParameters
                .map((item) => {
                    const name =
                        item?.parameter || item?.name || item?.field || item?.label;
                    const count = item?.count ?? item?.anomalies ?? item?.total;

                    if (!name) {
                        return null;
                    }

                    return {
                        name: getParameterLabel(name) || name,
                        count: Number.isFinite(Number(count)) ? Number(count) : 0,
                    };
                })
                .filter(Boolean);

            if (normalizedTopParameters.length > 0) {
                return normalizedTopParameters.sort((a, b) => b.count - a.count);
            }
        }

        return topAnomalyParameters;
    }, [anomalyResult, topAnomalyParameters]);
    const topParameterPreview = useMemo(
        () => allTopParameters.slice(0, 5),
        [allTopParameters]
    );
    const scoreTimelineData = useMemo(
        () => buildScoreTimelineSeries(anomalyResult?.timeline, mapTimeValue),
        [anomalyResult, mapTimeValue]
    );
    const [showAllParameters, setShowAllParameters] = useState(false);
    const [severityFilter, setSeverityFilter] = useState("all");
    const pendingScrollToChartsRef = useRef(false);

    const formatSegmentTimeRange = (segment, index) => {
        const startTime = segment?.start_time ?? segment?.startTime ?? segment?.time;
        const endTime = segment?.end_time ?? segment?.endTime ?? segment?.time;
        const formatValue = (value) => {
            if (!Number.isFinite(Number(value))) {
                return value;
            }
            const formatted = formatFlightTime(mapTimeValue(Number(value)));
            return formatted || value;
        };
        if (startTime !== undefined && endTime !== undefined && startTime !== endTime) {
            return `${formatValue(startTime)} - ${formatValue(endTime)}`;
        }
        return formatValue(startTime ?? endTime) ?? `Segment ${index + 1}`;
    };
    const formatSeverityLabel = (value) => {
        if (!value) {
            return "—";
        }
        const text = String(value);
        return text.charAt(0).toUpperCase() + text.slice(1);
    };
    const getSeverityTone = useCallback((value) => {
        const normalized = String(value || "low").trim().toLowerCase();

        if (normalized === "high") {
            return {
                badge: "bg-red-100 text-red-800 border border-red-200",
                actionText: "text-red-700",
                interpretationBox: "border-red-200 bg-red-50 text-red-900",
                interpretationLabel: "text-red-800",
                interpretationTag: "bg-white text-red-800 border border-red-200",
                evidencePanel: "border-red-100 bg-red-50/40",
            };
        }

        if (normalized === "medium") {
            return {
                badge: "bg-amber-100 text-amber-900 border border-amber-200",
                actionText: "text-amber-700",
                interpretationBox: "border-amber-200 bg-amber-50 text-amber-900",
                interpretationLabel: "text-amber-800",
                interpretationTag: "bg-white text-amber-800 border border-amber-200",
                evidencePanel: "border-amber-100 bg-amber-50/40",
            };
        }

        return {
            badge: "bg-orange-100 text-orange-900 border border-orange-200",
            actionText: "text-orange-700",
            interpretationBox: "border-orange-200 bg-orange-50 text-orange-900",
            interpretationLabel: "text-orange-800",
            interpretationTag: "bg-white text-orange-800 border border-orange-200",
            evidencePanel: "border-orange-100 bg-orange-50/40",
        };
    }, []);
    const spikeThreshold = useMemo(() => {
        if (!scoreTimelineData.length) {
            return null;
        }
        const values = scoreTimelineData
            .map((entry) => entry?.score)
            .filter((value) => typeof value === "number" && !Number.isNaN(value))
            .sort((a, b) => a - b);
        if (values.length < 3) {
            return null;
        }
        const index = Math.max(0, Math.floor((values.length - 1) * 0.98));
        return values[index];
    }, [scoreTimelineData]);

    const renderScoreTooltip = ({ active, payload, label }) => {
        if (!active || !payload || payload.length === 0) {
            return null;
        }
        const value = payload[0]?.value;
        const formattedLabel = Number.isFinite(label)
            ? formatFlightTime(label)
            : label;
        const showSpikeCallout =
            Number.isFinite(spikeThreshold) &&
            Number.isFinite(value) &&
            scoreTimelineData.length > 0 &&
            value >= spikeThreshold;
        return (
            <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 shadow-sm">
                <p className="font-semibold text-gray-800">
                    Behavioral Deviation Score (autoencoder reconstruction error)
                </p>
                <p className="mt-1">
                    Higher values indicate stronger deviation from learned normal behavior (not probability).{" "}
                    <span className="font-semibold text-gray-900">
                        {formatNumericValue(value)}
                    </span>
                </p>
                {showSpikeCallout && (
                    <p className="mt-1 text-[11px] text-amber-600">
                        Large spikes indicate behavior far outside learned normal patterns (e.g., operational mode change,
                        sensor discontinuity, or abnormal event).
                    </p>
                )}
                {formattedLabel && (
                    <p className="mt-1 text-[11px] text-gray-500">
                        {timeAxisLabel}: {formattedLabel}
                    </p>
                )}
            </div>
        );
    };

    const mostSevereSegment = useMemo(() => {
        if (!segments.length) {
            return null;
        }

        return segments.reduce((current, segment, index) => {
            const score = Number(
                segment?.score_peak ?? segment?.scorePeak ?? segment?.score ?? segment?.max_score
            );
            if (!Number.isFinite(score)) {
                return current;
            }
            if (!current || score > current.score) {
                return { segment, score, index };
            }
            return current;
        }, null);
    }, [segments]);
    const detectionSummary = anomalyResult?.summary ?? {};
    const detectionWindowSize =
        detectionSummary.window_size ?? detectionSummary.windowSize ?? null;
    const detectionStride =
        detectionSummary.stride ?? detectionSummary.window_stride ?? detectionSummary.windowStride ?? null;
    const detectionThresholdPercentile =
        detectionSummary.threshold_percentile ?? detectionSummary.thresholdPercentile ?? null;
    const detectionThresholdValue =
        detectionSummary.threshold_value ?? detectionSummary.thresholdValue ?? null;
    const detectionParamsUsed =
        detectionSummary.n_params_used ?? detectionSummary.nParamsUsed ?? null;
    const visibleTopParameters = showAllParameters ? allTopParameters : topParameterPreview;

    const resolveSegmentTimeBounds = (segment) => {
        const startTime = mapTimeValue(
            Number(segment?.start_time ?? segment?.startTime ?? segment?.time)
        );
        const endTime = mapTimeValue(
            Number(segment?.end_time ?? segment?.endTime ?? segment?.time)
        );
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
            return null;
        }
        return {
            startTime: Math.min(startTime, endTime),
            endTime: Math.max(startTime, endTime),
        };
    };
    const resolveSegmentDrivers = useCallback(
        (segment, limit = 3) => {
            const drivers = Array.isArray(segment?.top_drivers)
                ? segment.top_drivers
                : segment?.drivers;
            if (!Array.isArray(drivers) || drivers.length === 0) {
                return [];
            }
            return drivers.slice(0, limit).map((driver) => {
                const param = driver?.parameter || driver?.name || driver?.field || "";
                const meta = parameterDisplayMap[param] || getParameterDisplayMeta(param);
                const stats =
                    segment?.driver_stats?.find((item) => item?.param === param) ||
                    segment?.driverStats?.find((item) => item?.param === param);
                return {
                    param,
                    label: meta?.label || param,
                    unit: stats?.unit || meta?.unit || "",
                    stats,
                };
            });
        },
        [parameterDisplayMap]
    );

    const resolveSegmentInterpretation = useCallback(
        (segment) => {
            const drivers = Array.isArray(segment?.top_drivers)
                ? segment.top_drivers
                : segment?.drivers;
            if (!Array.isArray(drivers) || drivers.length === 0) {
                return { tags: [], note: INTERPRETATION_NOTE };
            }

            const labels = drivers
                .map((driver) => driver?.parameter || driver?.name || driver?.field || driver)
                .filter(Boolean)
                .map((param) => {
                    const meta = parameterDisplayMap[param] || getParameterDisplayMeta(param);
                    return meta?.label || param;
                });

            return { tags: deriveInterpretationTags(labels), note: INTERPRETATION_NOTE };
        },
        [parameterDisplayMap]
    );

    const getSegmentPhaseLabel = useCallback(
        (segment) => {
            if (!Array.isArray(flightPhases) || flightPhases.length === 0) return null;
            const mid =
                ((segment?.start_time ?? 0) + (segment?.end_time ?? segment?.start_time ?? 0)) / 2;
            const match = flightPhases.find((p) => mid >= p.start_time && mid <= p.end_time);
            return match?.phase ?? null;
        },
        [flightPhases]
    );

    const getDriverDeviationLabel = useCallback((driver) => {
        const stats = driver?.stats;
        if (!stats) return null;
        // Prefer sigma-based label when available (Task 11)
        const { deviation_sigma } = stats;
        if (Number.isFinite(deviation_sigma) && Math.abs(deviation_sigma) >= 0.3) {
            return `${deviation_sigma >= 0 ? "↑" : "↓"}${Math.abs(deviation_sigma).toFixed(1)}σ`;
        }
        // Fallback: percentage label for saved results without sigma data
        const { segment_max, segment_min, baseline_median } = stats;
        if (!Number.isFinite(baseline_median) || baseline_median === 0) return null;
        const extreme =
            Math.abs(segment_max - baseline_median) >= Math.abs(segment_min - baseline_median)
                ? segment_max
                : segment_min;
        const pct = ((extreme - baseline_median) / Math.abs(baseline_median)) * 100;
        if (!Number.isFinite(pct) || Math.abs(pct) < 1) return null;
        return `${pct >= 0 ? "↑" : "↓"}${Math.round(Math.abs(pct))}%`;
    }, []);

    const handleJumpToSegment = useCallback(
        (segment) => {
            const start = segment?.start_time;
            const end = segment?.end_time ?? start;
            if (!Number.isFinite(start)) return;
            const label = getSegmentPhaseLabel(segment) ?? "";
            const newWindow = { start, end, label };
            setOccurrenceWindow(newWindow);
            saveFdrOccurrence(caseNumber, newWindow).catch(() => {});
            setWorkflowStage("analysis");
            // Scroll directly — don't rely on useEffect since we may already be
            // on the analysis stage (stage doesn't change → effect never fires)
            setTimeout(() => {
                chartsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 400);
        },
        [caseNumber, getSegmentPhaseLabel]
    );

    const investigatorName = useMemo(
        () => user?.email ?? user?.name ?? selectedCase?.source?.examiner ?? selectedCase?.source?.owner ?? "investigator",
        [user, selectedCase]
    );

    const handleSaveCorrection = useCallback(
        async (segmentKey, segment, type, values) => {
            const correction = {
                id: crypto.randomUUID(),
                type,
                target_id: String(segment?.start_time ?? ''),
                original_value: { severity: segment?.severity },
                corrected_value: type === 'false_positive' ? { dismissed: true } : { severity: values.severity },
                investigator: investigatorName,
                timestamp: new Date().toISOString(),
                note: values.note,
            };
            try {
                const updated = await addFdrCorrection(caseNumber, correction);
                setCorrections(Array.isArray(updated) ? updated : []);
                setCorrectionForms((prev) => {
                    const next = { ...prev };
                    delete next[segmentKey];
                    return next;
                });
            } catch (err) {
                console.error('Failed to save correction:', err);
            }
        },
        [caseNumber, investigatorName]
    );

    const handleSavePhaseCorrections = useCallback(async () => {
        const changed = Object.entries(phaseCorrectionForm).filter(([phase, newLabel]) => newLabel && newLabel !== phase);
        if (changed.length === 0 || phaseEditNote.trim().length < 10) return;
        try {
            let lastUpdated = corrections;
            for (const [phase, newLabel] of changed) {
                const correction = {
                    id: crypto.randomUUID(),
                    type: 'phase_correction',
                    target_id: phase,
                    original_value: { phase },
                    corrected_value: { phase: newLabel },
                    investigator: investigatorName,
                    timestamp: new Date().toISOString(),
                    note: phaseEditNote.trim(),
                };
                const updated = await addFdrCorrection(caseNumber, correction);
                if (Array.isArray(updated)) lastUpdated = updated;
            }
            setCorrections(lastUpdated);
            setPhaseEditMode(false);
            setPhaseCorrectionForm({});
            setPhaseEditNote('');
        } catch (err) {
            console.error('Failed to save phase corrections:', err);
        }
    }, [phaseCorrectionForm, phaseEditNote, caseNumber, investigatorName, corrections]);

    const handleDeleteCorrection = useCallback(async (correctionId) => {
        try {
            const updated = await deleteFdrCorrection(caseNumber, correctionId);
            setCorrections(Array.isArray(updated) ? updated : []);
            setDeleteConfirmId(null);
        } catch (err) {
            console.error('Failed to delete correction:', err);
        }
    }, [caseNumber]);

    const extraSegmentsOmitted = anomalyResult?.summary?.extra_segments_omitted ?? 0;

    // Task 10 — merge AI segments with rule-based findings.
    const mergedSegments = useMemo(() => {
        const OVERLAP_GAP = 30; // seconds — same as SEGMENT_GAP_SECONDS in Python
        const aiSegs = segments.map((s) => ({ ...s, detection_source: "ai" }));
        const ruleFindings = rulesResult?.findings || [];

        if (!ruleFindings.length) return aiSegs;

        // Work on a mutable copy so we can annotate matched AI segments.
        const merged = aiSegs.map((s) => ({ ...s }));
        const unmatchedRules = [];

        ruleFindings.forEach((rf) => {
            const matchIdx = merged.findIndex(
                (ai) =>
                    ai.detection_source !== "rules" &&
                    ai.start_time <= (rf.end_time ?? rf.start_time) + OVERLAP_GAP &&
                    (ai.end_time ?? ai.start_time) >= (rf.start_time ?? 0) - OVERLAP_GAP
            );
            if (matchIdx >= 0) {
                merged[matchIdx] = {
                    ...merged[matchIdx],
                    detection_source: "both",
                    rule_findings: [
                        ...(merged[matchIdx].rule_findings || []),
                        rf,
                    ],
                };
            } else {
                unmatchedRules.push({
                    ...rf,
                    detection_source: "rules",
                    score_peak: null,
                    top_drivers: [{ parameter: rf.parameter, error: 0 }],
                    explanation: `${rf.rule_name}: ${rf.parameter} reached ${rf.peak_value} (limit: ${rf.threshold})`,
                });
            }
        });

        const _SEV = { high: 3, med: 2, low: 1 };
        return [...merged, ...unmatchedRules].sort(
            (a, b) =>
                (_SEV[b.severity] || 0) - (_SEV[a.severity] || 0) ||
                (b.score_peak || 0) - (a.score_peak || 0)
        );
    }, [segments, rulesResult]);

    const filteredSegments = useMemo(() => {
        let result = mergedSegments;
        if (severityFilter !== "all") {
            result = result.filter(
                (s) => (s?.severity ?? "low").toLowerCase() === severityFilter
            );
        }
        if (detectionMethodFilter !== "all") {
            result = result.filter((s) => {
                const src = s.detection_source || "ai";
                if (detectionMethodFilter === "ai") return src === "ai";
                if (detectionMethodFilter === "rules") return src === "rules";
                if (detectionMethodFilter === "both") return src === "both";
                return true;
            });
        }
        return result;
    }, [mergedSegments, severityFilter, detectionMethodFilter]);

    // Task 15 — split filteredSegments into active (not dismissed) and dismissed.
    const activeSegments = useMemo(
        () => filteredSegments.filter(
            (seg) => !corrections.some((c) => c.type === 'false_positive' && c.target_id === String(seg?.start_time ?? ''))
        ),
        [filteredSegments, corrections]
    );
    const dismissedSegments = useMemo(
        () => filteredSegments.filter(
            (seg) => corrections.some((c) => c.type === 'false_positive' && c.target_id === String(seg?.start_time ?? ''))
        ),
        [filteredSegments, corrections]
    );

    useEffect(() => {
        if (!pendingScrollToChartsRef.current) return;
        if (workflowStage !== "analysis") return;
        pendingScrollToChartsRef.current = false;
        setTimeout(() => {
            chartsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 300);
    }, [workflowStage]);

    // Task 14 — derive suggested correlation params from the case description/summary.
    // Returns null when no description text is available (no feedback shown).
    // Returns { matched: false } when text is present but no keywords match (gray line shown).
    // Returns { matched: true, params, matchedKeywords } when suggestions are found (blue banner).
    const suggestedCorrelationParams = useMemo(() => {
        // Scan every human-readable text field on the case — the description is often
        // in caseName (the case title), summary, or notes rather than a dedicated field.
        const src = selectedCase?.source || {};
        const rawText = [
            src.caseName,
            src.summary,
            src.description,
            src.notes,
            src.narrative,
            src.location,
        ].filter(Boolean).join(' ').trim();

        console.debug("[FDR Task14] Case source keys:", Object.keys(src));
        console.debug("[FDR Task14] Scanning text:", rawText || "(empty)");

        if (!rawText || !availableParameters?.length) return null;

        const text = rawText.toLowerCase();

        const matchedGroups = DESCRIPTION_KEYWORD_PARAM_MAP.filter((group) =>
            group.keywords.some((kw) => text.includes(kw))
        );
        console.debug("[FDR Task14] Matched groups:", matchedGroups.map((g) => g.label));

        if (matchedGroups.length === 0) {
            return { matched: false, params: [], matchedKeywords: [] };
        }

        const paramSet = new Set();
        matchedGroups.forEach((group) => {
            group.paramKeywords.forEach((pkw) => {
                availableParameters.forEach((param) => {
                    const labelLower = (parameterDisplayMap[param]?.label || param).toLowerCase();
                    if (param.toLowerCase().includes(pkw) || labelLower.includes(pkw)) {
                        paramSet.add(param);
                    }
                });
            });
        });

        const params = Array.from(paramSet).slice(0, 6);
        console.debug("[FDR Task14] Suggested params:", params);

        if (params.length === 0) {
            return { matched: false, params: [], matchedKeywords: matchedGroups.map((g) => g.label) };
        }

        return { matched: true, params, matchedKeywords: matchedGroups.map((g) => g.label) };
    }, [selectedCase, availableParameters, parameterDisplayMap]);

    // Reset per-case UI state when case changes.
    useEffect(() => {
        setSuggestionDismissed(false);
        setWhyExpanded(false);
        setRulesResult(null);
        setRulesWasAttempted(false);
        setDetectionMethodFilter("all");
        setRulesCheckedOpen(false);
        setCorrections([]);
        setCorrectionForms({});
        setCorrectionsLogOpen(false);
        setDeleteConfirmId(null);
        setDismissedOpen(false);
        setPhaseEditMode(false);
        setPhaseCorrectionForm({});
        setPhaseEditNote('');
    }, [caseNumber]);

    // Default correlation param selection: prefer keyword-derived suggestions, then
    // fall back to the priority 4. Only runs when availableParameters loads; doesn't
    // clobber user changes.
    useEffect(() => {
        if (!availableParameters || availableParameters.length === 0) return;
        if (suggestedCorrelationParams?.matched && suggestedCorrelationParams.params.length > 0) {
            setCorrelationParams((prev) =>
                prev.length === 0 ? suggestedCorrelationParams.params : prev
            );
            return;
        }
        const PRIORITY = [
            "Indicated Airspeed (knots)",
            "Vertical Speed (ft/min)",
            "Pitch (deg)",
            "Roll (deg)",
        ];
        const defaults = PRIORITY.filter((p) => availableParameters.includes(p));
        setCorrelationParams((prev) => (prev.length === 0 ? defaults : prev));
    }, [availableParameters, suggestedCorrelationParams]);

    const caseSummary = useMemo(() => {
        if (!anomalyResult) {
            return null;
        }

        const segmentCount =
            anomalyResult.summary?.segments_found ??
            anomalyResult.segments?.length ??
            anomalyResult.anomalyCount ??
            segments.length ??
            0;
        const percentValue =
            typeof flaggedPercent === "number"
                ? `${flaggedPercent.toFixed(1)}`
                : "—";
        const topParameters = allTopParameters
            .slice(0, 3)
            .map((item) => item.name)
            .filter(Boolean);
        const topParametersText =
            topParameters.length > 0 ? topParameters.join(", ") : "No dominant parameters reported";

        let severeSummary = "No severe segment identified";
        let severeInterpretation = "unclassified behavior shifts";
        let severeDriversText = "no dominant drivers identified";

        if (mostSevereSegment?.segment) {
            const segmentDrivers = resolveSegmentDrivers(
                mostSevereSegment.segment,
                3
            ).map((driver) => driver.label);
            severeDriversText =
                segmentDrivers.length > 0
                    ? segmentDrivers.join(", ")
                    : "no dominant drivers identified";
            severeSummary = formatSegmentTimeRange(
                mostSevereSegment.segment,
                mostSevereSegment.index
            );
            const interpretation = resolveSegmentInterpretation(
                mostSevereSegment.segment
            );
            if (interpretation.tags.length > 0) {
                severeInterpretation = interpretation.tags.join(" / ");
            }
        }

        const paragraph = `The system flagged ${segmentCount} anomalous segments covering ${percentValue}% of the flight timeline using unsupervised behavioral deviation (autoencoder reconstruction error). The most recurrent contributing parameters were ${topParametersText}. The highest-severity interval occurred at ${severeSummary}, driven primarily by ${severeDriversText}. This pattern may indicate ${severeInterpretation}. These findings are intended to support investigation and should be reviewed alongside operational context and CVR.`;

        const bullets = [
            `Top contributing parameters: ${topParametersText}`,
            `Flagged timeline: ${
                typeof flaggedRowCount === "number"
                    ? `${flaggedRowCount.toLocaleString()} rows`
                    : "—"
            }${
                typeof flaggedPercent === "number"
                    ? ` (${flaggedPercent.toFixed(1)}%)`
                    : ""
            }`,
            `Most severe segment: ${severeSummary}`,
        ];

        return {
            paragraph,
            bullets,
            copyText: [paragraph, "", ...bullets.map((line) => `• ${line}`)].join(
                "\n"
            ),
        };
    }, [
        anomalyResult,
        allTopParameters,
        formatSegmentTimeRange,
        flaggedPercent,
        flaggedRowCount,
        mostSevereSegment,
        resolveSegmentDrivers,
        resolveSegmentInterpretation,
        segments.length,
    ]);

    // ── Task 13 — Flight Track Map ───────────────────────────────────────────────
    // Detect which available parameters carry latitude and longitude values.
    const latParam = useMemo(
        () => availableParameters.find((p) => p.toLowerCase().includes("lat")),
        [availableParameters]
    );
    const lonParam = useMemo(
        () => availableParameters.find(
            (p) => p.toLowerCase().includes("lon") || p.toLowerCase().includes("lng")
        ),
        [availableParameters]
    );

    // Build position points from filteredRows — skip zeros/nulls.
    const mapTrackPoints = useMemo(() => {
        if (!latParam || !lonParam) return [];
        return filteredRows
            .filter(
                (r) =>
                    typeof r[latParam] === "number" &&
                    typeof r[lonParam] === "number" &&
                    Math.abs(r[latParam]) > 0.001 &&
                    Math.abs(r[lonParam]) > 0.001
            )
            .map((r) => ({
                lat: r[latParam],
                lon: r[lonParam],
                time: r.time,
                phase:
                    flightPhases?.find(
                        (p) =>
                            typeof r.time === "number" &&
                            r.time >= p.start_time &&
                            r.time <= p.end_time
                    )?.phase ?? "CRUISE",
            }));
    }, [filteredRows, latParam, lonParam, flightPhases]);

    // Split track into runs of consecutive same-phase points (overlapping by 1 for seamless joins).
    const mapPhasePolylines = useMemo(() => {
        if (mapTrackPoints.length === 0) return [];
        const segs = [];
        let cur = { phase: mapTrackPoints[0].phase, points: [[mapTrackPoints[0].lat, mapTrackPoints[0].lon]] };
        for (let i = 1; i < mapTrackPoints.length; i++) {
            const pt = mapTrackPoints[i];
            if (pt.phase === cur.phase) {
                cur.points.push([pt.lat, pt.lon]);
            } else {
                cur.points.push([pt.lat, pt.lon]); // overlap for continuity
                segs.push(cur);
                cur = { phase: pt.phase, points: [[pt.lat, pt.lon]] };
            }
        }
        segs.push(cur);
        return segs;
    }, [mapTrackPoints]);

    // Lat/lon bounding box for initial map fit.
    const mapBounds = useMemo(() => {
        if (mapTrackPoints.length === 0) return null;
        const lats = mapTrackPoints.map((p) => p.lat);
        const lons = mapTrackPoints.map((p) => p.lon);
        return [
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)],
        ];
    }, [mapTrackPoints]);

    // Nearest track point to the scrubber time.
    const mapScrubPosition = useMemo(() => {
        if (mapScrubTime === null || mapTrackPoints.length === 0) return null;
        let best = mapTrackPoints[0];
        let bestDist = Math.abs(mapTrackPoints[0].time - mapScrubTime);
        for (const pt of mapTrackPoints) {
            const d = Math.abs(pt.time - mapScrubTime);
            if (d < bestDist) { bestDist = d; best = pt; }
        }
        return best;
    }, [mapScrubTime, mapTrackPoints]);
    // ── End Task 13 ─────────────────────────────────────────────────────────────

    const handleCopyCaseSummary = async () => {
        if (!caseSummary?.copyText) {
            return;
        }

        try {
            await navigator.clipboard.writeText(caseSummary.copyText);
            setCaseSummaryCopied(true);
            setTimeout(() => setCaseSummaryCopied(false), 2000);
        } catch (_error) {
            setCaseSummaryCopied(false);
        }
    };

    const buildSegmentChartData = (parameter, bounds) => {
        if (!parameter || !bounds) {
            return { rawData: [], chartData: [] };
        }
        const lower = bounds.startTime;
        const upper = bounds.endTime;
        const rawData = filteredRows
            .map((row) => ({
                time: row.time,
                value: row[parameter],
            }))
            .filter(
                (row) =>
                    typeof row.time === "number" &&
                    typeof row.value === "number" &&
                    !Number.isNaN(row.value) &&
                    row.time >= lower &&
                    row.time <= upper
            );
        return {
            rawData,
            chartData: downsampleEvidenceSeries(rawData, 800),
        };
    };

    const renderParameterCard = (parameter) => {
        const meta = parameterDisplayMap[parameter] || {
            label: parameter,
            unit: "",
            color: colorPalette[0],
        };
        const chartData = downsampleSeries(
            chartRows
                .map((row) => ({
                    time: row.time,
                    value: row[parameter],
                }))
                .filter(
                    (row) =>
                        typeof row.time === "number" &&
                        typeof row.value === "number" &&
                        !Number.isNaN(row.value)
                )
        );
        const hasData = chartData.length > 0;
        const renderConfig = getSeriesRenderConfig(chartData, "value");

        return (
            <div
                key={parameter}
                className="flex w-full flex-col gap-3 rounded-2xl border border-gray-200 bg-white/70 p-4 shadow-sm"
            >
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold text-gray-800">
                            {meta.label || parameter}
                        </h3>
                        {meta.unit && (
                            <p className="text-xs text-gray-500">Unit: {meta.unit}</p>
                        )}
                    </div>
                </div>

                {hasData ? (
                    <div className="min-h-[200px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                                data={chartData}
                                margin={{ top: 12, right: 16, left: 0, bottom: 0 }}
                                onMouseDown={handleChartMouseDown}
                                onMouseMove={handleChartMouseMove}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                <XAxis
                                    dataKey="time"
                                    stroke="#94a3b8"
                                    minTickGap={20}
                                    tickFormatter={formatFlightTime}
                                    label={{
                                        value: timeAxisLabel,
                                        position: "insideBottom",
                                        offset: -2,
                                        fill: "#94a3b8",
                                        fontSize: 11,
                                    }}
                                />
                                <YAxis stroke="#94a3b8" domain={["auto", "auto"]} />
                                <Tooltip
                                    cursor={{ stroke: "#cbd5e1" }}
                                    labelFormatter={(value) =>
                                        `${timeAxisLabel}: ${formatFlightTime(value)}`
                                    }
                                />
                                {groupedPhases.map((p) => (
                                    <ReferenceArea
                                        key={p.phase}
                                        x1={p.start_time}
                                        x2={p.end_time}
                                        fill={PHASE_COLORS[p.phase] || "#94a3b8"}
                                        fillOpacity={
                                            p.phase === "TAKEOFF" || p.phase === "LANDING"
                                                ? 0.12
                                                : 0.08
                                        }
                                        ifOverflow="hidden"
                                    />
                                ))}
                                {/* Drag preview band */}
                                {isDragging && dragStartTime !== null && dragCurrentTime !== null && (
                                    <ReferenceArea
                                        x1={Math.min(dragStartTime, dragCurrentTime)}
                                        x2={Math.max(dragStartTime, dragCurrentTime)}
                                        fill="#f59e0b"
                                        fillOpacity={0.10}
                                        stroke="#fbbf24"
                                        strokeDasharray="3 2"
                                        ifOverflow="hidden"
                                    />
                                )}
                                {/* Saved occurrence band — renders on top of phase bands */}
                                {occurrenceWindow?.start != null && occurrenceWindow?.end != null && (
                                    <ReferenceArea
                                        x1={occurrenceWindow.start}
                                        x2={occurrenceWindow.end}
                                        fill="#f59e0b"
                                        fillOpacity={0.22}
                                        stroke="#d97706"
                                        strokeWidth={1}
                                        ifOverflow="hidden"
                                    />
                                )}
                                {/* Center dashed line + label */}
                                {occurrenceWindow?.start != null && occurrenceWindow?.end != null && (
                                    <ReferenceLine
                                        x={(occurrenceWindow.start + occurrenceWindow.end) / 2}
                                        stroke="#92400e"
                                        strokeDasharray="4 3"
                                        strokeWidth={1.5}
                                        label={{
                                            value: occurrenceWindow.label
                                                ? `Occurrence · ${occurrenceWindow.label}`
                                                : "Occurrence",
                                            position: "insideTopRight",
                                            fill: "#92400e",
                                            fontSize: 10,
                                            fontWeight: 600,
                                        }}
                                    />
                                )}
                                <Line
                                    type={renderConfig.lineType || "monotone"}
                                    dataKey="value"
                                    name={meta.label || parameter}
                                    stroke={meta.color}
                                    strokeWidth={1.5}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="flex min-h-[200px] items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
                        No numeric data available for this parameter.
                    </div>
                )}
            </div>
        );
    };

    if (!isLinkedRoute && workflowStage === "caseSelection") {
        return (
            <div className="max-w-6xl mx-auto space-y-8">
                <header className="space-y-2">
                    <p className="text-sm font-semibold text-emerald-600">FDR Module</p>
                    <h1 className="text-3xl font-bold text-gray-900">
                        Select a Case to Analyze Flight Data
                    </h1>
                    <p className="text-gray-600 max-w-3xl">
                        Choose the investigation file whose flight data recorder stream you want to explore. Once selected, the
                        system will load available parameters, trend charts, and anomaly detection workflows.
                    </p>
                </header>

                {(recentCasesError || linkError) && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        {linkError || recentCasesError}
                    </div>
                )}

                {isRecentLoading && recentCases.length === 0 && (
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
                        Loading recent cases...
                    </div>
                )}

                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    {caseSelectionOptions.map((flightCase) => {
                        const isActive = selectedCase?.id === flightCase.id;
                        return (
                            <button
                                key={flightCase.id}
                                type="button"
                                onClick={() => {
                                    setSelectedCase(flightCase);
                                    setLinkError("");
                                    setMissingDataTypes([]);
                                }}
                                className={`text-left rounded-2xl border transition shadow-sm hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-emerald-100 ${
                                    isActive ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-white"
                                }`}
                            >
                                <div className="p-6 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs uppercase tracking-wide text-gray-400">Case ID</span>
                                        <span className="text-sm font-semibold text-emerald-600">{flightCase.date}</span>
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-gray-800">{flightCase.id}</p>
                                        <h2 className="mt-1 text-xl font-bold text-gray-900">{flightCase.title}</h2>
                                    </div>
                                    <p className="text-sm text-gray-600">{flightCase.summary}</p>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-gray-500">Aircraft</span>
                                        <span className="font-medium text-gray-800">{flightCase.aircraft}</span>
                                    </div>
                                    {isActive && (
                                        <div className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
                                            <span className="w-2 h-2 rounded-full bg-emerald-500" />
                                            Selected case
                                        </div>
                                    )}
                                </div>
                            </button>
                        );
                    })}

                    <button
                        type="button"
                        onClick={handleNavigateToCases}
                        className="text-left rounded-2xl border-2 border-dashed border-emerald-200 bg-white transition shadow-sm hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-emerald-100"
                    >
                        <div className="p-6 space-y-4">
                            <div className="space-y-1">
                                <span className="text-xs uppercase tracking-wide text-emerald-600">
                                    Need a different investigation?
                                </span>
                                <h2 className="text-xl font-bold text-gray-900">Browse older cases</h2>
                            </div>
                            <p className="text-sm text-gray-600">
                                Go to the Cases page to select from the full archive, then choose the analysis module you need.
                            </p>
                            <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-600">
                                Go to Cases
                                <ChevronRight className="w-4 h-4" />
                            </span>
                        </div>
                    </button>
                </div>

                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1 text-sm text-gray-500">
                        <p>Select a case to detect anomalies in FDR data.</p>
                    </div>
                    <button
                        type="button"
                        disabled={!selectedCase}
                        onClick={() => selectedCase && setWorkflowStage("analysis")}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                    >
                        Continue to analysis
                    </button>
                </div>
        </div>
    );
}

    if (workflowStage === "analysisChoice") {
        const latestRun =
            analysisRunMeta || selectedCase?.source?.fdrAnalysisLatestRun || null;
        const latestRunActor = latestRun?.createdBy || null;
        const lastAnalyzedLabel = analysisTimestamp
            ? formatAnalysisRunLabel(analysisTimestamp, latestRun)
            : null;
        return (
            <div className="max-w-3xl mx-auto flex flex-col items-center justify-center py-24 text-center space-y-6">
                <div className="rounded-3xl border border-emerald-100 bg-white px-10 py-12 shadow-lg">
                    <p className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-500">
                        FDR Module
                    </p>
                    <h1 className="mt-4 text-3xl font-bold text-gray-900">
                        FDR analysis already exists for this case
                    </h1>
                    <p className="mt-2 text-sm text-gray-600">
                        {lastAnalyzedLabel
                            ? `Last analyzed ${lastAnalyzedLabel}${
                                  latestRunActor
                                      ? ` by ${formatAnalysisActor(latestRunActor)}`
                                      : ""
                              }`
                            : "Select what you would like to do next."}
                    </p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <button
                            type="button"
                            onClick={handleViewLatestResults}
                            className="rounded-xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                        >
                            View latest results
                        </button>
                        <button
                            type="button"
                            onClick={handleStartNewAnalysis}
                            className="rounded-xl border border-gray-200 px-6 py-2 text-sm font-semibold text-gray-700 transition hover:border-emerald-200 hover:text-emerald-600"
                        >
                            Start new analysis
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (workflowStage === "detectionRunning") {
        return (
            <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-24 text-center space-y-6">
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-50">
                    <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
                </div>
                <div className="space-y-2">
                    <p className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-500">
                        FDR Module
                    </p>
                    <h1 className="text-3xl font-bold text-gray-900">
                        Running behavioral anomaly detection...
                    </h1>
                    <p className="text-sm text-gray-600 max-w-md mx-auto">
                        This may take a few minutes depending on dataset size.
                    </p>
                </div>
                <div className="rounded-2xl border border-emerald-100 bg-white px-6 py-4 text-sm text-gray-600 shadow-sm">
                    <p className="font-semibold text-emerald-700">
                        Case {selectedCase?.id || caseNumber}
                    </p>
                    <p className="mt-1">
                        We will automatically load the latest results as soon as the analysis
                        completes.
                    </p>
                </div>
            </div>
        );
    }

    if (workflowStage === "detectionError") {
        return (
            <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-24 text-center space-y-6">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="h-10 w-10"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01" />
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M10.29 3.86l-7.5 13a1 1 0 00.87 1.5h15a1 1 0 00.87-1.5l-7.5-13a1 1 0 00-1.74 0z"
                        />
                    </svg>
                </div>
                <div className="space-y-2">
                    <h1 className="text-3xl font-bold text-gray-900">
                        Analysis couldn&apos;t complete
                    </h1>
                    <p className="text-sm text-gray-600 max-w-md mx-auto">
                        {anomalyError ||
                            "Something went wrong while running behavioral anomaly detection."}
                    </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                        type="button"
                        onClick={handleRunDetection}
                        className="rounded-xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                    >
                        Retry
                    </button>
                    <button
                        type="button"
                        onClick={() => setWorkflowStage("analysis")}
                        className="rounded-xl border border-gray-200 px-6 py-2 text-sm font-semibold text-gray-700 transition hover:border-emerald-200 hover:text-emerald-600"
                    >
                        Back to case
                    </button>
                </div>
            </div>
        );
    }

    if (workflowStage === "detectionComplete") {
        return (
            <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-24">
                <div className="w-full rounded-3xl bg-white p-12 text-center shadow-xl border border-emerald-100">
                    <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-emerald-50">
                        <svg
                            width="56"
                            height="56"
                            viewBox="0 0 56 56"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                            className="text-emerald-500"
                        >
                            <circle cx="28" cy="28" r="28" fill="currentColor" opacity="0.1" />
                            <path
                                d="M38 22L26 34L20 28"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </div>
                    <p className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-500">
                        FDR Module
                    </p>
                    <h1 className="mt-4 text-3xl font-bold text-gray-900">
                        Analysis Completed
                    </h1>
                    <p className="mt-3 text-gray-600 max-w-md mx-auto">
                        The anomaly detection engine processed the selected parameters for
                        case {selectedCase?.id}. Review the synthesized insights and detailed
                        findings in the results dashboard.
                    </p>

                    <div className="mt-10 flex flex-wrap justify-center gap-4">
                        <button
                            type="button"
                            onClick={() => setWorkflowStage("results")}
                            className="rounded-xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition"
                        >
                            View Results
                        </button>
                        <button
                            type="button"
                            onClick={() => setWorkflowStage("analysis")}
                            className="rounded-xl border border-gray-200 px-6 py-2 text-sm font-semibold text-gray-700 transition hover:border-emerald-200 hover:text-emerald-600"
                        >
                            Adjust parameters
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (workflowStage === "export") {
        if (!anomalyResult) {
            return (
                <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-24 text-center space-y-4">
                    <div className="rounded-full bg-emerald-50 p-4 text-emerald-600">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="h-10 w-10"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
                            <circle cx="12" cy="12" r="9" />
                        </svg>
                    </div>
                    <h2 className="text-2xl font-semibold text-gray-900">
                        FDR summary unavailable
                    </h2>
                    <p className="text-sm text-gray-600 max-w-md">
                        Run anomaly detection for this case to populate the FDR summary.
                    </p>
                    <button
                        type="button"
                        onClick={() => setWorkflowStage("analysis")}
                        className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm"
                    >
                        Back to data overview
                    </button>
                </div>
            );
        }

        const investigatorSummary =
            selectedCase?.source?.investigatorSummary ||
            selectedCase?.source?.investigator_summary ||
            "";

        return (
            <div className="max-w-5xl mx-auto space-y-6">
                <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
                    <div>
                        <p className="text-sm uppercase tracking-[0.4em] text-emerald-500">
                            FDR Module
                        </p>
                        <h1 className="text-3xl font-bold text-gray-900">FDR Summary</h1>
                        <p className="text-gray-600">
                            Report-ready summary for {selectedCase?.id} · {selectedCase?.title}
                        </p>
                        {analysisTimestamp && (
                            <p className="mt-2 text-xs text-gray-500">
                                Last analyzed: {formatAnalysisRunLabel(analysisTimestamp, analysisRunMeta)}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setWorkflowStage("results")}
                            className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:border-emerald-200 hover:text-emerald-600"
                        >
                            Back to results
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                if (selectedCase?.id) {
                                    navigate(
                                        `/reports?case=${encodeURIComponent(
                                            selectedCase.id
                                        )}&sections=fdrMetrics`
                                    );
                                }
                            }}
                            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm"
                        >
                            Generate Investigation Report
                        </button>
                    </div>
                </header>

                {caseSummary && (
                    <section className="rounded-3xl bg-white p-6 border border-gray-200">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div>
                                <h2 className="text-lg font-semibold text-gray-900">
                                    Case Summary
                                </h2>
                                <p className="text-sm text-gray-500">
                                    Copy-ready narrative for export.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleCopyCaseSummary}
                                className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                            >
                                {caseSummaryCopied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <p className="mt-4 text-sm text-gray-700">{caseSummary.paragraph}</p>
                        <ul className="mt-4 space-y-1 text-sm text-gray-700">
                            {caseSummary.bullets.map((item) => (
                                <li key={item} className="flex items-start gap-2">
                                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    <span>{item}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {investigatorSummary && (
                    <section className="rounded-3xl bg-white p-6 border border-gray-200">
                        <div className="flex flex-col gap-2">
                            <h2 className="text-lg font-semibold text-gray-900">
                                Investigator Summary
                            </h2>
                            <p className="text-sm text-gray-500">
                                Saved narrative included in exports.
                            </p>
                        </div>
                        <p className="mt-4 text-sm text-gray-700 whitespace-pre-wrap">
                            {investigatorSummary}
                        </p>
                    </section>
                )}

                <section className="rounded-3xl bg-white p-6 border border-gray-200 space-y-5">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">
                            Analysis Details
                        </h2>
                        <p className="text-sm text-gray-500">
                            Investigator-ready overview of parameters and segment attribution.
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            Parameters analyzed
                        </p>
                        {analyzedParameters.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                                {analyzedParameters.map((parameter) => (
                                    <span
                                        key={parameter}
                                        className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600"
                                    >
                                        {parameter}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-2 text-sm text-gray-500">No parameters listed.</p>
                        )}
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            Top contributing parameters
                        </p>
                        {topParameterPreview.length > 0 ? (
                            <ul className="mt-2 space-y-1 text-sm text-gray-700">
                                {topParameterPreview.map((item) => (
                                    <li
                                        key={`${item.name}-${item.count}`}
                                        className="flex items-center justify-between"
                                    >
                                        <span className="font-medium">{item.name}</span>
                                        <span className="text-xs text-gray-500">
                                            {item.count} {item.count === 1 ? "segment" : "segments"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-2 text-sm text-gray-500">
                                No contributing parameters reported.
                            </p>
                        )}
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            Segment counts per parameter
                        </p>
                        {allTopParameters.length > 0 ? (
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                                {allTopParameters.map((item) => (
                                    <div
                                        key={`${item.name}-${item.count}-count`}
                                        className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                                    >
                                        <span>{item.name}</span>
                                        <span className="font-semibold text-gray-900">
                                            {item.count}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-2 text-sm text-gray-500">
                                Segment counts not available for this run.
                            </p>
                        )}
                    </div>
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        Unsupervised behavioral anomaly detection; results are suggestive and require investigator review.
                    </div>
                </section>
            </div>
        );
    }

    if (workflowStage === "results") {
        if (!anomalyResult) {
            return (
                <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-24 text-center space-y-4">
                    <div className="rounded-full bg-emerald-50 p-4 text-emerald-600">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="h-10 w-10"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
                            <circle cx="12" cy="12" r="9" />
                        </svg>
                    </div>
                    <h2 className="text-2xl font-semibold text-gray-900">Detection results unavailable</h2>
                    <p className="text-sm text-gray-600 max-w-md">
                        Run anomaly detection for this case to populate the results dashboard with model insights.
                    </p>
                    <button
                        type="button"
                        onClick={() => setWorkflowStage("analysis")}
                        className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm"
                    >
                        Back to data overview
                    </button>
                </div>
            );
        }

        const totalEvents =
            allTopParameters.reduce((sum, item) => sum + (item?.count || 0), 0) || 1;

        return (
            <div className="max-w-7xl mx-auto space-y-6">
                <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
                    <div>
                        <p className="text-sm uppercase tracking-[0.4em] text-emerald-500">
                            FDR Module
                        </p>
                        <h1 className="text-3xl font-bold text-gray-900">
                            Anomaly Detection Results
                        </h1>
                        <p className="text-gray-600">
                            Generated insights for {selectedCase?.id} · {selectedCase?.title}
                        </p>
                        <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                            {analysisTitle}
                        </div>
                        {analysisTimestamp && (
                            <p className="mt-2 text-xs text-gray-500">
                                Last analyzed: {formatAnalysisRunLabel(analysisTimestamp, analysisRunMeta)}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setWorkflowStage("analysis")}
                            className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:border-emerald-200 hover:text-emerald-600"
                        >
                            Back to data overview
                        </button>
                        <button
                            type="button"
                            onClick={() => setWorkflowStage("export")}
                            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm"
                        >
                            View FDR Summary
                        </button>
                    </div>
                </header>

                {/* Analysis Complete banner + Most Critical Finding hero card */}
                <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                        <svg
                            className="h-5 w-5 flex-shrink-0 text-emerald-600"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 13l4 4L19 7"
                            />
                        </svg>
                        <div>
                            <p className="text-sm font-semibold text-emerald-800">
                                Analysis Complete
                            </p>
                            <p className="text-xs text-emerald-700">
                                {typeof anomalyCount === "number" ? anomalyCount : 0}{" "}
                                segment{anomalyCount !== 1 ? "s" : ""} flagged
                                {typeof flaggedPercent === "number"
                                    ? ` · ${flaggedPercent.toFixed(1)}% of flight`
                                    : ""}
                                {analysisTimestamp
                                    ? ` · ${formatAnalysisRunLabel(analysisTimestamp, analysisRunMeta)}`
                                    : ""}
                            </p>
                        </div>
                    </div>

                    {segments.length > 0 &&
                        (() => {
                            const topSeg = segments[0];
                            const topTone = getSeverityTone(topSeg?.severity);
                            const topRange = formatSegmentTimeRange(topSeg, 0);
                            const topPhase = getSegmentPhaseLabel(topSeg);
                            const topDriversList = resolveSegmentDrivers(topSeg).slice(0, 2);
                            const topScore =
                                topSeg?.score_peak != null
                                    ? (() => { const s = Number(topSeg.score_peak); return s >= 0.1 ? s.toFixed(2) : s < 0.001 ? s.toExponential(2) : s.toFixed(4); })()
                                    : null;
                            return (
                                <div
                                    className={`rounded-xl border p-4 space-y-2 ${topTone.evidencePanel}`}
                                >
                                    <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                                        Most Critical Finding
                                    </p>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span
                                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${topTone.badge}`}
                                        >
                                            {formatSeverityLabel(topSeg?.severity)}
                                        </span>
                                        {topPhase && (
                                            <span className="text-xs font-medium text-gray-600">
                                                {topPhase}
                                            </span>
                                        )}
                                        <span className="text-xs text-gray-500">
                                            {topRange}
                                        </span>
                                        {topScore != null && (
                                            <span className="ml-auto font-mono text-xs text-gray-400">
                                                score {topScore}
                                            </span>
                                        )}
                                    </div>
                                    {topDriversList.length > 0 && (
                                        <p className="text-xs text-gray-700">
                                            {topDriversList.map((d, di) => {
                                                const dev = getDriverDeviationLabel(d);
                                                const hasSigma = Number.isFinite(d.stats?.deviation_sigma);
                                                const segPhase = topSeg?.phase_label;
                                                const direction = (d.stats?.deviation_sigma ?? 0) >= 0 ? "above" : "below";
                                                return (
                                                    <span key={d.param ?? di}>
                                                        {di > 0 && (
                                                            <span className="mx-1 text-gray-300">
                                                                ·
                                                            </span>
                                                        )}
                                                        <span className="font-medium">
                                                            {d.label}
                                                        </span>
                                                        {dev && (
                                                            <span
                                                                className={`ml-1 font-semibold ${
                                                                    dev.startsWith("↑")
                                                                        ? "text-red-600"
                                                                        : "text-blue-600"
                                                                }`}
                                                            >
                                                                {dev}
                                                            </span>
                                                        )}
                                                        {hasSigma && segPhase && (
                                                            <span className="ml-1 text-gray-400">
                                                                {direction} {segPhase} baseline
                                                            </span>
                                                        )}
                                                    </span>
                                                );
                                            })}
                                        </p>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleJumpToSegment(topSeg)}
                                        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${topTone.actionText} ${topTone.evidencePanel}`}
                                    >
                                        View on charts ↗
                                    </button>
                                </div>
                            );
                        })()}

                    {noAnomaliesDetected && (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                            No segments flagged for the current run.
                        </div>
                    )}
                </div>

                <section className="rounded-3xl bg-white p-6 border border-gray-200">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">
                                Behavioral Deviation Score Timeline
                            </h2>
                            <p className="text-sm text-gray-500">
                                Window-based reconstruction error across the flight.
                            </p>
                        </div>
                    </div>
                    <div className="mt-6 h-72">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={scoreTimelineData.length ? scoreTimelineData : detectionTrendData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                <XAxis
                                    dataKey="time"
                                    stroke="#94a3b8"
                                    tickFormatter={formatFlightTime}
                                    label={{
                                        value: timeAxisLabel,
                                        position: "insideBottom",
                                        offset: -2,
                                        fill: "#94a3b8",
                                        fontSize: 11,
                                    }}
                                />
                                <YAxis stroke="#94a3b8" />
                                <Tooltip content={renderScoreTooltip} />
                                {Number.isFinite(detectionThresholdValue) && (
                                    <ReferenceLine
                                        y={detectionThresholdValue}
                                        stroke="#f97316"
                                        strokeDasharray="6 4"
                                        label={{
                                            value:
                                                "Anomaly threshold (derived from baseline distribution)",
                                            position: "right",
                                            fill: "#f97316",
                                            fontSize: 11,
                                        }}
                                    />
                                )}
                                {occurrenceWindow?.start != null &&
                                    occurrenceWindow?.end != null && (
                                        <ReferenceArea
                                            x1={occurrenceWindow.start}
                                            x2={occurrenceWindow.end}
                                            fill="#f59e0b"
                                            fillOpacity={0.2}
                                            stroke="#f59e0b"
                                            strokeOpacity={0.5}
                                            strokeWidth={1}
                                        />
                                    )}
                                {occurrenceWindow?.start != null &&
                                    occurrenceWindow?.end != null && (
                                        <ReferenceLine
                                            x={
                                                (occurrenceWindow.start +
                                                    occurrenceWindow.end) /
                                                2
                                            }
                                            stroke="#f59e0b"
                                            strokeDasharray="4 3"
                                            strokeWidth={1.5}
                                            label={{
                                                value: occurrenceWindow.label
                                                    ? `Occurrence · ${occurrenceWindow.label}`
                                                    : "Occurrence",
                                                position: "top",
                                                fill: "#b45309",
                                                fontSize: 10,
                                            }}
                                        />
                                    )}
                                <Line
                                    type="monotone"
                                    dataKey={scoreTimelineData.length ? "score" : "AIRSPEED"}
                                    stroke="#38bdf8"
                                    strokeWidth={2}
                                    dot={false}
                                    name={
                                        scoreTimelineData.length
                                            ? "Behavioral Deviation Score"
                                            : "Flight Baseline"
                                    }
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                    <p className="mt-3 text-xs text-gray-500">
                        The dashed line marks the anomaly threshold derived from the baseline distribution; higher values
                        reflect stronger deviation from learned normal behavior (not probability).
                    </p>
                </section>

                {/* ── Task 9 — Phase Breakdown ─────────────────────────────────────── */}
                {anomalyResult?.summary?.phase_breakdown && (() => {
                    const pb = anomalyResult.summary.phase_breakdown;
                    const phaseOrder = ["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "LANDING"];
                    const rows = phaseOrder
                        .filter((ph) => pb[ph])
                        .map((ph) => ({ ph, ...pb[ph] }));
                    if (rows.length === 0) return null;

                    const SEV_COLOR = {
                        high: "#ef4444",
                        med: "#f59e0b",
                        low: "#60a5fa",
                    };
                    const maxSegs = Math.max(...rows.map((r) => r.segments_found || 0), 1);

                    return (
                        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                            <div>
                                <h2 className="text-base font-semibold text-gray-900">
                                    Phase Breakdown
                                </h2>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Anomaly segments distributed across flight phases — each phase scored against its own baseline.
                                </p>
                            </div>

                            {/* Mini bar chart */}
                            <div className="flex items-end gap-3 h-20">
                                {rows.map(({ ph, segments_found, worst_severity, used_global_fallback }) => {
                                    const heightPct = maxSegs > 0 ? ((segments_found || 0) / maxSegs) * 100 : 0;
                                    const barColor = SEV_COLOR[worst_severity] || "#e5e7eb";
                                    return (
                                        <div key={ph} className="flex flex-1 flex-col items-center gap-1">
                                            <span className="text-[11px] font-semibold text-gray-700">
                                                {segments_found || 0}
                                            </span>
                                            <div className="w-full flex items-end" style={{ height: 48 }}>
                                                <div
                                                    className="w-full rounded-t transition-all"
                                                    style={{
                                                        height: `${Math.max(segments_found ? 8 : 2, heightPct * 0.48)}px`,
                                                        backgroundColor: segments_found ? barColor : "#f3f4f6",
                                                    }}
                                                />
                                            </div>
                                            <span className="text-[10px] text-gray-500 truncate w-full text-center">
                                                {ph}
                                            </span>
                                            {used_global_fallback && (
                                                <span className="text-[9px] text-amber-500" title="Insufficient rows for per-phase threshold">
                                                    ↩ global
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Compact table */}
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="border-b border-gray-100 text-left text-gray-400 uppercase tracking-wide">
                                            <th className="pb-1.5 pr-3 font-medium">Phase</th>
                                            <th className="pb-1.5 pr-3 font-medium">Rows</th>
                                            <th className="pb-1.5 pr-3 font-medium">Segments</th>
                                            <th className="pb-1.5 pr-3 font-medium">Top Parameter</th>
                                            <th className="pb-1.5 pr-3 font-medium">Threshold</th>
                                            <th className="pb-1.5 font-medium">Baseline</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {rows.map(({ ph, n_rows, segments_found, worst_severity, top_param, threshold, used_global_fallback }) => (
                                            <tr key={ph} className="text-gray-700">
                                                <td className="py-1.5 pr-3 font-semibold">
                                                    <span
                                                        className="inline-block h-2 w-2 rounded-sm mr-1.5"
                                                        style={{ backgroundColor: PHASE_COLORS[ph] || "#94a3b8" }}
                                                    />
                                                    {ph}
                                                </td>
                                                <td className="py-1.5 pr-3 text-gray-500">{n_rows?.toLocaleString() ?? "—"}</td>
                                                <td className="py-1.5 pr-3">
                                                    {segments_found > 0 ? (
                                                        <span
                                                            className="font-semibold"
                                                            style={{ color: SEV_COLOR[worst_severity] || "#374151" }}
                                                        >
                                                            {segments_found}
                                                        </span>
                                                    ) : (
                                                        <span className="text-gray-400">0</span>
                                                    )}
                                                </td>
                                                <td className="py-1.5 pr-3 text-gray-600 max-w-[140px] truncate">
                                                    {top_param ?? <span className="text-gray-300">—</span>}
                                                </td>
                                                <td className="py-1.5 pr-3 font-mono text-gray-500">
                                                    {typeof threshold === "number" ? threshold.toFixed(5) : "—"}
                                                </td>
                                                <td className="py-1.5 text-gray-400 text-[10px]">
                                                    {used_global_fallback
                                                        ? "global fallback"
                                                        : "per-phase"}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    );
                })()}

                <section className="space-y-4">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">Key Summary Cards</h2>
                        <p className="text-sm text-gray-500">
                            Unified highlights for the latest Behavioral Anomaly Detection run.
                        </p>
                    </div>
                    <div className="grid items-stretch gap-4 md:grid-cols-3">
                        <div className="flex h-full flex-col rounded-3xl bg-white p-4 border border-gray-200">
                            <p className="text-xs uppercase tracking-wide text-gray-500">
                                Overview
                            </p>
                            <div className="mt-3 grid gap-3 text-sm text-gray-700">
                                <div>
                                    <p className="text-xs text-gray-500">Segments found</p>
                                    <p className="text-xl font-semibold text-gray-900">
                                        {typeof anomalyCount === "number"
                                            ? anomalyCount.toLocaleString()
                                            : "—"}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-500">Flagged rows</p>
                                    <p className="text-sm font-semibold text-gray-900">
                                        {typeof flaggedRowCount === "number"
                                            ? `${flaggedRowCount.toLocaleString()} rows`
                                            : "—"}
                                        {typeof flaggedPercent === "number"
                                            ? ` · ${flaggedPercent.toFixed(1)}%`
                                            : ""}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-500">Total rows reviewed</p>
                                    <p className="text-sm font-semibold text-gray-900">
                                        {typeof totalRows === "number"
                                            ? totalRows.toLocaleString()
                                            : "—"}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-500">Most severe segment</p>
                                    <p className="text-sm font-semibold text-gray-900">
                                        {mostSevereSegment
                                            ? `${formatSegmentTimeRange(
                                                  mostSevereSegment.segment,
                                                  mostSevereSegment.index
                                              )} · ${formatSeverityLabel(
                                                  mostSevereSegment.segment?.severity
                                              )}`
                                            : "—"}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="flex h-full flex-col rounded-3xl bg-white p-4 border border-gray-200">
                            <div className="flex items-start justify-between gap-2">
                                <div>
                                    <h3 className="text-sm font-semibold text-gray-900">
                                        Top contributing parameters
                                    </h3>
                                    <p className="mt-1 text-xs text-gray-500">
                                        Parameters most frequently contributing to flagged segments.
                                    </p>
                                </div>
                                {allTopParameters.length > 5 && (
                                    <button
                                        type="button"
                                        onClick={() => setShowAllParameters((prev) => !prev)}
                                        className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                                    >
                                        {showAllParameters ? "View top 5" : "View all"}
                                    </button>
                                )}
                            </div>
                            <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1 max-h-48">
                                {visibleTopParameters.length > 0 ? (
                                    visibleTopParameters.map((item) => (
                                        <div
                                            key={item.name}
                                            className="flex items-center justify-between"
                                        >
                                            <div className="flex items-center gap-3">
                                                <span className="h-2.5 w-6 rounded-full bg-emerald-200" />
                                                <span className="text-sm font-medium text-gray-700">
                                                    {item.name}
                                                </span>
                                            </div>
                                            <span className="text-sm font-semibold text-gray-900">
                                                {Math.round((item.count / totalEvents) * 100)}%
                                            </span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-sm text-gray-500">
                                        No contributing parameters reported for this run.
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="flex h-full flex-col rounded-3xl bg-white p-4 border border-gray-200">
                            <h3 className="text-sm font-semibold text-gray-900">
                                Detection settings
                            </h3>
                            <p className="mt-1 text-xs text-gray-500">
                                Model configuration captured for credibility.
                            </p>
                            <div className="mt-3 grid gap-2 text-sm text-gray-700">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-gray-500">Window size</span>
                                    <span className="font-semibold text-gray-900">
                                        {detectionWindowSize ?? "—"}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-gray-500">Stride</span>
                                    <span className="font-semibold text-gray-900">
                                        {detectionStride ?? "—"}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-gray-500">Threshold percentile</span>
                                    <span className="font-semibold text-gray-900">
                                        {detectionThresholdPercentile ?? "—"}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-gray-500">Parameters used</span>
                                    <span className="font-semibold text-gray-900">
                                        {detectionParamsUsed ?? "—"}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {caseSummary && (
                    <section className="rounded-3xl bg-white p-6 border border-gray-200">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div>
                                <h2 className="text-lg font-semibold text-gray-900">
                                    Case Summary
                                </h2>
                                <p className="text-sm text-gray-500">
                                    Report-ready narrative derived from the latest analysis.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleCopyCaseSummary}
                                className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                            >
                                {caseSummaryCopied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <p className="mt-4 text-sm text-gray-700">{caseSummary.paragraph}</p>
                        <ul className="mt-4 space-y-1 text-sm text-gray-700">
                            {caseSummary.bullets.map((item) => (
                                <li key={item} className="flex items-start gap-2">
                                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    <span>{item}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                <section className="rounded-3xl bg-white p-6 border border-gray-200">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">
                                All Findings ({mergedSegments.length})
                            </h2>
                            <p className="text-sm text-gray-500">
                                Evidence-ready review of flagged intervals and contributing parameters.
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {["all", "high", "med", "low"].map((f) => {
                                const fCount =
                                    f === "all"
                                        ? mergedSegments.length
                                        : mergedSegments.filter(
                                              (s) =>
                                                  (s?.severity ?? "low").toLowerCase() === f
                                          ).length;
                                const fActive = severityFilter === f;
                                const fColors = {
                                    all: fActive
                                        ? "bg-gray-900 text-white border-gray-900"
                                        : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
                                    high: fActive
                                        ? "bg-red-600 text-white border-red-600"
                                        : "bg-white text-red-700 border-red-200 hover:bg-red-50",
                                    med: fActive
                                        ? "bg-amber-500 text-white border-amber-500"
                                        : "bg-white text-amber-700 border-amber-200 hover:bg-amber-50",
                                    low: fActive
                                        ? "bg-blue-500 text-white border-blue-500"
                                        : "bg-white text-blue-700 border-blue-200 hover:bg-blue-50",
                                };
                                return (
                                    <button
                                        key={f}
                                        type="button"
                                        onClick={() => setSeverityFilter(f)}
                                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${fColors[f]}`}
                                    >
                                        {f === "all"
                                            ? "All"
                                            : f.charAt(0).toUpperCase() + f.slice(1)}{" "}
                                        ({fCount})
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Task 10 — detection method toggle */}
                    {rulesResult && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-4">
                            {[
                                { key: "all", label: "All" },
                                { key: "ai", label: "AI only" },
                                { key: "rules", label: "Rules only" },
                                { key: "both", label: "Confirmed by both" },
                            ].map(({ key, label }) => {
                                const cnt =
                                    key === "all"
                                        ? mergedSegments.length
                                        : mergedSegments.filter(
                                              (s) => (s.detection_source || "ai") === key
                                          ).length;
                                const active = detectionMethodFilter === key;
                                const colors = {
                                    all: active
                                        ? "bg-gray-800 text-white border-gray-800"
                                        : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
                                    ai: active
                                        ? "bg-blue-600 text-white border-blue-600"
                                        : "bg-white text-blue-700 border-blue-200 hover:bg-blue-50",
                                    rules: active
                                        ? "bg-purple-600 text-white border-purple-600"
                                        : "bg-white text-purple-700 border-purple-200 hover:bg-purple-50",
                                    both: active
                                        ? "bg-rose-600 text-white border-rose-600"
                                        : "bg-white text-rose-700 border-rose-200 hover:bg-rose-50",
                                };
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => setDetectionMethodFilter(key)}
                                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${colors[key]}`}
                                    >
                                        {label} ({cnt})
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="space-y-3">
                        {activeSegments.length > 0 ? (
                            activeSegments.map((segment, index) => {

                                const segmentKey = `${segment?.start_time ?? "seg"}-${index}`;
                                const isExpanded = expandedSegments.has(segmentKey);
                                const topDrivers = resolveSegmentDrivers(segment);
                                const timeRange = formatSegmentTimeRange(segment, index);
                                const severity = formatSeverityLabel(segment?.severity);
                                const severityTone = getSeverityTone(segment?.severity);
                                const timeBounds = resolveSegmentTimeBounds(segment);
                                const interpretation = resolveSegmentInterpretation(segment);

                                const phaseLabel = getSegmentPhaseLabel(segment);
                                const topTwoDrivers = topDrivers.slice(0, 2);
                                const scorePeak =
                                    segment?.score_peak != null
                                        ? (() => { const s = Number(segment.score_peak); return s >= 0.1 ? s.toFixed(2) : s < 0.001 ? s.toExponential(2) : s.toFixed(4); })()
                                        : null;
                                const detSrc = segment?.detection_source || "ai";
                                const srcBadge =
                                    detSrc === "both"
                                        ? { label: "AI + Rule", cls: "bg-rose-100 text-rose-700 border border-rose-200" }
                                        : detSrc === "rules"
                                        ? { label: "Rule", cls: "bg-purple-100 text-purple-700 border border-purple-200" }
                                        : { label: "AI", cls: "bg-blue-100 text-blue-700 border border-blue-200" };
                                // First rule finding for inline description
                                const firstRule = segment?.rule_findings?.[0] ?? (detSrc === "rules" ? segment : null);
                                // Task 15 — correction state for this segment
                                const corrTargetId = String(segment?.start_time ?? '');
                                const sevCorrection = corrections.find((c) => c.type === 'severity_adjustment' && c.target_id === corrTargetId);
                                const effectiveSeverity = sevCorrection?.corrected_value?.severity ?? segment?.severity;
                                const effectiveSeverityTone = getSeverityTone(effectiveSeverity);
                                const corrForm = correctionForms[segmentKey] || {};

                                return (
                                    <div
                                        key={segmentKey}
                                        className="rounded-2xl border border-gray-200 bg-white shadow-sm"
                                    >
                                        <div className="flex w-full items-start gap-2 px-4 py-4">
                                            <button
                                                type="button"
                                                onClick={() => handleJumpToSegment(segment)}
                                                className="flex flex-1 flex-col gap-1.5 text-left transition hover:opacity-80"
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span
                                                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${effectiveSeverityTone.badge}`}
                                                    >
                                                        {formatSeverityLabel(effectiveSeverity)}
                                                    </span>
                                                    {sevCorrection && (
                                                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
                                                            edited
                                                        </span>
                                                    )}
                                                    {/* Task 10 — source badge */}
                                                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${srcBadge.cls}`}>
                                                        {srcBadge.label}
                                                    </span>
                                                    {phaseLabel && (
                                                        <span className="text-xs font-medium text-gray-500">
                                                            {phaseLabel}
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-gray-400">
                                                        {timeRange}
                                                    </span>
                                                    {scorePeak != null && (
                                                        <span className="ml-auto font-mono text-xs text-gray-400">
                                                            score {scorePeak}
                                                        </span>
                                                    )}
                                                </div>
                                                {topTwoDrivers.length > 0 && (
                                                    <p className="text-xs text-gray-600">
                                                        {topTwoDrivers.map((d, di) => {
                                                            const dev = getDriverDeviationLabel(d);
                                                            return (
                                                                <span key={d.param ?? di}>
                                                                    {di > 0 && (
                                                                        <span className="mx-1 text-gray-300">
                                                                            ·
                                                                        </span>
                                                                    )}
                                                                    <span className="font-medium text-gray-700">
                                                                        {d.label}
                                                                    </span>
                                                                    {dev && (
                                                                        <span
                                                                            className={`ml-1 font-semibold ${
                                                                                dev.startsWith("↑")
                                                                                    ? "text-red-600"
                                                                                    : "text-blue-600"
                                                                            }`}
                                                                        >
                                                                            {dev}
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            );
                                                        })}
                                                    </p>
                                                )}
                                                {/* Task 10 — rule description line */}
                                                {firstRule && (
                                                    <p className="text-xs text-purple-700 font-medium">
                                                        {firstRule.rule_name}
                                                        {firstRule.peak_value != null && firstRule.parameter && (
                                                            <span className="font-normal text-purple-600">
                                                                {" — "}
                                                                {firstRule.parameter} reached{" "}
                                                                {Number(firstRule.peak_value).toFixed(1)}
                                                                {" "}(limit: {firstRule.threshold})
                                                            </span>
                                                        )}
                                                    </p>
                                                )}
                                                <p
                                                    className={`text-xs font-medium ${severityTone.actionText}`}
                                                >
                                                    View on charts ↗
                                                </p>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleToggleSegment(segmentKey)}
                                                className="flex-shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500 transition hover:bg-gray-50"
                                                title={isExpanded ? "Hide evidence" : "Show evidence"}
                                            >
                                                {isExpanded ? "▲" : "▼"}
                                            </button>
                                        </div>

                                        {/* Task 15 — Correction action buttons */}
                                        {!corrForm.mode && (
                                            <div className="flex items-center gap-2 px-4 pb-3 -mt-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setCorrectionForms((prev) => ({ ...prev, [segmentKey]: { mode: 'fp', note: '', severity: '' } }))}
                                                    className="rounded-full border border-gray-200 px-2.5 py-0.5 text-[11px] text-gray-400 transition hover:border-red-200 hover:text-red-500"
                                                >
                                                    ✕ False positive
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setCorrectionForms((prev) => ({ ...prev, [segmentKey]: { mode: 'sev', note: '', severity: effectiveSeverity ?? '' } }))}
                                                    className="rounded-full border border-gray-200 px-2.5 py-0.5 text-[11px] text-gray-400 transition hover:border-amber-200 hover:text-amber-600"
                                                >
                                                    ⚡ Adjust severity
                                                </button>
                                            </div>
                                        )}

                                        {/* Task 15 — Inline correction form */}
                                        {corrForm.mode && (
                                            <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2">
                                                <p className="text-xs font-semibold text-gray-700">
                                                    {corrForm.mode === 'fp' ? 'Mark as false positive' : 'Adjust severity'}
                                                </p>
                                                {corrForm.mode === 'sev' && (
                                                    <select
                                                        value={corrForm.severity}
                                                        onChange={(e) => setCorrectionForms((prev) => ({ ...prev, [segmentKey]: { ...prev[segmentKey], severity: e.target.value } }))}
                                                        className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs"
                                                    >
                                                        <option value="high">High</option>
                                                        <option value="med">Medium</option>
                                                        <option value="low">Low</option>
                                                    </select>
                                                )}
                                                <textarea
                                                    value={corrForm.note}
                                                    onChange={(e) => setCorrectionForms((prev) => ({ ...prev, [segmentKey]: { ...prev[segmentKey], note: e.target.value } }))}
                                                    placeholder={corrForm.mode === 'fp' ? 'Reason this is a false positive…' : 'Reason for severity change…'}
                                                    className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-xs"
                                                    rows={2}
                                                />
                                                <div className="flex items-center justify-between">
                                                    <span className={`text-[11px] ${corrForm.note.length >= 10 ? 'text-emerald-600' : 'text-gray-400'}`}>
                                                        {corrForm.note.length}/10 chars{corrForm.note.length >= 10 ? ' ✓' : ` — ${10 - corrForm.note.length} more needed`}
                                                    </span>
                                                    <div className="flex gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => setCorrectionForms((prev) => { const n = { ...prev }; delete n[segmentKey]; return n; })}
                                                            className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 transition hover:bg-gray-100"
                                                        >
                                                            Cancel
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={corrForm.note.length < 10}
                                                            onClick={() => handleSaveCorrection(segmentKey, segment, corrForm.mode, { note: corrForm.note, severity: corrForm.severity })}
                                                            className="rounded-lg bg-gray-800 px-3 py-1 text-xs text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                                                        >
                                                            Confirm
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {isExpanded && (
                                            <div
                                                className={`border-t px-4 py-4 ${severityTone.evidencePanel}`}
                                            >
                                                <p className="text-xs text-gray-500 mb-4">
                                                    Evidence Panel: zoomed to segment window with anomaly
                                                    interval highlights.
                                                </p>
                                                <div
                                                    className={`mb-4 rounded-xl border px-3 py-2 text-xs ${severityTone.interpretationBox}`}
                                                >
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span
                                                            className={`font-semibold ${severityTone.interpretationLabel}`}
                                                        >
                                                            Possible interpretation
                                                        </span>
                                                        {interpretation.tags.length > 0 ? (
                                                            interpretation.tags.map((tag) => (
                                                                <span
                                                                    key={tag}
                                                                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${severityTone.interpretationTag}`}
                                                                >
                                                                    {tag}
                                                                </span>
                                                            ))
                                                        ) : (
                                                            <span
                                                                className={`text-[11px] ${severityTone.interpretationLabel}`}
                                                            >
                                                                No rule-based match
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p
                                                        className={`mt-1 text-[11px] ${severityTone.interpretationLabel}`}
                                                    >
                                                        {interpretation.note}
                                                    </p>
                                                </div>
                                                {/* Task 11 — Explainability table (AI and AI+Rule segments) */}
                                                {segment.detection_source !== "rules" && topDrivers.some((d) => d.stats?.deviation_sigma != null) && (
                                                    <div className="mb-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
                                                        <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5">
                                                            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                                                                Parameter Analysis
                                                            </span>
                                                        </div>
                                                        <table className="w-full text-xs">
                                                            <thead>
                                                                <tr className="border-b border-gray-100 bg-gray-50">
                                                                    <th className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Parameter</th>
                                                                    <th className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Phase</th>
                                                                    <th className="px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400">Baseline (mean±std)</th>
                                                                    <th className="px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400">Actual</th>
                                                                    <th className="px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400">Deviation</th>
                                                                    <th className="px-3 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-400">Type</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody className="divide-y divide-gray-50">
                                                                {topDrivers.filter((d) => d.stats?.deviation_sigma != null).map((driver) => {
                                                                    const s = driver.stats;
                                                                    const unitSuffix = driver.unit ? ` ${driver.unit}` : "";
                                                                    const baselineStr =
                                                                        s.baseline_mean != null && s.baseline_std != null
                                                                            ? `${s.baseline_mean.toFixed(1)} ± ${s.baseline_std.toFixed(1)}${unitSuffix}`
                                                                            : s.baseline_median != null
                                                                            ? `${s.baseline_median.toFixed(1)}${unitSuffix}`
                                                                            : "—";
                                                                    const actualStr = s.actual_value != null ? `${Number(s.actual_value).toFixed(2)}${unitSuffix}` : "—";
                                                                    const sigma = s.deviation_sigma;
                                                                    const sigmaStr = sigma != null ? `${sigma >= 0 ? "+" : ""}${sigma.toFixed(1)}σ` : "—";
                                                                    const devType = s.deviation_type;
                                                                    const typeConfig = {
                                                                        spike: { label: "Spike", cls: "bg-red-100 text-red-700" },
                                                                        drop:  { label: "Drop",  cls: "bg-blue-100 text-blue-700" },
                                                                        drift: { label: "Drift", cls: "bg-amber-100 text-amber-700" },
                                                                        normal:{ label: "Normal",cls: "bg-gray-100 text-gray-600" },
                                                                    }[devType] ?? { label: "—", cls: "bg-gray-100 text-gray-400" };
                                                                    const rowPhase = segment?.phase_label ?? getSegmentPhaseLabel(segment) ?? "—";
                                                                    return (
                                                                        <tr key={driver.param} className="transition-colors hover:bg-gray-50">
                                                                            <td className="px-3 py-2 font-medium text-gray-800">
                                                                                {driver.label}{driver.unit ? ` (${driver.unit})` : ""}
                                                                            </td>
                                                                            <td className="px-3 py-2 text-gray-500">{rowPhase}</td>
                                                                            <td className="px-3 py-2 text-right font-mono text-gray-600">{baselineStr}</td>
                                                                            <td className="px-3 py-2 text-right font-mono text-gray-800">{actualStr}</td>
                                                                            <td className={`px-3 py-2 text-right font-mono font-semibold ${sigma != null && sigma >= 0 ? "text-red-600" : "text-blue-600"}`}>{sigmaStr}</td>
                                                                            <td className="px-3 py-2 text-center">
                                                                                <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${typeConfig.cls}`}>
                                                                                    {typeConfig.label}
                                                                                </span>
                                                                            </td>
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                )}

                                                {/* Task 11 — Rule confirmation note for AI+Rule segments */}
                                                {segment.detection_source === "both" && segment.rule_findings?.length > 0 && (
                                                    <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2">
                                                        <p className="text-[11px] text-purple-700">
                                                            <span className="font-semibold">Also confirmed by rule:</span>{" "}
                                                            {segment.rule_findings.map((rf) => rf.rule_name).join(", ")}
                                                        </p>
                                                    </div>
                                                )}

                                                {/* Task 11 — Rule evidence card for Rule-only segments */}
                                                {segment.detection_source === "rules" && segment.rule_findings?.length > 0 && (
                                                    <div className="mb-4 overflow-hidden rounded-xl border border-purple-200 bg-purple-50">
                                                        <div className="border-b border-purple-100 px-3 py-1.5">
                                                            <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-600">
                                                                Rule Findings
                                                            </span>
                                                        </div>
                                                        <div className="divide-y divide-purple-100">
                                                            {segment.rule_findings.map((rf, rfi) => (
                                                                <div key={rfi} className="px-3 py-2">
                                                                    <p className="text-xs font-semibold text-purple-800">{rf.rule_name}</p>
                                                                    <p className="mt-0.5 text-xs text-purple-600">
                                                                        {rf.parameter} reached{" "}
                                                                        {rf.peak_value != null ? Number(rf.peak_value).toFixed(1) : "—"}
                                                                        {" "}— limit: {rf.threshold}
                                                                    </p>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="grid gap-4 lg:grid-cols-3">
                                                    {topDrivers.length > 0 ? (
                                                        topDrivers.map((driver) => {
                                                            const {
                                                                rawData,
                                                                chartData,
                                                            } = buildSegmentChartData(
                                                                driver.param,
                                                                timeBounds
                                                            );
                                                            const unitLabel = driver.unit
                                                                ? ` (${driver.unit})`
                                                                : "";
                                                            const stats = driver.stats;
                                                            const renderConfig =
                                                                getEvidenceSeriesRenderConfig(
                                                                    rawData,
                                                                    "value"
                                                                );

                                                            return (
                                                                <div
                                                                    key={`${segmentKey}-${driver.param}`}
                                                                    className="rounded-2xl border border-gray-200 bg-white p-3"
                                                                >
                                                                    <p className="text-sm font-semibold text-gray-900">
                                                                        {driver.label}
                                                                        {unitLabel}
                                                                    </p>
                                                                    <div className="mt-3 h-40">
                                                                        {chartData.length > 0 ? (
                                                                            <ResponsiveContainer
                                                                                width="100%"
                                                                                height="100%"
                                                                            >
                                                                                <ComposedChart
                                                                                    data={chartData}
                                                                                    margin={{
                                                                                        top: 8,
                                                                                        right: 12,
                                                                                        left: 0,
                                                                                        bottom: 0,
                                                                                    }}
                                                                                >
                                                                                    <CartesianGrid
                                                                                        strokeDasharray="3 3"
                                                                                        stroke="#e5e7eb"
                                                                                    />
                                                                                    <XAxis
                                                                                        dataKey="time"
                                                                                        stroke="#94a3b8"
                                                                                        tickFormatter={
                                                                                            formatFlightTime
                                                                                        }
                                                                                        minTickGap={20}
                                                                                        label={{
                                                                                            value: timeAxisLabel,
                                                                                            position: "insideBottom",
                                                                                            offset: -2,
                                                                                            fill: "#94a3b8",
                                                                                            fontSize: 10,
                                                                                        }}
                                                                                    />
                                                                                    <YAxis
                                                                                        stroke="#94a3b8"
                                                                                        domain={["auto", "auto"]}
                                                                                    />
                                                                                    <Tooltip
                                                                                        content={({
                                                                                            active,
                                                                                            payload,
                                                                                            label,
                                                                                        }) => {
                                                                                            if (
                                                                                                !active ||
                                                                                                !payload?.length
                                                                                            ) {
                                                                                                return null;
                                                                                            }
                                                                                            return (
                                                                                                <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 shadow-sm">
                                                                                                    <p className="font-semibold text-gray-800">
                                                                                                        {driver.label}
                                                                                                    </p>
                                                                                                    <p className="mt-1">
                                                                                                        {formatNumericValue(
                                                                                                            payload[0]
                                                                                                                .value
                                                                                                        )}{" "}
                                                                                                        {driver.unit}
                                                                                                    </p>
                                                                                                    <p className="mt-1 text-[11px] text-gray-500">
                                                                                                        {timeAxisLabel}:{" "}
                                                                                                        {formatFlightTime(
                                                                                                            label
                                                                                                        )}
                                                                                                    </p>
                                                                                                </div>
                                                                                            );
                                                                                        }}
                                                                                    />
                                                                                    <Line
                                                                                        type={
                                                                                            renderConfig.lineType
                                                                                        }
                                                                                        dataKey="value"
                                                                                        stroke="#0ea5e9"
                                                                                        strokeWidth={1}
                                                                                        dot={false}
                                                                                        connectNulls
                                                                                        isAnimationActive={false}
                                                                                    />
                                                                                </ComposedChart>
                                                                            </ResponsiveContainer>
                                                                        ) : (
                                                                            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-xs text-gray-500">
                                                                                No numeric data available.
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="mt-3 space-y-1 text-xs text-gray-600">
                                                                        <p>
                                                                            <span className="font-semibold text-gray-700">
                                                                                Segment range:
                                                                            </span>{" "}
                                                                            {formatNumericValue(
                                                                                stats?.segment_min
                                                                            )}{" "}
                                                                            →{" "}
                                                                            {formatNumericValue(
                                                                                stats?.segment_max
                                                                            )}
                                                                        </p>
                                                                        <p>
                                                                            <span className="font-semibold text-gray-700">
                                                                                Baseline (5–95%):
                                                                            </span>{" "}
                                                                            {formatNumericValue(
                                                                                stats?.baseline_p5
                                                                            )}{" "}
                                                                            →{" "}
                                                                            {formatNumericValue(
                                                                                stats?.baseline_p95
                                                                            )}
                                                                        </p>
                                                                        <p>
                                                                            <span className="font-semibold text-gray-700">
                                                                                Baseline median:
                                                                            </span>{" "}
                                                                            {formatNumericValue(
                                                                                stats?.baseline_median
                                                                            )}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })
                                                    ) : (
                                                        <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-4 text-sm text-gray-500">
                                                            No contributing parameters reported for this segment.
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        ) : (
                            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                                {detectionMethodFilter !== "all"
                                    ? `No ${detectionMethodFilter === "both" ? "confirmed-by-both" : detectionMethodFilter}-method findings${severityFilter !== "all" ? ` at ${severityFilter} severity` : ""}.`
                                    : severityFilter === "all"
                                    ? "No segments returned for this run."
                                    : `No ${severityFilter}-severity segments found.`}
                            </div>
                        )}
                        {extraSegmentsOmitted > 0 && (
                            <p className="pt-2 text-center text-xs text-gray-400">
                                and {extraSegmentsOmitted} more low-severity finding
                                {extraSegmentsOmitted !== 1 ? "s" : ""} omitted from this
                                report
                            </p>
                        )}
                    </div>

                    {/* Task 15 — Dismissed findings section (above Rules checked) */}
                    {dismissedSegments.length > 0 && (
                        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                            <button
                                type="button"
                                onClick={() => setDismissedOpen((v) => !v)}
                                className="flex w-full items-center justify-between px-5 py-3.5 text-left"
                            >
                                <div className="flex items-center gap-2.5">
                                    <span className="text-sm font-semibold text-gray-400">
                                        Dismissed findings
                                    </span>
                                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-400">
                                        {dismissedSegments.length}
                                    </span>
                                </div>
                                <span className="text-xs text-gray-400">{dismissedOpen ? "▲" : "▼"}</span>
                            </button>
                            {dismissedOpen && (
                                <div className="divide-y divide-gray-50 border-t border-gray-100">
                                    {dismissedSegments.map((seg, di) => {
                                        const fpCorr = corrections.find((c) => c.type === 'false_positive' && c.target_id === String(seg?.start_time ?? ''));
                                        const dTone = getSeverityTone(seg?.severity);
                                        return (
                                            <div key={`dismissed-${seg?.start_time ?? di}`} className="px-5 py-3 opacity-60">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold line-through ${dTone.badge}`}>
                                                        {formatSeverityLabel(seg?.severity)}
                                                    </span>
                                                    <span className="text-xs text-gray-400 line-through">{formatSegmentTimeRange(seg, di)}</span>
                                                </div>
                                                <p className="mt-1 text-[11px] text-gray-400">
                                                    False positive — {fpCorr?.note}
                                                    <span className="ml-2 text-gray-300">by {fpCorr?.investigator}</span>
                                                </p>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}
                </section>

                {/* Task 10 — Rules checked section */}
                {(() => {
                    const rulesChecked = rulesResult?.rules_checked || [];
                    // Only flag as "failed" if detection was actually attempted this session.
                    // Avoids showing "unavailable" when viewing previously saved analysis.
                    const rulesFailed = rulesWasAttempted && rulesResult === null && anomalyResult !== null;
                    if (!rulesFailed && rulesChecked.length === 0) return null;

                    const checkedCount = rulesChecked.filter((r) => r.status === "checked").length;
                    const skippedCount = rulesChecked.filter((r) => r.status === "skipped").length;
                    const findingsCount = rulesChecked.reduce((sum, r) => sum + (r.findings_count || 0), 0);

                    return (
                        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                            <button
                                type="button"
                                onClick={() => setRulesCheckedOpen((v) => !v)}
                                className="flex w-full items-center justify-between px-5 py-3.5 text-left"
                            >
                                <div className="flex items-center gap-2.5">
                                    <span className="text-sm font-semibold text-gray-800">
                                        Rules checked
                                    </span>
                                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                                        {checkedCount} checked · {skippedCount} skipped · {findingsCount} finding{findingsCount !== 1 ? "s" : ""}
                                    </span>
                                </div>
                                <span className="text-xs text-gray-400">{rulesCheckedOpen ? "▲" : "▼"}</span>
                            </button>

                            {rulesCheckedOpen && (
                                <div className="border-t border-gray-100 px-5 pb-4 pt-3 space-y-1">
                                    {rulesFailed ? (
                                        <p className="text-xs text-amber-600 font-medium">
                                            ⚠ Rule-based detection unavailable for this file format
                                        </p>
                                    ) : (
                                        <>
                                            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                                <span>Rule</span>
                                                <span className="text-right">Parameter</span>
                                                <span className="text-right">Threshold</span>
                                                <span className="text-right">Findings</span>
                                            </div>
                                            {rulesChecked.map((r) => (
                                                <div
                                                    key={r.rule_id}
                                                    className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 py-1 text-xs border-b border-gray-50 last:border-0"
                                                >
                                                    <span className="text-gray-700 font-medium">
                                                        {r.rule_name}
                                                    </span>
                                                    <span className="text-right text-gray-500 max-w-[140px] truncate">
                                                        {r.status === "skipped" ? (
                                                            <span className="text-amber-500 italic" title={r.reason}>
                                                                not found
                                                            </span>
                                                        ) : (
                                                            r.parameter || "—"
                                                        )}
                                                    </span>
                                                    <span className="text-right font-mono text-gray-400">
                                                        {r.threshold != null ? r.threshold : "—"}
                                                    </span>
                                                    <span
                                                        className={`text-right font-semibold ${
                                                            r.status === "skipped"
                                                                ? "text-gray-300"
                                                                : r.findings_count > 0
                                                                ? "text-purple-600"
                                                                : "text-gray-400"
                                                        }`}
                                                    >
                                                        {r.status === "skipped" ? "—" : r.findings_count}
                                                    </span>
                                                </div>
                                            ))}
                                        </>
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })()}

                {/* Task 15 — Corrections Log */}
                {corrections.length > 0 && (
                    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                        <button
                            type="button"
                            onClick={() => setCorrectionsLogOpen((v) => !v)}
                            className="flex w-full items-center justify-between px-5 py-3.5 text-left"
                        >
                            <div className="flex items-center gap-2.5">
                                <span className="text-sm font-semibold text-gray-800">Corrections Log</span>
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                                    {corrections.length} entr{corrections.length !== 1 ? "ies" : "y"}
                                </span>
                            </div>
                            <span className="text-xs text-gray-400">{correctionsLogOpen ? "▲" : "▼"}</span>
                        </button>
                        {correctionsLogOpen && (
                            <div className="border-t border-gray-100 overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="border-b border-gray-100 bg-gray-50">
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Type</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Target</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Original → Corrected</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Note</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">By</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">When</th>
                                            <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {corrections.map((corr) => {
                                            const typeLabel = corr.type === 'false_positive' ? 'False positive' : corr.type === 'severity_adjustment' ? 'Severity adjusted' : 'Phase correction';
                                            const originalStr = corr.type === 'false_positive' ? `severity: ${corr.original_value?.severity ?? '—'}` : corr.type === 'severity_adjustment' ? corr.original_value?.severity ?? '—' : corr.original_value?.phase ?? '—';
                                            const correctedStr = corr.type === 'false_positive' ? 'dismissed' : corr.type === 'severity_adjustment' ? corr.corrected_value?.severity ?? '—' : corr.corrected_value?.phase ?? '—';
                                            const whenStr = corr.timestamp ? new Date(corr.timestamp).toLocaleDateString() : '—';
                                            const isConfirming = deleteConfirmId === corr.id;
                                            return (
                                                <tr key={corr.id} className="hover:bg-gray-50 transition-colors">
                                                    <td className="px-4 py-2 font-medium text-gray-700">{typeLabel}</td>
                                                    <td className="px-4 py-2 font-mono text-gray-500">{corr.target_id || '—'}</td>
                                                    <td className="px-4 py-2 text-gray-600">
                                                        <span className="text-gray-400">{originalStr}</span>
                                                        <span className="mx-1 text-gray-300">→</span>
                                                        <span className="font-medium text-gray-700">{correctedStr}</span>
                                                    </td>
                                                    <td className="px-4 py-2 text-gray-600 max-w-[200px] truncate" title={corr.note}>{corr.note}</td>
                                                    <td className="px-4 py-2 text-gray-400 max-w-[120px] truncate" title={corr.investigator}>{corr.investigator}</td>
                                                    <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{whenStr}</td>
                                                    <td className="px-4 py-2">
                                                        {isConfirming ? (
                                                            <div className="flex items-center gap-1">
                                                                <span className="text-[10px] text-red-600">Sure?</span>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleDeleteCorrection(corr.id)}
                                                                    className="rounded bg-red-500 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-600 transition"
                                                                >
                                                                    Yes
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setDeleteConfirmId(null)}
                                                                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 transition"
                                                                >
                                                                    No
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => setDeleteConfirmId(corr.id)}
                                                                className="text-[10px] text-gray-300 hover:text-red-500 transition"
                                                                title="Delete this correction"
                                                            >
                                                                ✕
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                )}

                <section className="rounded-3xl bg-white p-6 border border-gray-200">
                    <h2 className="text-lg font-semibold text-gray-900">Notes</h2>
                    <p className="mt-1 text-sm text-gray-500">
                        Summaries and contextual observations captured by investigators.
                    </p>
                    <NotesPanel
                        caseNumber={caseNumber}
                        module="FDR"
                        relatedRunId={notesRunId}
                        emptyMessage="No FDR notes saved yet."
                    />
                </section>
            </div>
        );
    }
    const canOfferUpload = isLinkedRoute && missingDataTypes.length > 0;
    if (workflowStage === "analysis" && !selectedCase) {
          if (linkError) {
            return (
                <div className="max-w-3xl mx-auto py-24 text-center space-y-6">
                    <div className="space-y-2">
                        <h1 className="text-3xl font-semibold text-gray-900">Unable to open case</h1>
                        <p className="text-sm text-gray-600">{linkError}</p>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:justify-center gap-3">
                        <button
                            type="button"
                            onClick={handleNavigateToCases}
                            className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                            Back to cases
                        </button>
                        {canOfferUpload ? (
                            <button
                                type="button"
                                onClick={handleUploadMissingData}
                                className="inline-flex items-center justify-center rounded-lg border border-emerald-500 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
                            >
                                Upload required data
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={handleChangeCase}
                                className="inline-flex items-center justify-center rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                            >
                                Choose another case
                            </button>
                        )}
                    </div>
                </div>
            );
        }
        return (
            <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-4 py-24 text-center">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
                <div className="space-y-1">
                    <p className="text-sm font-semibold text-emerald-600">Preparing analysis workspace</p>
                    <p className="text-sm text-gray-600">
                        Loading the selected case details. This may take a moment.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-gray-900">FDR Module</h1>
                    <p className="text-gray-600">
                        Configure parameters, review recorded data, and launch anomaly
                        detection for the selected flight case.
                    </p>
                </div>
                <div className="flex flex-col items-start gap-2 text-left sm:flex-row sm:items-center sm:gap-3 sm:text-right">
                    <div className="sm:text-right">
                        <p className="text-sm text-gray-500">Active Case</p>
                        <p className="text-sm font-semibold text-gray-800">
                            {selectedCase?.id} · {selectedCase?.title}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={handleChangeCase}
                            className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 transition hover:border-emerald-200 hover:text-emerald-600"
                        >
                            Change case
                        </button>
                        <button
                            type="button"
                            onClick={handleRunDetection}
                            disabled={isRunningDetection || availableParameters.length === 0}
                            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-200"
                        >
                            {isRunningDetection ? "Running..." : "Run Analysis"}
                        </button>
                    </div>
                </div>
            </header>

            {isLoadingFdrData && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                    Loading FDR data from object storage...
                </div>
            )}
            {fdrDataError && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {fdrDataError}
                </div>
            )}

            <section className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
                <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-gray-900">Anomaly Detection</h2>
                </div>

                <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Current scope</p>
                    <p className="font-semibold text-gray-800">{detectionScopeLabel}</p>
                </div>

                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    {analysisTitle}
                </div>
                {analysisTimestamp && (
                    <div className="text-xs text-gray-500">
                        Last analyzed: {formatAnalysisRunLabel(analysisTimestamp, analysisRunMeta)}
                    </div>
                )}

                {anomalyError && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        {anomalyError}
                    </div>
                )}

                {(isRunningDetection || anomalyResult || anomalyError) && (
                    <div className="space-y-3">
                        {isRunningDetection && !anomalyResult && (
                            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                                <svg
                                    className="h-4 w-4 animate-spin text-emerald-600"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                >
                                    <circle
                                        className="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        strokeWidth="4"
                                    />
                                    <path
                                        className="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                    />
                                </svg>
                                Analysing…
                            </div>
                        )}

                        {anomalyResult && (
                            <button
                                type="button"
                                onClick={() => setWorkflowStage("results")}
                                className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition"
                            >
                                View Analysis Results →
                            </button>
                        )}
                    </div>
                )}
            </section>

            {/* ── Flight Segment Selector (Task 6) ───────────────────────────────── */}
            {isLoadingSegments && (
                <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
                    Detecting flight segments…
                </div>
            )}
            {segmentError && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    {segmentError}
                </div>
            )}
            {!isLoadingSegments && flightSegments && flightSegments.length === 1 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-sm">
                    <span className="font-semibold text-gray-800">Single flight detected</span>
                    {flightSegments[0].duration_min != null && (
                        <span>· {flightSegments[0].duration_min} min</span>
                    )}
                    {flightSegments[0].max_altitude_ft != null && (
                        <span>· {flightSegments[0].max_altitude_ft.toLocaleString()} ft max alt</span>
                    )}
                    {flightSegments[0].avg_ias_knots != null && (
                        <span>· {flightSegments[0].avg_ias_knots} kts avg IAS</span>
                    )}
                    <span
                        className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${segmentBadgeClass}`}
                        title={segmentDetectionMethod}
                    >
                        {segmentBadgeLabel}
                    </span>
                </div>
            )}
            {!isLoadingSegments && flightSegments && flightSegments.length > 1 && (
                <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h2 className="text-sm font-semibold text-gray-900">
                                Flights Detected
                                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                    {flightSegments.length}
                                </span>
                            </h2>
                            <p className="text-xs text-gray-500 mt-0.5">
                                Select a flight to filter all charts to that segment.
                            </p>
                        </div>
                        <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${segmentBadgeClass}`}
                            title={segmentDetectionMethod}
                        >
                            {segmentBadgeLabel}
                        </span>
                    </div>
                    {/* Pill selectors */}
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => setSelectedFlightIndex(null)}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                selectedFlightIndex === null
                                    ? "border-emerald-500 bg-emerald-600 text-white"
                                    : "border-gray-200 text-gray-600 hover:border-emerald-300 hover:text-emerald-700"
                            }`}
                        >
                            All Flights
                        </button>
                        {flightSegments.map((seg) => (
                            <button
                                key={seg.flight_index}
                                type="button"
                                onClick={() =>
                                    setSelectedFlightIndex(
                                        selectedFlightIndex === seg.flight_index ? null : seg.flight_index
                                    )
                                }
                                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                    selectedFlightIndex === seg.flight_index
                                        ? "border-emerald-500 bg-emerald-600 text-white"
                                        : "border-gray-200 text-gray-600 hover:border-emerald-300 hover:text-emerald-700"
                                }`}
                            >
                                Flight {seg.flight_index}
                            </button>
                        ))}
                    </div>
                    {/* Segment table */}
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                                <tr>
                                    <th className="px-3 py-2 text-left">#</th>
                                    <th className="px-3 py-2 text-left">Start</th>
                                    <th className="px-3 py-2 text-left">End</th>
                                    <th className="px-3 py-2 text-left">Duration</th>
                                    <th className="px-3 py-2 text-right">Max Alt</th>
                                    <th className="px-3 py-2 text-right">Avg IAS</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {flightSegments.map((seg) => {
                                    const isActive = selectedFlightIndex === seg.flight_index;
                                    return (
                                        <tr
                                            key={seg.flight_index}
                                            onClick={() =>
                                                setSelectedFlightIndex(
                                                    isActive ? null : seg.flight_index
                                                )
                                            }
                                            className={`cursor-pointer transition ${
                                                isActive
                                                    ? "bg-emerald-50 font-semibold text-emerald-900"
                                                    : "text-gray-700 hover:bg-gray-50"
                                            }`}
                                        >
                                            <td className="px-3 py-2">{seg.flight_index}</td>
                                            <td className="px-3 py-2">{formatSessionTime(seg.start_time)}</td>
                                            <td className="px-3 py-2">{formatSessionTime(seg.end_time)}</td>
                                            <td className="px-3 py-2">{seg.duration_min} min</td>
                                            <td className="px-3 py-2 text-right">
                                                {seg.max_altitude_ft != null
                                                    ? `${seg.max_altitude_ft.toLocaleString()} ft`
                                                    : "—"}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                {seg.avg_ias_knots != null
                                                    ? `${seg.avg_ias_knots} kts`
                                                    : "—"}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {selectedFlightIndex !== null && (
                        <p className="text-xs text-amber-700 font-medium">
                            Viewing Flight {selectedFlightIndex} — all charts below show only this segment.
                            <button
                                type="button"
                                onClick={() => setSelectedFlightIndex(null)}
                                className="ml-2 underline hover:text-amber-900"
                            >
                                Clear filter
                            </button>
                        </p>
                    )}
                </section>
            )}

            {/* ── Phase Timeline Bar (Task 7) ──────────────────────────────────────── */}
            {isLoadingPhases && (
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                    <div className="h-3.5 w-28 animate-pulse rounded bg-gray-200" />
                    <div className="h-8 w-full animate-pulse rounded-lg bg-gray-100" />
                </div>
            )}
            {!isLoadingPhases && (phaseError || (flightPhases && flightPhases.length === 0)) && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-500">
                    Phase detection unavailable — insufficient vertical speed data
                </div>
            )}
            {!isLoadingPhases && groupedPhases.length > 0 && (() => {
                const totalDuration = groupedPhases.reduce((sum, p) => sum + p.duration_s, 0);
                return (
                    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-semibold text-gray-900">Flight Phases</h2>
                                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${phaseBadgeClass}`}>
                                    {phaseBadgeLabel}
                                </span>
                            </div>
                            {selectedPhaseKey && (
                                <button
                                    type="button"
                                    onClick={() => setSelectedPhaseKey(null)}
                                    className="text-xs text-gray-500 underline hover:text-gray-700"
                                >
                                    Clear phase filter
                                </button>
                            )}
                        </div>

                        {/* Phase bar — max 5 solid blocks, 2 px gaps, 36 px tall */}
                        {totalDuration > 0 && (
                            <div className="group relative">
                                <div className="flex h-9 w-full gap-0.5">
                                    {groupedPhases.map((p) => {
                                        const widthPct = (p.duration_s / totalDuration) * 100;
                                        const isActive = selectedPhaseKey === p.phase;
                                        const isAnySelected = selectedPhaseKey !== null;
                                        const hasPhaseCorrection = corrections.some((c) => c.type === 'phase_correction' && c.target_id === p.phase);
                                        return (
                                            <div
                                                key={p.phase}
                                                title={`${p.phase} — ${formatPhaseDuration(p.duration_s)}`}
                                                onClick={() => !phaseEditMode && setSelectedPhaseKey(isActive ? null : p.phase)}
                                                style={{
                                                    width: `${widthPct}%`,
                                                    backgroundColor: PHASE_COLORS[p.phase] || "#94a3b8",
                                                    opacity: isAnySelected && !phaseEditMode
                                                        ? isActive ? 1 : 0.35
                                                        : 0.85,
                                                }}
                                                className={`relative flex flex-col items-center justify-center overflow-hidden rounded-md px-1 text-white transition-opacity select-none ${phaseEditMode ? 'cursor-default' : 'cursor-pointer hover:opacity-100'}`}
                                            >
                                                {phaseEditMode ? (
                                                    <select
                                                        value={phaseCorrectionForm[p.phase] ?? p.phase}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onChange={(e) => setPhaseCorrectionForm((prev) => ({ ...prev, [p.phase]: e.target.value }))}
                                                        className="w-full rounded bg-black/20 text-[10px] text-white border-0 outline-none cursor-pointer"
                                                    >
                                                        {["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "LANDING"].map((ph) => (
                                                            <option key={ph} value={ph} className="text-gray-900 bg-white">{ph}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <>
                                                        {widthPct > 8 && (
                                                            <span className="truncate text-xs font-bold leading-tight">
                                                                {widthPct > 14 ? p.phase : p.phase.slice(0, 2)}
                                                            </span>
                                                        )}
                                                        {widthPct > 14 && (
                                                            <span className="truncate text-[10px] leading-tight opacity-90">
                                                                {formatPhaseDuration(p.duration_s)}
                                                            </span>
                                                        )}
                                                        {hasPhaseCorrection && (
                                                            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-white opacity-80" title="Phase corrected" />
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                {/* Task 15 — Phase edit toggle button (appears on bar hover) */}
                                <button
                                    type="button"
                                    onClick={() => { setPhaseEditMode((v) => !v); setPhaseCorrectionForm({}); setPhaseEditNote(''); }}
                                    className={`absolute -right-7 top-1/2 -translate-y-1/2 rounded-full border p-1 text-[11px] transition ${phaseEditMode ? 'border-amber-300 bg-amber-50 text-amber-600' : 'border-gray-200 bg-white text-gray-400 opacity-0 group-hover:opacity-100'}`}
                                    title={phaseEditMode ? 'Cancel phase edit' : 'Edit phase labels'}
                                >
                                    ✏
                                </button>
                                {/* Task 15 — Phase edit save row */}
                                {phaseEditMode && (
                                    <div className="mt-2 flex items-center gap-2">
                                        <textarea
                                            value={phaseEditNote}
                                            onChange={(e) => setPhaseEditNote(e.target.value)}
                                            placeholder="Reason for phase relabeling…"
                                            className="flex-1 resize-none rounded-lg border border-gray-200 px-2 py-1 text-xs"
                                            rows={1}
                                        />
                                        <span className={`whitespace-nowrap text-[11px] ${phaseEditNote.length >= 10 ? 'text-emerald-600' : 'text-gray-400'}`}>
                                            {phaseEditNote.length}/10{phaseEditNote.length >= 10 ? ' ✓' : ''}
                                        </span>
                                        <button
                                            type="button"
                                            disabled={phaseEditNote.length < 10}
                                            onClick={handleSavePhaseCorrections}
                                            className="rounded-lg bg-gray-800 px-3 py-1 text-xs text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setPhaseEditMode(false); setPhaseCorrectionForm({}); setPhaseEditNote(''); }}
                                            className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 transition hover:bg-gray-50"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Legend — click to filter, same as bar */}
                        <div className="flex flex-wrap gap-4">
                            {groupedPhases.map((p) => {
                                const isActive = selectedPhaseKey === p.phase;
                                return (
                                    <button
                                        key={p.phase}
                                        type="button"
                                        onClick={() =>
                                            setSelectedPhaseKey(isActive ? null : p.phase)
                                        }
                                        className={`flex items-center gap-1.5 text-xs transition ${
                                            isActive
                                                ? "font-bold text-gray-900"
                                                : "text-gray-500 hover:text-gray-800"
                                        }`}
                                    >
                                        <span
                                            className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                                            style={{ backgroundColor: PHASE_COLORS[p.phase] || "#94a3b8" }}
                                        />
                                        {p.phase}
                                        <span className="text-gray-400">
                                            ({formatPhaseDuration(p.duration_s)})
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        {selectedPhaseKey && (
                            <p className="text-xs font-medium" style={{ color: PHASE_COLORS[selectedPhaseKey] }}>
                                Viewing {selectedPhaseKey} phase — all charts below show only this window.
                            </p>
                        )}
                    </section>
                );
            })()}

            {/* ── Flight Track Map (Task 13) ──────────────────────────────────────── */}
            {latParam && lonParam && mapTrackPoints.length > 0 && (
                <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-gray-900">Flight Track</h2>
                        <button
                            type="button"
                            onClick={() => setMapTrackOpen((v) => !v)}
                            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition"
                        >
                            {mapTrackOpen ? "Hide ▲" : "Show ▼"}
                        </button>
                    </div>
                    {mapTrackOpen && (
                        <div className="space-y-3">
                            <div
                                className="overflow-hidden rounded-lg border border-gray-200"
                                style={{ height: 300 }}
                            >
                                {mapBounds && (
                                    <MapContainer
                                        bounds={mapBounds}
                                        boundsOptions={{ padding: [20, 20] }}
                                        style={{ height: "100%", width: "100%" }}
                                        scrollWheelZoom={false}
                                    >
                                        <TileLayer
                                            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                        />
                                        {mapPhasePolylines.map((seg, i) => (
                                            <Polyline
                                                key={i}
                                                positions={seg.points}
                                                pathOptions={{
                                                    color: PHASE_COLORS[seg.phase] || "#94a3b8",
                                                    weight: 3,
                                                    opacity: 0.85,
                                                }}
                                            />
                                        ))}
                                        {/* Departure — green */}
                                        <CircleMarker
                                            center={[mapTrackPoints[0].lat, mapTrackPoints[0].lon]}
                                            radius={6}
                                            pathOptions={{ color: "#15803d", fillColor: "#22c55e", fillOpacity: 1 }}
                                        />
                                        {/* Arrival — red */}
                                        <CircleMarker
                                            center={[
                                                mapTrackPoints[mapTrackPoints.length - 1].lat,
                                                mapTrackPoints[mapTrackPoints.length - 1].lon,
                                            ]}
                                            radius={6}
                                            pathOptions={{ color: "#b91c1c", fillColor: "#ef4444", fillOpacity: 1 }}
                                        />
                                        {/* Scrubber position — amber */}
                                        {mapScrubPosition && (
                                            <CircleMarker
                                                center={[mapScrubPosition.lat, mapScrubPosition.lon]}
                                                radius={9}
                                                pathOptions={{ color: "#d97706", fillColor: "#f59e0b", fillOpacity: 0.9 }}
                                            />
                                        )}
                                    </MapContainer>
                                )}
                            </div>
                            {timeDomain && (
                                <div className="space-y-1">
                                    <input
                                        type="range"
                                        min={timeDomain.min}
                                        max={timeDomain.max}
                                        step={Math.max(1, (timeDomain.max - timeDomain.min) / 500)}
                                        value={mapScrubTime ?? timeDomain.min}
                                        onChange={(e) => setMapScrubTime(Number(e.target.value))}
                                        className="w-full accent-amber-500"
                                    />
                                    <p className="text-center text-[11px] text-gray-500">
                                        {mapScrubTime !== null
                                            ? formatSessionTime(mapScrubTime)
                                            : "Drag to scrub position along track"}
                                    </p>
                                </div>
                            )}
                            <div className="flex flex-wrap gap-4 text-[11px] text-gray-500">
                                <span className="flex items-center gap-1.5">
                                    <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                                    Departure
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                                    Arrival
                                </span>
                                {mapScrubPosition && (
                                    <span className="flex items-center gap-1.5">
                                        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                                        {formatSessionTime(mapScrubPosition.time)}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </section>
            )}

            {/* ── Occurrence info strip (Task 8) ────────────────────────────────── */}
            {occurrenceWindow?.start != null && occurrenceWindow?.end != null ? (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm shadow-sm">
                    <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500" />
                    <span className="font-semibold text-amber-900">Occurrence window</span>
                    {occurrenceWindow.label && (
                        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            {occurrenceWindow.label}
                        </span>
                    )}
                    <span className="text-amber-800">
                        {formatSessionTime(occurrenceWindow.start)}
                        {" → "}
                        {formatSessionTime(occurrenceWindow.end)}
                        {" "}
                        <span className="text-amber-600">
                            ({formatPhaseDuration(occurrenceWindow.end - occurrenceWindow.start)})
                        </span>
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            setOccurrenceWindow(null);
                            saveFdrOccurrence(caseNumber, { start: null, end: null, label: null }).catch(() => {});
                        }}
                        className="ml-auto text-xs text-amber-700 underline hover:text-amber-900"
                    >
                        Clear
                    </button>
                </div>
            ) : (
                <p className="text-xs text-gray-400">
                    Drag on any chart below to mark an occurrence window.
                </p>
            )}

            {/* ── Parameter Correlation View (Task 12) ───────────────────────────── */}
            {(() => {
                // Build grouped selector options — only params present in availableParameters.
                const configGroups = fdrParameterConfig
                    .map((cat) => ({
                        ...cat,
                        available: cat.params.filter((p) => availableParameters.includes(p.id)),
                    }))
                    .filter((cat) => cat.available.length > 0);

                const knownIds = new Set(fdrParameterConfig.flatMap((c) => c.params.map((p) => p.id)));
                const otherParams = availableParameters.filter((p) => !knownIds.has(p));

                const searchLower = correlationSearch.trim().toLowerCase();
                const filterGroup = (params) =>
                    searchLower
                        ? params.filter(
                              (p) =>
                                  p.id.toLowerCase().includes(searchLower) ||
                                  (p.label || "").toLowerCase().includes(searchLower)
                          )
                        : params;

                const MAX_PARAMS = 8;
                const atCap = correlationParams.length >= MAX_PARAMS;

                const toggleParam = (id) => {
                    setCorrelationParams((prev) => {
                        if (prev.includes(id)) return prev.filter((x) => x !== id);
                        if (prev.length >= MAX_PARAMS) return prev;
                        return [...prev, id];
                    });
                };

                return (
                    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                        {/* Task 14 — case description suggestion banner */}
                        {suggestedCorrelationParams?.matched && !suggestionDismissed && (
                            <div className="flex items-start gap-3 rounded-t-xl border-b border-blue-200 bg-blue-50 px-4 py-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="text-xs font-semibold text-blue-800">
                                            Parameters suggested from case description
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => setWhyExpanded((v) => !v)}
                                            className="text-[11px] text-blue-500 underline hover:text-blue-700"
                                        >
                                            {whyExpanded ? "Hide ▲" : "Why these? ▼"}
                                        </button>
                                    </div>
                                    {whyExpanded && (
                                        <p className="mt-0.5 text-[11px] text-blue-600">
                                            Matched: {suggestedCorrelationParams.matchedKeywords.join(" · ")}
                                        </p>
                                    )}
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                        {suggestedCorrelationParams.params.map((p) => (
                                            <span
                                                key={p}
                                                className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-800"
                                            >
                                                {parameterDisplayMap[p]?.label || p}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSuggestionDismissed(true)}
                                    aria-label="Dismiss suggestion"
                                    className="shrink-0 text-blue-400 hover:text-blue-600 text-lg leading-none mt-0.5"
                                >
                                    ×
                                </button>
                            </div>
                        )}
                        {suggestedCorrelationParams !== null && !suggestedCorrelationParams.matched && (
                            <p className="rounded-t-xl border-b border-gray-100 bg-gray-50 px-4 py-2 text-[11px] text-gray-400">
                                No parameter suggestions for this case description — showing default selection (IAS, Pitch, Roll, Vertical Speed)
                            </p>
                        )}
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                            <div>
                                <h2 className="text-base font-semibold text-gray-900">
                                    Parameter Correlation View
                                </h2>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Compare up to {MAX_PARAMS} parameters on a shared timeline. Values are normalized per-parameter.
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                {correlationParams.length > 0 && (
                                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                                        {correlationParams.length} selected
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setCorrelationSelectorOpen((v) => !v)}
                                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition"
                                >
                                    {correlationSelectorOpen ? "Hide selector ▲" : "Edit selection ▼"}
                                </button>
                            </div>
                        </div>

                        {/* Collapsible selector */}
                        {correlationSelectorOpen && (
                            <div className="border-b border-gray-100 px-5 py-4 space-y-3">
                                <input
                                    type="text"
                                    value={correlationSearch}
                                    onChange={(e) => setCorrelationSearch(e.target.value)}
                                    placeholder="Search parameters…"
                                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                />
                                {atCap && (
                                    <p className="text-xs text-amber-700 font-medium">
                                        Maximum {MAX_PARAMS} parameters selected. Deselect one to add another.
                                    </p>
                                )}
                                <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                                    {configGroups.map((cat) => {
                                        const visible = filterGroup(cat.available);
                                        if (visible.length === 0) return null;
                                        return (
                                            <div key={cat.key}>
                                                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                                                    {cat.name}
                                                </p>
                                                <div className="flex flex-wrap gap-2">
                                                    {visible.map((p) => {
                                                        const checked = correlationParams.includes(p.id);
                                                        const meta = parameterDisplayMap[p.id];
                                                        const color = meta?.color ?? colorPalette[0];
                                                        return (
                                                            <button
                                                                key={p.id}
                                                                type="button"
                                                                onClick={() => toggleParam(p.id)}
                                                                disabled={!checked && atCap}
                                                                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                                                                    checked
                                                                        ? "border-transparent text-white"
                                                                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                                                } ${!checked && atCap ? "opacity-40 cursor-not-allowed" : ""}`}
                                                                style={checked ? { backgroundColor: color, borderColor: color } : {}}
                                                            >
                                                                {checked && (
                                                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-white opacity-80" />
                                                                )}
                                                                {p.label || p.id}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {otherParams.length > 0 && (() => {
                                        const visible = filterGroup(
                                            otherParams.map((id) => ({ id, label: id }))
                                        );
                                        if (visible.length === 0) return null;
                                        return (
                                            <div key="other">
                                                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                                                    Other
                                                </p>
                                                <div className="flex flex-wrap gap-2">
                                                    {visible.map((p) => {
                                                        const checked = correlationParams.includes(p.id);
                                                        const meta = parameterDisplayMap[p.id];
                                                        const color = meta?.color ?? colorPalette[0];
                                                        return (
                                                            <button
                                                                key={p.id}
                                                                type="button"
                                                                onClick={() => toggleParam(p.id)}
                                                                disabled={!checked && atCap}
                                                                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                                                                    checked
                                                                        ? "border-transparent text-white"
                                                                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                                                } ${!checked && atCap ? "opacity-40 cursor-not-allowed" : ""}`}
                                                                style={checked ? { backgroundColor: color, borderColor: color } : {}}
                                                            >
                                                                {checked && (
                                                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-white opacity-80" />
                                                                )}
                                                                {p.label || p.id}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                                {correlationParams.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setCorrelationParams([])}
                                        className="text-xs text-gray-400 underline hover:text-gray-600"
                                    >
                                        Clear all
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Chart */}
                        <div className="px-5 py-4">
                            {correlationParams.length === 0 ? (
                                <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500">
                                    Select at least one parameter above to view the correlation chart.
                                </div>
                            ) : correlationChartData.length === 0 ? (
                                <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500">
                                    No data available for the selected parameters.
                                </div>
                            ) : (
                                <div className="h-96">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart
                                            data={correlationChartData}
                                            margin={{ top: 12, right: 24, left: 0, bottom: 24 }}
                                            onMouseDown={handleChartMouseDown}
                                            onMouseMove={handleChartMouseMove}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                            <XAxis
                                                dataKey="time"
                                                stroke="#94a3b8"
                                                minTickGap={20}
                                                tickFormatter={formatFlightTime}
                                                label={{
                                                    value: timeAxisLabel,
                                                    position: "insideBottom",
                                                    offset: -12,
                                                    fill: "#94a3b8",
                                                    fontSize: 11,
                                                }}
                                            />
                                            <YAxis
                                                stroke="#94a3b8"
                                                domain={[0, 1]}
                                                tickFormatter={(v) => v.toFixed(1)}
                                                label={{
                                                    value: "Normalized (0–1)",
                                                    angle: -90,
                                                    position: "insideLeft",
                                                    offset: 10,
                                                    fill: "#94a3b8",
                                                    fontSize: 10,
                                                }}
                                            />
                                            <Tooltip
                                                cursor={{ stroke: "#cbd5e1" }}
                                                content={({ active, payload, label }) => {
                                                    if (!active || !payload || payload.length === 0) return null;
                                                    return (
                                                        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
                                                            <p className="mb-1.5 font-semibold text-gray-600">
                                                                {timeAxisLabel}: {formatFlightTime(label)}
                                                            </p>
                                                            {payload
                                                                .filter((entry) => !String(entry.dataKey).endsWith("__raw"))
                                                                .map((entry) => {
                                                                    const rawVal = entry.payload?.[entry.dataKey + "__raw"];
                                                                    const meta = parameterDisplayMap[entry.dataKey] || { label: entry.dataKey, unit: "" };
                                                                    const displayVal =
                                                                        typeof rawVal === "number"
                                                                            ? `${rawVal.toFixed(2)}${meta.unit ? " " + meta.unit : ""}`
                                                                            : "—";
                                                                    return (
                                                                        <div key={entry.dataKey} className="flex items-center gap-2 py-0.5">
                                                                            <span
                                                                                className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                                                                                style={{ backgroundColor: entry.stroke }}
                                                                            />
                                                                            <span className="text-gray-700 font-medium">{meta.label || entry.dataKey}</span>
                                                                            <span className="ml-auto pl-4 font-mono text-gray-900">{displayVal}</span>
                                                                        </div>
                                                                    );
                                                                })}
                                                        </div>
                                                    );
                                                }}
                                            />
                                            <Legend
                                                verticalAlign="bottom"
                                                height={36}
                                                formatter={(value) => {
                                                    const meta = parameterDisplayMap[value];
                                                    return meta?.label || value;
                                                }}
                                            />
                                            {/* Phase bands */}
                                            {groupedPhases.map((p) => (
                                                <ReferenceArea
                                                    key={p.phase}
                                                    x1={p.start_time}
                                                    x2={p.end_time}
                                                    fill={PHASE_COLORS[p.phase] || "#94a3b8"}
                                                    fillOpacity={
                                                        p.phase === "TAKEOFF" || p.phase === "LANDING" ? 0.12 : 0.08
                                                    }
                                                    ifOverflow="hidden"
                                                />
                                            ))}
                                            {/* Drag preview band */}
                                            {isDragging && dragStartTime !== null && dragCurrentTime !== null && (
                                                <ReferenceArea
                                                    x1={Math.min(dragStartTime, dragCurrentTime)}
                                                    x2={Math.max(dragStartTime, dragCurrentTime)}
                                                    fill="#f59e0b"
                                                    fillOpacity={0.10}
                                                    stroke="#fbbf24"
                                                    strokeDasharray="3 2"
                                                    ifOverflow="hidden"
                                                />
                                            )}
                                            {/* Saved occurrence band */}
                                            {occurrenceWindow?.start != null && occurrenceWindow?.end != null && (
                                                <ReferenceArea
                                                    x1={occurrenceWindow.start}
                                                    x2={occurrenceWindow.end}
                                                    fill="#f59e0b"
                                                    fillOpacity={0.22}
                                                    stroke="#d97706"
                                                    strokeWidth={1}
                                                    ifOverflow="hidden"
                                                />
                                            )}
                                            {occurrenceWindow?.start != null && occurrenceWindow?.end != null && (
                                                <ReferenceLine
                                                    x={(occurrenceWindow.start + occurrenceWindow.end) / 2}
                                                    stroke="#92400e"
                                                    strokeDasharray="4 3"
                                                    strokeWidth={1.5}
                                                    label={{
                                                        value: occurrenceWindow.label
                                                            ? `Occurrence · ${occurrenceWindow.label}`
                                                            : "Occurrence",
                                                        position: "insideTopRight",
                                                        fill: "#92400e",
                                                        fontSize: 10,
                                                        fontWeight: 600,
                                                    }}
                                                />
                                            )}
                                            {/* One line per selected param */}
                                            {correlationParams.map((p) => {
                                                const meta = parameterDisplayMap[p] || { label: p, color: colorPalette[0] };
                                                return (
                                                    <Line
                                                        key={p}
                                                        type="monotone"
                                                        dataKey={p}
                                                        name={p}
                                                        stroke={meta.color}
                                                        strokeWidth={1.5}
                                                        dot={false}
                                                        connectNulls
                                                        isAnimationActive={false}
                                                    />
                                                );
                                            })}
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            )}
                        </div>
                    </section>
                );
            })()}

            <section
                ref={chartsRef}
                className={`bg-white rounded-xl p-6 space-y-6 ${
                    selectedPhaseKey
                        ? "border-2"
                        : selectedFlightIndex !== null
                        ? "border-2 border-amber-400"
                        : "border border-gray-200"
                }`}
                style={selectedPhaseKey ? { borderColor: PHASE_COLORS[selectedPhaseKey] } : {}}
            >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">
                            Flight Parameter Overview
                            {selectedPhaseKey && (
                                <span
                                    className="ml-2 rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                                    style={{ backgroundColor: PHASE_COLORS[selectedPhaseKey] }}
                                >
                                    {selectedPhaseKey} phase
                                </span>
                            )}
                            {!selectedPhaseKey && selectedFlightIndex !== null && (
                                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                                    Flight {selectedFlightIndex} only
                                </span>
                            )}
                        </h2>
                        <p className="text-sm text-gray-500">
                            Time series visualization of recorder values for each parameter.
                        </p>
                    </div>
                    <div className="w-full sm:w-64">
                        <label className="text-xs font-semibold text-gray-500" htmlFor="chart-filter">
                            Filter charts by parameter name
                        </label>
                        <input
                            id="chart-filter"
                            type="text"
                            value={chartFilterText}
                            onChange={(event) => setChartFilterText(event.target.value)}
                            placeholder="Search parameters..."
                            className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                        />
                    </div>
                </div>

                {groupedParameters.length > 0 ? (
                    groupedParameters.map((group) => {
                        const isExpanded = expandedGroups.has(group.key);
                        const visibleParameters = isExpanded
                            ? group.parameters
                            : group.parameters.slice(0, defaultVisibleChartsPerGroup);
                        const canToggle = group.parameters.length > defaultVisibleChartsPerGroup;

                        return (
                            <div key={group.key} className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-800">
                                            {group.title}
                                        </h3>
                                        <p className="text-xs text-gray-500">
                                            {group.parameters.length} parameters
                                        </p>
                                    </div>
                                    {canToggle && (
                                        <button
                                            type="button"
                                            onClick={() => handleToggleGroup(group.key)}
                                            className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                                        >
                                            {isExpanded ? "Show less" : "Show more"}
                                        </button>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                    {visibleParameters.map((parameter) =>
                                        renderParameterCard(parameter)
                                    )}
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
                        No parameters match your filter.
                    </div>
                )}
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">Parameter Table</h2>
                        <p className="text-sm text-gray-500">
                            Summary of key flight parameters captured in the recorder.
                        </p>
                    </div>
                    <span className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-100 rounded-full">
                        {filteredParameterTableRows.length} parameters
                    </span>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="text-left px-4 py-3">Parameter</th>
                                <th className="text-left px-4 py-3">Unit</th>
                                <th className="text-right px-4 py-3">Minimum</th>
                                <th className="text-right px-4 py-3">Maximum</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {filteredParameterTableRows.map((row) => (
                                <tr key={row.parameter} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium text-gray-800">{row.parameter}</td>
                                    <td className="px-4 py-3 text-gray-500">{row.unit}</td>
                                    <td className="px-4 py-3 text-right text-gray-700">{row.min}</td>
                                    <td className="px-4 py-3 text-right text-gray-700">{row.max}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
