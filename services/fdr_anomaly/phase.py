"""
GA-adaptive flight phase detection for Garmin G1000 / general aviation CSV data.

Phase assignment priority (highest wins):
  TAKEOFF  — first 60 s of flight AND alt < ground_alt + 200 ft
  LANDING  — last 60 s of flight AND alt < landing_ground_est + 200 ft
  CLIMB    — VS > +200 ft/min (smoothed, sustained)
  DESCENT  — VS < -200 ft/min (smoothed, sustained)
  CRUISE   — everything else (|VS| ≤ 200 ft/min)

Column candidates use GA/G1000 names first, then NASA/standard fallbacks.
"""

from __future__ import annotations

import json
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

# ── Phase labels ───────────────────────────────────────────────────────────────
PHASE_TAKEOFF = "TAKEOFF"
PHASE_CLIMB = "CLIMB"
PHASE_CRUISE = "CRUISE"
PHASE_DESCENT = "DESCENT"
PHASE_LANDING = "LANDING"

# ── Thresholds ─────────────────────────────────────────────────────────────────
CLIMB_VS_THRESHOLD: float = 200.0     # ft/min — above this → CLIMB
DESCENT_VS_THRESHOLD: float = -200.0  # ft/min — below this → DESCENT
TAKEOFF_WINDOW_S: float = 60.0        # first N seconds of flight
LANDING_WINDOW_S: float = 60.0        # last N seconds of flight
ALT_BOUNDARY_FT: float = 200.0        # ft above ground ref for T/O and LDG
MIN_PHASE_DURATION_S: float = 10.0    # phase runs shorter than this are absorbed
GROUND_REF_WINDOW_S: float = 30.0     # seconds used to estimate ground altitude

# ── Detection badge tiers ──────────────────────────────────────────────────────
BADGE_VS_IAS = "vs_ias"       # green  — VS + IAS both available
BADGE_VS_ONLY = "vs_only"     # amber  — VS available, IAS missing
BADGE_ALT_ONLY = "alt_only"   # gray   — altitude-derived rate only

# ── Column name candidates (GA/G1000 names first, NASA/standard fallbacks) ────
VS_CANDIDATES: List[str] = [
    "Vertical Speed (ft/min)", "Vertical Speed", "VS", "VSPD", "VVI",
    "IVV",  # NASA DFDAU: inertial vertical velocity (ft/min)
]
IAS_CANDIDATES: List[str] = [
    "Indicated Airspeed (knots)", "Indicated Airspeed", "IAS", "CAS", "CASM",
]
ALT_CANDIDATES: List[str] = [
    "GPS Altitude (feet)", "Pressure Altitude (ft)",
    "Altitude (ft)", "Altitude", "ALT", "RALT",
]


# ── Helpers ────────────────────────────────────────────────────────────────────

def _find_col(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    """Return first matching column present in df, or None."""
    for name in candidates:
        if name in df.columns:
            return name
    return None


def _to_numeric(series: pd.Series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)


def _parse_session_time(series: pd.Series) -> np.ndarray:
    if pd.api.types.is_numeric_dtype(series):
        return pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)

    as_timedelta = pd.to_timedelta(series, errors="coerce")
    if not as_timedelta.isna().all():
        return as_timedelta.dt.total_seconds().to_numpy(dtype=float)

    as_datetime = pd.to_datetime(series, errors="coerce")
    if not as_datetime.isna().all():
        base = as_datetime.iloc[0]
        return (as_datetime - base).dt.total_seconds().to_numpy(dtype=float)

    raise ValueError("Unable to parse 'Session Time' column to numeric seconds.")


# ── Phase labeling ─────────────────────────────────────────────────────────────

