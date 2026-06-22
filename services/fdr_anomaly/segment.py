"""
GA-adaptive flight segmentation for Garmin G1000 / general aviation CSV data.
No WOW (Weight on Wheels) sensor assumed.

Parameter-adaptive priority order:
  1. Indicated Airspeed > 50 kts   → badge: 'ias'         (green, most reliable)
  2. GPS/Pressure Altitude above ground estimate → badge: 'altitude'  (amber)
  3. Ground Speed > 40 kts fallback  → badge: 'groundspeed' (gray, only if no IAS)

Gap merging uses 120 s to handle touch-and-go practice circuits.
"""

from __future__ import annotations

import json
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

# ── Thresholds ─────────────────────────────────────────────────────────────────
IAS_AIRBORNE_KNOTS = 50.0
GS_AIRBORNE_KNOTS = 40.0
ALT_AIRBORNE_MARGIN_FT = 150.0
MIN_FLIGHT_DURATION_S = 60.0
FLIGHT_GAP_THRESHOLD_S = 120.0   # 120 s handles touch-and-go circuits
GROUND_REF_WINDOW_S = 120.0      # first 2 min used to estimate ground elevation

# ── Column name candidates: GA/Garmin G1000 names first, NASA fallbacks last ──
IAS_CANDIDATES: List[str] = [
    "Indicated Airspeed (knots)", "Indicated Airspeed", "IAS", "CAS", "CASM",
]
ALT_CANDIDATES: List[str] = [
    "GPS Altitude (feet)", "Pressure Altitude (ft)",
    "Altitude (ft)", "Altitude", "ALT", "RALT",
]
GS_CANDIDATES: List[str] = [
    "Ground Speed (knots)", "Ground Speed", "GS",
]
LAT_CANDIDATES: List[str] = [
    "Latitude (deg)", "Latitude", "LATP",
]
LON_CANDIDATES: List[str] = [
    "Longitude (deg)", "Longitude", "LONP",
]

# ── Detection badge tiers ──────────────────────────────────────────────────────
BADGE_IAS = "ias"            # green  — most reliable
BADGE_ALT = "altitude"       # amber  — good but indirect
BADGE_GS = "groundspeed"     # gray   — fallback only


# ── Helpers ────────────────────────────────────────────────────────────────────

