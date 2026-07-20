"""
Rule-based anomaly detection for aviation FDR data.

Evaluates known flight safety limits against recorded parameters.
Findings share the same shape as AI-detected segments so the frontend
can merge and render them uniformly.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

RULE_GAP_SECONDS = 30.0  # merge consecutive violations within this gap

# ── Column candidates — GA/G1000 names first, NASA/standard fallbacks ─────────
IAS_CANDIDATES: List[str] = [
    "Indicated Airspeed (knots)", "Indicated Airspeed", "IAS", "CAS", "CASM",
]
ROLL_CANDIDATES: List[str] = [
    "Roll (deg)", "Roll", "ROLL", "PHI", "ROLLANGLE",
]
PITCH_CANDIDATES: List[str] = [
    "Pitch (deg)", "Pitch", "PITCH", "THETA", "PITCHANGLE",
]
VS_CANDIDATES: List[str] = [
    "Vertical Speed (ft/min)", "Vertical Speed", "VS", "VSPD", "VVI", "IVV",
]
ALT_CANDIDATES: List[str] = [
    "GPS Altitude (feet)", "Pressure Altitude (ft)",
    "Altitude (ft)", "Altitude", "ALT", "RALT",
]
RPM_CANDIDATES: List[str] = [
    "RPM L", "RPM R", "RPM", "Engine RPM", "Engine 1 RPM", "RPM Left", "ENG1_RPM", "RPM1",
]
OIL_PRESS_CANDIDATES: List[str] = [
    "Oil Pressure (PSI)", "Oil Pressure", "OIL_PRESS", "OIL_PSI", "OILP",
]
OIL_TEMP_CANDIDATES: List[str] = [
    "Oil Temp (deg C)", "Oil Temperature (C)", "Oil Temperature", "OIL_TEMP", "OILT", "OIL_TEMP_C",
]
EGT_CANDIDATES: List[str] = [
    "EGT (deg F)", "EGT (F)", "EGT", "EGT1", "EGT_1", "EGT1_DEG",
]

# ── Declarative rule definitions ───────────────────────────────────────────────
# direction: "below"    — violation when value < threshold
#            "above"    — violation when value > threshold
#            "abs_above"— violation when |value| > threshold
RULE_DEFS: List[Dict] = [
    {
        "rule_id": "ias_low_cruise",
        "rule_name": "Low Airspeed During Cruise",
        "candidates": IAS_CANDIDATES,
        "threshold": 60.0,
        "direction": "below",
        "phases": ["CRUISE"],
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "ias_high",
        "rule_name": "Airspeed Overspeed (Vne)",
        "candidates": IAS_CANDIDATES,
        "threshold": 150.0,
        "direction": "above",
        "phases": None,
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "excessive_roll_landing",
        "rule_name": "Excessive Roll During Landing/Takeoff",
        "candidates": ROLL_CANDIDATES,
        "threshold": 30.0,
        "direction": "abs_above",
        "phases": ["LANDING", "TAKEOFF"],
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "excessive_pitch_up",
        "rule_name": "Excessive Pitch Up",
        "candidates": PITCH_CANDIDATES,
        "threshold": 20.0,
        "direction": "above",
        "phases": None,
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "excessive_pitch_down",
        "rule_name": "Excessive Pitch Down",
        "candidates": PITCH_CANDIDATES,
        "threshold": -10.0,
        "direction": "below",
        "phases": None,
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "high_vs_descent",
        "rule_name": "High Descent Rate (Unstabilized Approach)",
        "candidates": VS_CANDIDATES,
        "threshold": -1500.0,
        "direction": "below",
        "phases": ["DESCENT"],
        "severity": "med",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "rpm_overspeed",
        "rule_name": "Engine RPM Overspeed",
        "candidates": RPM_CANDIDATES,
        "threshold": 2700.0,
        "direction": "above",
        "phases": None,
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "oil_pressure_low",
        "rule_name": "Low Oil Pressure",
        "candidates": OIL_PRESS_CANDIDATES,
        "threshold": 25.0,
        "direction": "below",
        "phases": None,
        "severity": "high",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "oil_temp_high",
        "rule_name": "High Oil Temperature",
        "candidates": OIL_TEMP_CANDIDATES,
        "threshold": 120.0,
        "direction": "above",
        "phases": None,
        "severity": "med",
        "deviation_type": "exceedance",
    },
    {
        "rule_id": "egt_high",
        "rule_name": "High Exhaust Gas Temperature",
        "candidates": EGT_CANDIDATES,
        "threshold": 1650.0,  # degrees F; 900 C ~= 1652 F
        "direction": "above",
        "phases": None,
        "severity": "med",
        "deviation_type": "exceedance",
    },
]


def _find_col(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    df_cols = list(df.columns)
    df_cols_lower = [c.lower() for c in df_cols]

    # Pass 1: case-sensitive exact match (fastest, highest fidelity)
    for name in candidates:
        if name in df.columns:
            return name

    # Pass 2: case-insensitive exact match
    for name in candidates:
        name_l = name.lower()
        for i, col_l in enumerate(df_cols_lower):
            if name_l == col_l:
                return df_cols[i]

    # Pass 3: candidate is a case-insensitive substring of the column name.
    # Allows short candidates like "roll" to match "Roll (deg)",
    # and "vertical speed" to match "Vertical Speed (ft/min)".
    for name in candidates:
        name_l = name.lower()
        for i, col_l in enumerate(df_cols_lower):
            if name_l in col_l:
                return df_cols[i]

    return None


def _to_numeric(series: pd.Series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)


def _skipped_entry(rule_def: Dict, candidates_shown: int = 3) -> Dict:
    shown = rule_def["candidates"][:candidates_shown]
    suffix = "…" if len(rule_def["candidates"]) > candidates_shown else ""
    return {
        "rule_id": rule_def["rule_id"],
        "rule_name": rule_def["rule_name"],
        "parameter": None,
        "threshold": rule_def["threshold"],
        "status": "skipped",
        "reason": (
            f"Required parameter not found in this recording "
            f"(looked for: {', '.join(shown)}{suffix})"
        ),
        "findings_count": 0,
    }


def _group_violations(
    timestamps: np.ndarray,
    mask: np.ndarray,
    values: np.ndarray,
    rule_id: str,
    rule_name: str,
    threshold: float,
    direction: str,
    severity: str,
    deviation_type: str,
    col: str,
    phase_labels: np.ndarray,
) -> List[Dict]:
    """Merge consecutive violating rows (gap <= RULE_GAP_SECONDS) into findings."""
    indices = np.where(mask)[0]
    if indices.size == 0:
        return []

    findings: List[Dict] = []
    seg_start = int(indices[0])
    seg_end = int(indices[0])

    def _flush(s: int, e: int) -> Dict:
        seg_vals = values[s : e + 1]
        if direction == "abs_above":
            peak = float(np.nanmax(np.abs(seg_vals)))
        elif direction == "above":
            peak = float(np.nanmax(seg_vals))
        else:
            peak = float(np.nanmin(seg_vals))

        mid = (timestamps[s] + timestamps[e]) / 2.0
        mid_idx = int(np.argmin(np.abs(timestamps - mid)))
        seg_phase = str(phase_labels[mid_idx]) if mid_idx < len(phase_labels) else "CRUISE"

        return {
            "rule_id": rule_id,
            "rule_name": rule_name,
            "severity": severity,
            "phase": seg_phase,
            "start_time": float(timestamps[s]),
            "end_time": float(timestamps[e]),
            "peak_value": round(peak, 3),
            "threshold": threshold,
            "parameter": col,
            "deviation_type": deviation_type,
        }

    for idx in indices[1:]:
        idx = int(idx)
        if timestamps[idx] - timestamps[seg_end] <= RULE_GAP_SECONDS:
            seg_end = idx
        else:
            findings.append(_flush(seg_start, seg_end))
            seg_start = idx
            seg_end = idx

    findings.append(_flush(seg_start, seg_end))
    return findings


def _apply_rule(
    df: pd.DataFrame,
    timestamps: np.ndarray,
    phase_labels: np.ndarray,
    rule_def: Dict,
) -> Tuple[List[Dict], Dict]:
    col = _find_col(df, rule_def["candidates"])

    if col is None:
        return [], _skipped_entry(rule_def)

    values = _to_numeric(df[col])
    direction = rule_def["direction"]

    if direction == "abs_above":
        mask = np.abs(values) > rule_def["threshold"]
    elif direction == "above":
        mask = values > rule_def["threshold"]
    else:
        mask = values < rule_def["threshold"]

    mask = np.where(np.isnan(values), False, mask)

    if rule_def["phases"]:
        phase_mask = np.isin(phase_labels, rule_def["phases"])
        mask = mask & phase_mask

    findings = _group_violations(
        timestamps, mask, values,
        rule_id=rule_def["rule_id"],
        rule_name=rule_def["rule_name"],
        threshold=rule_def["threshold"],
        direction=direction,
        severity=rule_def["severity"],
        deviation_type=rule_def["deviation_type"],
        col=col,
        phase_labels=phase_labels,
    )

    checked = {
        "rule_id": rule_def["rule_id"],
        "rule_name": rule_def["rule_name"],
        "parameter": col,
        "threshold": rule_def["threshold"],
        "status": "checked",
        "findings_count": len(findings),
    }
    return findings, checked


def _apply_alt_rapid_drop(
    df: pd.DataFrame,
    timestamps: np.ndarray,
    phase_labels: np.ndarray,
) -> Tuple[List[Dict], Dict]:
    """GPS Altitude drops > 200 ft in < 10 s outside DESCENT phase."""
    rule_id = "alt_rapid_drop"
    rule_name = "Rapid Altitude Loss (Outside Descent)"
    threshold = 200.0

    col = _find_col(df, ALT_CANDIDATES)
    if col is None:
        return [], {
            "rule_id": rule_id,
            "rule_name": rule_name,
            "parameter": None,
            "threshold": threshold,
            "status": "skipped",
            "reason": (
                f"Altitude parameter not found "
                f"(looked for: {', '.join(ALT_CANDIDATES[:3])}…)"
            ),
            "findings_count": 0,
        }

    alt = _to_numeric(df[col])
    n = len(timestamps)
    mask = np.zeros(n, dtype=bool)

    # Timestamps must be sorted (guaranteed by evaluate_rules)
    for i in range(n):
        if phase_labels[i] == "DESCENT":
            continue
        end_idx = int(np.searchsorted(timestamps, timestamps[i] + 10.0))
        window = alt[i:end_idx]
        if window.size < 2:
            continue
        if alt[i] - np.nanmin(window) > threshold:
            mask[i] = True

    findings = _group_violations(
        timestamps, mask, alt,
        rule_id=rule_id,
        rule_name=rule_name,
        threshold=threshold,
        direction="below",
        severity="high",
        deviation_type="exceedance",
        col=col,
        phase_labels=phase_labels,
    )

    # Re-compute peak_value as actual drop (not minimum altitude)
    for finding in findings:
        seg_mask = (
            (timestamps >= finding["start_time"])
            & (timestamps <= finding["end_time"])
        )
        seg_alt = alt[seg_mask]
        if seg_alt.size > 0 and not np.isnan(seg_alt[0]):
            finding["peak_value"] = round(float(seg_alt[0] - np.nanmin(seg_alt)), 1)

    checked = {
        "rule_id": rule_id,
        "rule_name": rule_name,
        "parameter": col,
        "threshold": threshold,
        "status": "checked",
        "findings_count": len(findings),
    }
    return findings, checked


def evaluate_rules(path: str) -> Dict:
    """
    Run all aviation safety rules against the FDR file at `path`.

    Returns:
        {
            "findings":      list of finding dicts (shape matches AI segments),
            "rules_checked": list of rule audit entries (checked / skipped),
        }
    """
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415
    from services.fdr_anomaly.autoencoder import (  # noqa: PLC0415
        _load_data,
        _parse_session_time,
    )
    from services.fdr_anomaly.phase import (  # noqa: PLC0415
        _find_col as _phase_find_col,
        _label_phases,
        _to_numeric as _phase_to_numeric,
        VS_CANDIDATES as PHASE_VS,
        IAS_CANDIDATES as PHASE_IAS,
        ALT_CANDIDATES as PHASE_ALT,
    )

    df = _load_data(path)
    df, _fmt = normalize_dataframe(df)

    timestamps = _parse_session_time(df["Session Time"])
    order = np.argsort(timestamps)
    df = df.iloc[order].reset_index(drop=True)
    timestamps = timestamps[order]

    try:
        vs_col = _phase_find_col(df, PHASE_VS)
        ias_col = _phase_find_col(df, PHASE_IAS)
        alt_col = _phase_find_col(df, PHASE_ALT)
        vs_arr = _phase_to_numeric(df[vs_col]) if vs_col else None
        ias_arr = _phase_to_numeric(df[ias_col]) if ias_col else None
        alt_arr = _phase_to_numeric(df[alt_col]) if alt_col else None
        phase_labels = _label_phases(timestamps, vs_arr, ias_arr, alt_arr)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Phase labeling failed in rules engine, using CRUISE: %s", exc)
        phase_labels = np.full(len(timestamps), "CRUISE", dtype=object)

    all_findings: List[Dict] = []
    rules_checked: List[Dict] = []

    for rule_def in RULE_DEFS:
        findings, checked = _apply_rule(df, timestamps, phase_labels, rule_def)
        all_findings.extend(findings)
        rules_checked.append(checked)

    alt_findings, alt_checked = _apply_alt_rapid_drop(df, timestamps, phase_labels)
    all_findings.extend(alt_findings)
    rules_checked.append(alt_checked)

    all_findings.sort(key=lambda f: f.get("start_time", 0))

    return {
        "findings": all_findings,
        "rules_checked": rules_checked,
    }
