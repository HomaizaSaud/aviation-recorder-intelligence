import json
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest


MAD_Z_THRESHOLD = 8.0
ROLLING_WINDOW = 51
IFOREST_CONTAMINATION = 0.01
SEGMENT_GAP_SECONDS = 2.0
TOP_DRIVER_COUNT = 3
TIME_COLUMNS = {"Session Time", "System Time", "GPS Date & Time"}
EXCLUDED_COLUMNS = set()

VERTICAL_TOKENS = ("vertical speed", "pitch")
LATERAL_TOKENS = ("roll", "turn rate")
PROPULSION_TOKENS = ("rpm", "manifold pressure", "fuel flow")
GPS_TOKENS = ("gps fix quality", "satellites")

@dataclass
class TimelineData:
    timestamps: List[float]
    robust_z_max: List[float]
    iforest_score: List[float]
    combined_score: List[float]
    is_anomaly: List[bool]


def _load_data(path: str) -> pd.DataFrame:
    if path.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(path)
    return pd.read_csv(path)


def _parse_session_time(series: pd.Series) -> np.ndarray:
    if pd.api.types.is_numeric_dtype(series):
        values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)
        return values

    as_timedelta = pd.to_timedelta(series, errors="coerce")
    if not as_timedelta.isna().all():
        seconds = as_timedelta.dt.total_seconds().to_numpy(dtype=float)
        return seconds

    as_datetime = pd.to_datetime(series, errors="coerce")
    if not as_datetime.isna().all():
        base = as_datetime.iloc[0]
        seconds = (as_datetime - base).dt.total_seconds().to_numpy(dtype=float)
        return seconds

    raise ValueError("Unable to parse Session Time column to numeric seconds.")


def _numeric_parameters(df: pd.DataFrame, time_column: str) -> pd.DataFrame:
    excluded = {time_column, *TIME_COLUMNS, *EXCLUDED_COLUMNS}
    drop_columns = [col for col in excluded if col in df.columns]
    numeric_df = df.drop(columns=drop_columns).select_dtypes(include=[np.number])
    if numeric_df.empty:
        raise ValueError("No numeric parameters available for anomaly detection.")
    return numeric_df