def _find_col(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    """Return the first candidate column present in df, or None."""
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


def _safe_float(value: object) -> Optional[float]:
    try:
        f = float(value)  # type: ignore[arg-type]
        return round(f, 6) if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ── Core algorithm ─────────────────────────────────────────────────────────────

def _group_airborne(timestamps: np.ndarray, airborne: np.ndarray) -> List[Dict]:
    """
    Group contiguous True runs in airborne mask.
    Merges gaps ≤ FLIGHT_GAP_THRESHOLD_S (handles touch-and-go).
    Drops segments shorter than MIN_FLIGHT_DURATION_S.
    Returns raw segment dicts with internal index keys.
    """
    n = len(timestamps)
    segments: List[Dict] = []
    i = 0

    while i < n:
        if airborne[i]:
            start = i
            while i < n and airborne[i]:
                i += 1
            end = i - 1
            duration = float(timestamps[end] - timestamps[start])

            if duration < MIN_FLIGHT_DURATION_S:
                # Too short — ground blip, skip
                continue

            if segments:
                gap = float(timestamps[start] - timestamps[segments[-1]["_end_idx"]])
                if gap <= FLIGHT_GAP_THRESHOLD_S:
                    # Merge: touch-and-go or brief ground contact
                    segments[-1]["_end_idx"] = end
                    segments[-1]["end_time"] = float(timestamps[end])
                    continue

            segments.append({
                "_start_idx": start,
                "_end_idx": end,
                "start_time": float(timestamps[start]),
                "end_time": float(timestamps[end]),
            })
        else:
            i += 1

    return segments


def _detect_from_df(df: pd.DataFrame) -> Dict:
    """
    Core flight segmentation.  Expects a DataFrame that already has
    a 'Session Time' column (use normalize_dataframe first).
    """
    timestamps = _parse_session_time(df["Session Time"])
    n = len(timestamps)

    if n == 0:
        return {
            "segments": [],
            "detection_method": "No data rows found",
            "detection_badge": BADGE_GS,
            "n_rows": 0,
        }

    airborne = np.zeros(n, dtype=bool)
    methods: List[str] = []
    badge = BADGE_GS  # lowest confidence default

    # ── Priority 1: Indicated Airspeed ────────────────────────────────────────
    ias_col = _find_col(df, IAS_CANDIDATES)
    if ias_col:
        ias = _to_numeric(df[ias_col])
        airborne |= np.isfinite(ias) & (ias > IAS_AIRBORNE_KNOTS)
        methods.append(f"{ias_col} > {IAS_AIRBORNE_KNOTS:.0f} kts")
        badge = BADGE_IAS

    # ── Priority 2: Altitude above estimated ground elevation ─────────────────
    alt_col = _find_col(df, ALT_CANDIDATES)
    if alt_col:
        alt = _to_numeric(df[alt_col])
        ref_mask = timestamps <= (timestamps[0] + GROUND_REF_WINDOW_S)
        valid_ref = alt[ref_mask & np.isfinite(alt)]
        ground_alt = float(np.nanmedian(valid_ref)) if valid_ref.size > 0 else np.nan
        if np.isfinite(ground_alt):
            airborne |= np.isfinite(alt) & (alt > ground_alt + ALT_AIRBORNE_MARGIN_FT)
            methods.append(f"{alt_col} > ground + {ALT_AIRBORNE_MARGIN_FT:.0f} ft")
            if badge != BADGE_IAS:
                badge = BADGE_ALT

    # ── Priority 3: Ground speed (only when IAS is unavailable) ──────────────
    if not ias_col:
        gs_col = _find_col(df, GS_CANDIDATES)
        if gs_col:
            gs = _to_numeric(df[gs_col])
            airborne |= np.isfinite(gs) & (gs > GS_AIRBORNE_KNOTS)
            methods.append(f"{gs_col} > {GS_AIRBORNE_KNOTS:.0f} kts")
            # badge stays BADGE_GS

    if not methods:
        return {
            "segments": [],
            "detection_method": "No airborne indicator found (IAS / altitude / ground speed missing)",
            "detection_badge": BADGE_GS,
            "n_rows": n,
        }

    raw_segs = _group_airborne(timestamps, airborne)

    # ── Enrich each segment with summary statistics ───────────────────────────
    ias_arr = _to_numeric(df[ias_col]) if ias_col else None
    alt_arr = _to_numeric(df[alt_col]) if alt_col else None
    lat_col = _find_col(df, LAT_CANDIDATES)
    lon_col = _find_col(df, LON_CANDIDATES)
    lat_arr = _to_numeric(df[lat_col]) if lat_col else None
    lon_arr = _to_numeric(df[lon_col]) if lon_col else None

    enriched: List[Dict] = []
    for fi, seg in enumerate(raw_segs):
        si: int = seg["_start_idx"]
        ei: int = seg["_end_idx"]
        duration_s = seg["end_time"] - seg["start_time"]

        out: Dict = {
            "flight_index": fi + 1,
            "start_time": seg["start_time"],
            "end_time": seg["end_time"],
            "duration_s": round(duration_s, 1),
            "duration_min": round(duration_s / 60.0, 1),
        }

        if alt_arr is not None:
            vals = alt_arr[si : ei + 1]
            valid = vals[np.isfinite(vals)]
            out["max_altitude_ft"] = round(float(np.nanmax(valid)), 0) if valid.size else None

        if ias_arr is not None:
            vals = ias_arr[si : ei + 1]
            valid = vals[np.isfinite(vals)]
            out["avg_ias_knots"] = round(float(np.nanmean(valid)), 1) if valid.size else None

        if lat_arr is not None and lon_arr is not None:
            out["start_lat"] = _safe_float(lat_arr[si])
            out["start_lon"] = _safe_float(lon_arr[si])
            out["end_lat"] = _safe_float(lat_arr[ei])
            out["end_lon"] = _safe_float(lon_arr[ei])

        enriched.append(out)

    return {
        "segments": enriched,
        "detection_method": " + ".join(methods),
        "detection_badge": badge,
        "n_rows": n,
    }


# ── Public entry points ────────────────────────────────────────────────────────

def detect_flights(path: str) -> Dict:
    """Load a CSV or Excel FDR file and return flight segments."""
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415

    if path.lower().endswith((".xlsx", ".xls")):
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path, low_memory=False)
    df, _fmt = normalize_dataframe(df)
    return _detect_from_df(df)


def detect_flights_from_rows(rows: List[Dict]) -> Dict:
    """Accept a list of row dicts (e.g. from FastAPI) and return segments."""
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415

    df = pd.DataFrame(rows)
    df, _fmt = normalize_dataframe(df)
    return _detect_from_df(df)


def detect_to_json(path: str) -> str:
    return json.dumps(detect_flights(path), indent=2)