def _smooth_phases(timestamps: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """
    Absorb runs shorter than MIN_PHASE_DURATION_S into the adjacent phase.
    Iterates until stable — handles chain reactions where merging one run
    makes another too short.
    """
    n = len(labels)
    if n == 0:
        return labels
    result = labels.copy()

    for _ in range(100):  # generous limit; converges in < 10 passes for real data
        # Build current run list
        runs: List[tuple] = []  # (phase, start_idx, end_idx)
        i = 0
        while i < n:
            j = i
            while j < n and result[j] == result[i]:
                j += 1
            runs.append((result[i], i, j - 1))
            i = j

        changed = False
        # Process ALL short runs in one pass — no early break.
        # Updating runs[ri] in-place lets subsequent entries in this pass see
        # the already-absorbed phase and merge into it instead of the stale one.
        for ri, (phase, si, ei) in enumerate(runs):
            dur = float(timestamps[ei] - timestamps[si]) if ei > si else 0.0
            if dur < MIN_PHASE_DURATION_S:
                if ri > 0:
                    absorb = runs[ri - 1][0]
                elif ri + 1 < len(runs):
                    absorb = runs[ri + 1][0]
                else:
                    continue
                result[si : ei + 1] = absorb
                runs[ri] = (absorb, si, ei)  # update local view for this pass
                changed = True

        if not changed:
            break

    return result


def _label_phases(
    timestamps: np.ndarray,
    vs_arr: Optional[np.ndarray],
    ias_arr: Optional[np.ndarray],  # reserved for future IAS-cruise confirmation
    alt_arr: Optional[np.ndarray],
) -> np.ndarray:
    """Assign a phase label to every row."""
    n = len(timestamps)
    labels = np.full(n, PHASE_CRUISE, dtype=object)

    # ── Step 1: VS-based assignment ───────────────────────────────────────────
    if vs_arr is not None:
        climb_mask = np.isfinite(vs_arr) & (vs_arr > CLIMB_VS_THRESHOLD)
        descent_mask = np.isfinite(vs_arr) & (vs_arr < DESCENT_VS_THRESHOLD)
        labels[climb_mask] = PHASE_CLIMB
        labels[descent_mask] = PHASE_DESCENT
    elif alt_arr is not None:
        # No VS sensor: derive approximate rate from altitude gradient (ft/s → ft/min)
        safe_ts = np.where(np.isfinite(timestamps), timestamps, np.arange(n, dtype=float))
        safe_alt = np.where(np.isfinite(alt_arr), alt_arr, np.nan)
        alt_rate = np.gradient(safe_alt, safe_ts) * 60.0
        labels[np.isfinite(alt_rate) & (alt_rate > CLIMB_VS_THRESHOLD)] = PHASE_CLIMB
        labels[np.isfinite(alt_rate) & (alt_rate < DESCENT_VS_THRESHOLD)] = PHASE_DESCENT

    # ── Step 2: Smooth transient spikes (<10 s runs) ─────────────────────────
    labels = _smooth_phases(timestamps, labels)

    # ── Step 3: Ground altitude reference ────────────────────────────────────
    flight_start = float(timestamps[0])
    flight_end = float(timestamps[-1])
    ground_alt: float = np.nan

    if alt_arr is not None:
        ref_mask = timestamps <= (flight_start + GROUND_REF_WINDOW_S)
        valid_ref = alt_arr[ref_mask & np.isfinite(alt_arr)]
        if valid_ref.size > 0:
            ground_alt = float(np.nanmedian(valid_ref))

    # ── Step 4: TAKEOFF override ──────────────────────────────────────────────
    if np.isfinite(ground_alt) and alt_arr is not None:
        to_time = timestamps <= (flight_start + TAKEOFF_WINDOW_S)
        to_alt = np.isfinite(alt_arr) & (alt_arr < ground_alt + ALT_BOUNDARY_FT)
        labels[to_time & to_alt] = PHASE_TAKEOFF
    else:
        # Time-only fallback when altitude unavailable
        labels[timestamps <= (flight_start + TAKEOFF_WINDOW_S)] = PHASE_TAKEOFF

    # ── Step 5: LANDING override ──────────────────────────────────────────────
    if alt_arr is not None:
        ldg_ref_mask = timestamps >= (flight_end - GROUND_REF_WINDOW_S)
        valid_ldg = alt_arr[ldg_ref_mask & np.isfinite(alt_arr)]
        landing_alt = float(np.nanmedian(valid_ldg)) if valid_ldg.size > 0 else ground_alt
    else:
        landing_alt = ground_alt

    if np.isfinite(landing_alt) and alt_arr is not None:
        ldg_time = timestamps >= (flight_end - LANDING_WINDOW_S)
        ldg_alt = np.isfinite(alt_arr) & (alt_arr < landing_alt + ALT_BOUNDARY_FT)
        labels[ldg_time & ldg_alt] = PHASE_LANDING
    else:
        labels[timestamps >= (flight_end - LANDING_WINDOW_S)] = PHASE_LANDING

    return labels


def _group_phases(timestamps: np.ndarray, labels: np.ndarray) -> List[Dict]:
    """Group consecutive same-label rows into phase segment dicts."""
    n = len(labels)
    phases: List[Dict] = []
    i = 0
    while i < n:
        j = i
        while j < n and labels[j] == labels[i]:
            j += 1
        start_t = float(timestamps[i])
        end_t = float(timestamps[j - 1])
        phases.append({
            "phase": str(labels[i]),
            "start_time": round(start_t, 3),
            "end_time": round(end_t, 3),
            "duration_s": round(end_t - start_t, 1),
        })
        i = j
    return phases


# ── Core detection ─────────────────────────────────────────────────────────────

def _detect_from_df(df: pd.DataFrame) -> Dict:
    """Expects a DataFrame that already has a 'Session Time' column."""
    timestamps = _parse_session_time(df["Session Time"])
    n = len(timestamps)

    if n == 0:
        return {
            "phases": [],
            "detection_method": "No data rows found",
            "detection_badge": BADGE_ALT_ONLY,
            "n_rows": 0,
        }

    vs_col = _find_col(df, VS_CANDIDATES)
    ias_col = _find_col(df, IAS_CANDIDATES)
    alt_col = _find_col(df, ALT_CANDIDATES)

    vs_arr = _to_numeric(df[vs_col]) if vs_col else None
    ias_arr = _to_numeric(df[ias_col]) if ias_col else None
    alt_arr = _to_numeric(df[alt_col]) if alt_col else None

    method_parts: List[str] = []
    if vs_col:
        method_parts.append(vs_col)
        badge = BADGE_VS_IAS if ias_col else BADGE_VS_ONLY
    else:
        badge = BADGE_ALT_ONLY

    if ias_col:
        method_parts.append(ias_col)
    if alt_col:
        method_parts.append(alt_col)

    if not method_parts:
        return {
            "phases": [],
            "detection_method": "No usable parameters (VS / IAS / altitude all missing)",
            "detection_badge": BADGE_ALT_ONLY,
            "n_rows": n,
        }

    labels = _label_phases(timestamps, vs_arr, ias_arr, alt_arr)
    phases = _group_phases(timestamps, labels)

    return {
        "phases": phases,
        "detection_method": " + ".join(method_parts),
        "detection_badge": badge,
        "n_rows": n,
    }


# ── Public entry points ────────────────────────────────────────────────────────

def detect_phases(path: str) -> Dict:
    """Load a CSV or Excel FDR file and return phase segments."""
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415

    if path.lower().endswith((".xlsx", ".xls")):
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path, low_memory=False)
    df, _fmt = normalize_dataframe(df)
    return _detect_from_df(df)


def detect_phases_from_rows(rows: List[Dict]) -> Dict:
    """Accept a list of row dicts (e.g. from FastAPI) and return phases."""
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415

    df = pd.DataFrame(rows)
    df, _fmt = normalize_dataframe(df)
    return _detect_from_df(df)


def detect_to_json(path: str) -> str:
    return json.dumps(detect_phases(path), indent=2)