def _rolling_mad_zscores(values: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
    rolling_median = values.rolling(window=ROLLING_WINDOW, min_periods=10, center=True).median()
    deviation = (values - rolling_median).abs()
    mad = deviation.rolling(window=ROLLING_WINDOW, min_periods=10, center=True).median()
    mad = mad.replace(0.0, np.nan)
    robust_z = 0.6745 * (values - rolling_median) / mad
    robust_z = robust_z.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    max_z = robust_z.abs().max(axis=1)
    return robust_z, max_z


def _robust_scale(values: pd.DataFrame) -> pd.DataFrame:
    median = values.median()
    q1 = values.quantile(0.25)
    q3 = values.quantile(0.75)
    iqr = (q3 - q1).replace(0.0, 1.0)
    scaled = (values - median) / iqr
    return scaled.fillna(0.0)


def _isolation_forest_scores(features: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
    model = IsolationForest(
        contamination=IFOREST_CONTAMINATION,
        random_state=42,
        n_estimators=200,
    )
    model.fit(features)
    prediction = model.predict(features)
    score = -model.score_samples(features)
    return prediction, score


def _group_segments(
    timestamps: np.ndarray,
    anomaly_mask: np.ndarray,
    robust_z: pd.DataFrame,
    combined_score: np.ndarray,
) -> List[Dict[str, object]]:
    indices = np.where(anomaly_mask)[0]
    if indices.size == 0:
        return []

    segments = []
    start_idx = indices[0]
    last_idx = indices[0]


    def build_explanation(top_drivers: List[Dict[str, float]]) -> str:
        driver_summary = ", ".join(
            f"{driver['parameter']} (z={driver['max_robust_z']:.2f})" for driver in top_drivers
        )
        messages = []
        driver_names = [driver["parameter"].lower() for driver in top_drivers]
        if any(token in name for name in driver_names for token in VERTICAL_TOKENS):
            messages.append("Possible unusual maneuver or vertical profile change.")
        if any(token in name for name in driver_names for token in LATERAL_TOKENS):
            messages.append("Possible unusual lateral maneuver.")
        if any(token in name for name in driver_names for token in PROPULSION_TOKENS):
            messages.append("Possible propulsion/power change.")
        if any(token in name for name in driver_names for token in GPS_TOKENS):
            messages.append("Possible GPS signal quality issue.")
        if messages:
            return f"Top drivers: {driver_summary}. " + " ".join(messages)
        return f"Top drivers: {driver_summary}."

    def build_segment(segment_indices: np.ndarray) -> Dict[str, object]:
        seg_times = timestamps[segment_indices]
        seg_scores = combined_score[segment_indices]
        seg_robust = robust_z.iloc[segment_indices]
        driver_scores = seg_robust.abs().max(axis=0).sort_values(ascending=False)
        top_drivers = [
            {"parameter": name, "max_robust_z": float(score)}
            for name, score in driver_scores.head(TOP_DRIVER_COUNT).items()
        ]
        return {
            "start_time": float(seg_times[0]),
            "end_time": float(seg_times[-1]),
            "duration": float(seg_times[-1] - seg_times[0]),
            "points": int(segment_indices.size),
            "peak_score": float(seg_scores.max()),
            "top_drivers": top_drivers,
            "explanation": build_explanation(top_drivers),
        }

    for idx in indices[1:]:
        if timestamps[idx] - timestamps[last_idx] <= SEGMENT_GAP_SECONDS:
            last_idx = idx
            continue
        segment_indices = np.arange(start_idx, last_idx + 1)
        segments.append(build_segment(segment_indices))
        start_idx = idx
        last_idx = idx

    segment_indices = np.arange(start_idx, last_idx + 1)
    segments.append(build_segment(segment_indices))
    return segments


def detect_anomalies(path: str) -> Dict[str, object]:
    df = _load_data(path)
    if "Session Time" not in df.columns:
        raise ValueError("Input file must include a 'Session Time' column.")

    timestamps = _parse_session_time(df["Session Time"])
    numeric_df = _numeric_parameters(df, "Session Time")
    numeric_df = numeric_df.reset_index(drop=True)

    robust_z, max_z = _rolling_mad_zscores(numeric_df)
    scaled = _robust_scale(numeric_df)
    iforest_pred, iforest_score = _isolation_forest_scores(scaled)

    combined_score = max_z.to_numpy() + iforest_score
    anomaly_mask = (max_z.to_numpy() >= MAD_Z_THRESHOLD) | (iforest_pred == -1)

    segments = _group_segments(timestamps, anomaly_mask, robust_z, combined_score)
    driver_counts: Dict[str, int] = {}
    for segment in segments:
        for driver in segment.get("top_drivers", []):
            name = driver.get("parameter")
            if not name:
                continue
            driver_counts[name] = driver_counts.get(name, 0) + 1

    top_parameters = [
        {"parameter": name, "count": count}
        for name, count in sorted(driver_counts.items(), key=lambda item: item[1], reverse=True)
    ]

    timeline = TimelineData(
        timestamps=timestamps.tolist(),
        robust_z_max=max_z.round(4).tolist(),
        iforest_score=np.round(iforest_score, 4).tolist(),
        combined_score=np.round(combined_score, 4).tolist(),
        is_anomaly=anomaly_mask.tolist(),
    )

    summary = {
        "total_points": int(len(df)),
        "total_parameters": int(numeric_df.shape[1]),
        "n_params_used": int(numeric_df.shape[1]),
        "total_anomalies": int(anomaly_mask.sum()),
        "total_segments": int(len(segments)),
        "robust_z_threshold": MAD_Z_THRESHOLD,
        "iforest_contamination": IFOREST_CONTAMINATION,
        "top_parameters": top_parameters,
    }

    return {
        "summary": summary,
        "segments": segments,
        "timeline": timeline.__dict__,
    }


def detect_to_json(path: str) -> str:
    payload = detect_anomalies(path)
    return json.dumps(payload, indent=2)
