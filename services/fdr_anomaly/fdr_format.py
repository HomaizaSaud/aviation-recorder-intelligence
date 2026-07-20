"""
Shared FDR file format detection and normalization.

Supported formats:
  ga      — Garmin G1000 / general aviation CSV/Excel
              time: "Session Time" column (seconds or HH:MM:SS)
              alt:  "GPS Altitude (feet)" / "Pressure Altitude (ft)"
              IAS:  "Indicated Airspeed (knots)"
              VS:   "Vertical Speed (ft/min)"

  nasa    — NASA Digital FDR / DFDR export (mat → Excel via mat_to_excel.py)
              time: GMT_HOUR * 3600 + GMT_MINUTE * 60 + GMT_SEC (→ synthetic "Session Time")
              alt:  "ALT" / "RALT"
              IAS:  "CAS"
              VS:   "IVV"

  generic — anything else with a recognisable numeric time-like column
"""

from __future__ import annotations

import pandas as pd

_NASA_HOUR_COLS   = ("GMT_HOUR",)
_NASA_MIN_COLS    = ("GMT_MINUTE", "GMT_MIN")
_NASA_SEC_COLS    = ("GMT_SEC",)

# All column names that should be treated as time axes, not features
NASA_TIME_COLS = {"GMT_HOUR", "GMT_MINUTE", "GMT_MIN", "GMT_SEC"}


def detect_format(df: pd.DataFrame) -> str:
    cols = set(df.columns)
    if "Session Time" in cols:
        return "ga"
    if "GMT_HOUR" in cols:
        return "nasa"
    return "generic"


def _first_present(df: pd.DataFrame, candidates: tuple) -> str | None:
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _skip_units_row(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the first row if it contains no numeric values (e.g. units row from mat_to_excel)."""
    if len(df) == 0:
        return df
    any_numeric = pd.to_numeric(df.iloc[0], errors="coerce").notna().any()
    if not any_numeric:
        return df.iloc[1:].reset_index(drop=True)
    return df


def normalize_dataframe(df: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    """
    Ensure the DataFrame has a 'Session Time' column (elapsed seconds from start).
    Returns (normalized_df, format_name).

    Raises ValueError with a human-readable message if the format is unrecognised.
    """
    # Handle Excel files exported by mat_to_excel: Row 2 is a units row (all strings)
    df = _skip_units_row(df)

    fmt = detect_format(df)

    if fmt == "ga":
        return df, fmt

    if fmt == "nasa":
        hour_col = _first_present(df, _NASA_HOUR_COLS)
        min_col  = _first_present(df, _NASA_MIN_COLS)
        sec_col  = _first_present(df, _NASA_SEC_COLS)

        hour   = pd.to_numeric(df[hour_col], errors="coerce").fillna(0) if hour_col else 0
        minute = pd.to_numeric(df[min_col],  errors="coerce").fillna(0) if min_col  else 0
        second = pd.to_numeric(df[sec_col],  errors="coerce").fillna(0) if sec_col  else 0

        absolute_seconds = hour * 3600.0 + minute * 60.0 + second
        # Make relative to first sample so timestamps start near 0
        base = float(absolute_seconds.iloc[0]) if hasattr(absolute_seconds, "iloc") else float(absolute_seconds)
        elapsed = absolute_seconds - base

        df = df.copy()
        df["Session Time"] = pd.to_numeric(elapsed, errors="coerce").to_numpy(dtype=float)
        return df, fmt

    # Generic: search for any numeric column whose name suggests elapsed time
    time_hints = ("time", "sec", "elapsed", "t_", "frame", "sample")
    for col in df.columns:
        col_lower = col.lower()
        if any(hint in col_lower for hint in time_hints):
            numeric = pd.to_numeric(df[col], errors="coerce")
            if numeric.notna().sum() > 0:
                df = df.copy()
                df["Session Time"] = numeric.to_numpy(dtype=float)
                return df, "generic"

    raise ValueError(
        "Unrecognised FDR file format. Expected one of:\n"
        "  • GA/Garmin G1000: a 'Session Time' column\n"
        "  • NASA DFDAU export: a 'GMT_HOUR' column\n"
        "Found columns: " + ", ".join(list(df.columns)[:20])
    )
