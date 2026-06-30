import importlib.util
import json
import logging
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA


DEFAULT_WINDOW_SIZE = int(os.getenv("FDR_WINDOW_SIZE", "60"))
DEFAULT_STRIDE = int(os.getenv("FDR_WINDOW_STRIDE", "5"))
DEFAULT_EPOCHS = int(os.getenv("FDR_EPOCHS", "30"))
DEFAULT_THRESHOLD_PERCENTILE = float(os.getenv("FDR_THRESHOLD_PERCENTILE", "85"))
DEFAULT_BATCH_SIZE = int(os.getenv("FDR_BATCH_SIZE", "128"))
DEFAULT_BACKEND = os.getenv("FDR_AUTOENCODER_BACKEND", "pca").strip().lower()
MIN_TRAIN_STD = float(os.getenv("FDR_MIN_TRAIN_STD", "1e-3"))
MAX_STANDARDIZED_ABS = float(os.getenv("FDR_MAX_STANDARDIZED_ABS", "20"))
SEGMENT_GAP_SECONDS = 30.0  # merge anomalous rows within 30 s into one segment
# Phases with fewer rows than this use the global threshold (not a per-phase one)
# to avoid false positives from tiny sample sizes.
MIN_PHASE_ROWS_FOR_THRESHOLD = 30

TIME_COLUMNS = {
    "Session Time", "System Time", "GPS Date & Time",
    # NASA DFDAU time columns
    "GMT_HOUR", "GMT_MINUTE", "GMT_MIN", "GMT_SEC",
}
EXCLUDED_COLUMNS = {
    "Session Time",
    "System Time",
    "GPS Date & Time",
    "Destination Waypoint ID",
    "Transponder Code (octal)",
    # NASA DFDAU time components (synthesised into "Session Time" by fdr_format)
    "GMT_HOUR", "GMT_MINUTE", "GMT_MIN", "GMT_SEC",
    # mat_to_excel row counter
    "Sample #",
}
EXCLUDED_COLUMN_TOKENS = (
    "waypoint",
    "transponder",
    "icao",
    "tail",
    "flight",
    "callsign",
    "label",
    "id",
    "name",
    "sample",   # catches "Sample #" row-counter columns
)
MIN_NUMERIC_FEATURES = 2

logger = logging.getLogger(__name__)


@dataclass
class TimelineData:
    time: List[float]
    score: List[float]


class AutoencoderBackend:
    def __init__(self, input_dim: int) -> None:
        self.input_dim = input_dim
        self.model = None

    def fit(self, data: np.ndarray, epochs: int, batch_size: int) -> None:
        raise NotImplementedError

    def reconstruct(self, data: np.ndarray) -> np.ndarray:
        raise NotImplementedError


class TorchAutoencoder(AutoencoderBackend):
    def __init__(self, input_dim: int) -> None:
        super().__init__(input_dim)
        import torch
        from torch import nn

        self.torch = torch
        self.model = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, 64),
            nn.ReLU(),
            nn.Linear(64, 128),
            nn.ReLU(),
            nn.Linear(128, input_dim),
        )

    def fit(self, data: np.ndarray, epochs: int, batch_size: int) -> None:
        torch = self.torch
        device = torch.device("cpu")
        self.model.to(device)
        dataset = torch.utils.data.TensorDataset(torch.tensor(data, dtype=torch.float32))
        loader = torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=True)
        optimizer = torch.optim.Adam(self.model.parameters(), lr=1e-3)
        loss_fn = torch.nn.MSELoss()

        self.model.train()
        for _ in range(epochs):
            for (batch,) in loader:
                batch = batch.to(device)
                optimizer.zero_grad()
                output = self.model(batch)
                loss = loss_fn(output, batch)
                loss.backward()
                optimizer.step()

    def reconstruct(self, data: np.ndarray) -> np.ndarray:
        torch = self.torch
        device = torch.device("cpu")
        self.model.eval()
        with torch.no_grad():
            tensor = torch.tensor(data, dtype=torch.float32).to(device)
            output = self.model(tensor)
        return output.cpu().numpy()


class TfAutoencoder(AutoencoderBackend):
    def __init__(self, input_dim: int) -> None:
        super().__init__(input_dim)
        import tensorflow as tf

        self.tf = tf
        self.model = tf.keras.Sequential(
            [
                tf.keras.layers.InputLayer(input_shape=(input_dim,)),
                tf.keras.layers.Dense(128, activation="relu"),
                tf.keras.layers.Dense(64, activation="relu"),
                tf.keras.layers.Dense(32, activation="relu"),
                tf.keras.layers.Dense(64, activation="relu"),
                tf.keras.layers.Dense(128, activation="relu"),
                tf.keras.layers.Dense(input_dim),
            ]
        )
        self.model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="mse")

    def fit(self, data: np.ndarray, epochs: int, batch_size: int) -> None:
        self.model.fit(data, data, epochs=epochs, batch_size=batch_size, verbose=0)

    def reconstruct(self, data: np.ndarray) -> np.ndarray:
        return self.model.predict(data, verbose=0)


class PcaAutoencoder(AutoencoderBackend):
    def __init__(self, input_dim: int, n_components: int) -> None:
        super().__init__(input_dim)
        self.model = PCA(n_components=n_components, svd_solver="auto", random_state=42)

    def fit(self, data: np.ndarray, epochs: int, batch_size: int) -> None:
        self.model.fit(data)

    def reconstruct(self, data: np.ndarray) -> np.ndarray:
        transformed = self.model.transform(data)
        return self.model.inverse_transform(transformed)


def _load_data(path: str) -> pd.DataFrame:
    if path.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(path)
    return pd.read_csv(path, low_memory=False)


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

    raise ValueError("Unable to parse Session Time column to numeric seconds.")


def _select_numeric_columns(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[str], List[str]]:
    numeric_columns: Dict[str, pd.Series] = {}
    dropped_columns: List[str] = []

    for column in df.columns:
        lower_name = column.lower()
        if (
            column in EXCLUDED_COLUMNS
            or column in TIME_COLUMNS
            or any(token in lower_name for token in EXCLUDED_COLUMN_TOKENS)
        ):
            dropped_columns.append(column)
            continue

        series = pd.to_numeric(df[column], errors="coerce")
        if series.notna().sum() == 0:
            dropped_columns.append(column)
            continue

        variance = float(series.var(skipna=True))
        if not np.isfinite(variance) or variance <= 0.0:
            dropped_columns.append(column)
            continue

        numeric_columns[column] = series.astype(float)

    if not numeric_columns:
        return pd.DataFrame(), [], dropped_columns

    numeric_df = pd.DataFrame(numeric_columns)
    all_nan_columns = numeric_df.columns[numeric_df.isna().all()].tolist()
    if all_nan_columns:
        numeric_df = numeric_df.drop(columns=all_nan_columns)
        dropped_columns.extend(all_nan_columns)

    return numeric_df, list(numeric_df.columns), dropped_columns


def _standardize(features: pd.DataFrame, train_end: int) -> Tuple[pd.DataFrame, pd.Series, pd.Series]:
    train = features.iloc[:train_end]
    mean = train.mean()
    std = train.std().replace(0.0, 1.0)
    standardized = (features - mean) / std
    return standardized, mean, std


def _fill_missing_bidirectional(frame: pd.DataFrame) -> pd.DataFrame:
    """Forward/backward fill with pandas 2.x API first and legacy fallback."""
    try:
        return frame.ffill().bfill()
    except (AttributeError, TypeError):
        return frame.fillna(method="ffill").fillna(method="bfill")


def _build_windows(values: np.ndarray, window_size: int, stride: int) -> Tuple[np.ndarray, List[int]]:
    windows = []
    starts = []
    for start in range(0, values.shape[0] - window_size + 1, stride):
        end = start + window_size
        windows.append(values[start:end])
        starts.append(start)
    return np.stack(windows), starts


def _get_backend(input_dim: int) -> AutoencoderBackend:
    preferred = DEFAULT_BACKEND

    if preferred == "torch":
        if importlib.util.find_spec("torch") is not None:
            return TorchAutoencoder(input_dim)
        logger.warning("FDR_AUTOENCODER_BACKEND=torch requested but torch is unavailable; using PCA.")

    if preferred in {"tf", "tensorflow"}:
        if importlib.util.find_spec("tensorflow") is not None:
            return TfAutoencoder(input_dim)
        logger.warning(
            "FDR_AUTOENCODER_BACKEND=tensorflow requested but tensorflow is unavailable; using PCA."
        )

    if preferred == "auto":
        if importlib.util.find_spec("torch") is not None:
            return TorchAutoencoder(input_dim)
        if importlib.util.find_spec("tensorflow") is not None:
            return TfAutoencoder(input_dim)

    n_components = max(2, min(32, input_dim // 2))
    return PcaAutoencoder(input_dim, n_components)


def _map_window_scores(
    n_rows: int,
    window_size: int,
    starts: List[int],
    window_scores: np.ndarray,
    window_feature_errors: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    timeline_scores = np.zeros(n_rows, dtype=float)
    timeline_features = np.zeros((n_rows, window_feature_errors.shape[1]), dtype=float)
    for idx, start in enumerate(starts):
        end = start + window_size
        timeline_scores[start:end] = np.maximum(timeline_scores[start:end], window_scores[idx])
        timeline_features[start:end] = np.maximum(timeline_features[start:end], window_feature_errors[idx])
    return timeline_scores, timeline_features


def _group_segments(
    timestamps: np.ndarray,
    scores: np.ndarray,
    feature_scores: np.ndarray,
    feature_names: List[str],
    threshold: float,
    anomaly_mask_override: "np.ndarray | None" = None,
) -> List[Dict[str, object]]:
    if anomaly_mask_override is not None:
        anomaly_mask = anomaly_mask_override
    elif np.allclose(scores, scores[0]):
        anomaly_mask = np.zeros_like(scores, dtype=bool)
    else:
        anomaly_mask = scores >= threshold

    indices = np.where(anomaly_mask)[0]
    if indices.size == 0:
        return []

    segments = []
    start_idx = indices[0]
    last_idx = indices[0]

    def build_segment(segment_indices: np.ndarray) -> Dict[str, object]:
        seg_scores = scores[segment_indices]
        seg_feature = feature_scores[segment_indices].mean(axis=0)
        top_drivers = _build_top_drivers(seg_feature, feature_names)
        explanation = _build_explanation(top_drivers)
        return {
            "start_time": float(timestamps[segment_indices[0]]),
            "end_time": float(timestamps[segment_indices[-1]]),
            "severity": _score_to_severity(seg_scores.max(), scores),
            "score_peak": float(seg_scores.max()),
            "top_drivers": top_drivers,
            "explanation": explanation,
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


def _build_top_drivers(feature_scores: np.ndarray, feature_names: List[str]) -> List[Dict[str, object]]:
    driver_scores = sorted(
        zip(feature_names, feature_scores),
        key=lambda item: item[1],
        reverse=True,
    )
    return [
        {"parameter": name, "error": float(score)}
        for name, score in driver_scores[:5]
    ]


def _build_explanation(top_drivers: List[Dict[str, object]]) -> str:
    top_names = [driver["parameter"] for driver in top_drivers[:3]]
    if top_names:
        joined = ", ".join(top_names)
        return (
            f"Unusual behavior pattern compared to learned normal behavior for this flight. "
            f"Top drivers: {joined}."
        )
    return "Unusual behavior pattern compared to learned normal behavior for this flight."


def _score_to_severity(
    score: float,
    scores: np.ndarray,
    phase_scores: "np.ndarray | None" = None,
) -> str:
    # Rate severity against the phase's own score distribution when available,
    # otherwise fall back to the flight-wide distribution.
    ref = phase_scores if (phase_scores is not None and len(phase_scores) > 1) else scores
    if np.allclose(ref, ref[0]):
        return "low"
    p97 = float(np.percentile(ref, 97))
    p90 = float(np.percentile(ref, 90))
    if score >= p97:
        return "high"
    if score >= p90:
        return "med"
    return "low"


def _get_phase_labels(df: "pd.DataFrame", timestamps: np.ndarray) -> np.ndarray:
    """Label every row with its flight phase by reusing phase.py logic.

    Returns an object array of phase strings with len == len(timestamps).
    Falls back to all-CRUISE on any error (preserves old global behaviour).
    """
    try:
        from services.fdr_anomaly.phase import (  # noqa: PLC0415
            _find_col,
            _label_phases,
            _to_numeric,
            ALT_CANDIDATES,
            IAS_CANDIDATES,
            VS_CANDIDATES,
        )

        vs_col = _find_col(df, VS_CANDIDATES)
        ias_col = _find_col(df, IAS_CANDIDATES)
        alt_col = _find_col(df, ALT_CANDIDATES)
        vs_arr = _to_numeric(df[vs_col]) if vs_col else None
        ias_arr = _to_numeric(df[ias_col]) if ias_col else None
        alt_arr = _to_numeric(df[alt_col]) if alt_col else None
        return _label_phases(timestamps, vs_arr, ias_arr, alt_arr)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Phase labeling failed, using global baseline: %s", exc)
        return np.full(len(timestamps), "CRUISE", dtype=object)


def _extract_unit(parameter: str) -> str:
    if not parameter:
        return ""
    if "(" in parameter and ")" in parameter:
        start = parameter.find("(")
        end = parameter.find(")", start + 1)
        if end > start:
            return parameter[start + 1 : end].strip()
    return ""


def _build_review_segments(
    timestamps: np.ndarray,
    scores: np.ndarray,
    feature_scores: np.ndarray,
    feature_names: List[str],
    limit: int = 10,
) -> List[Dict[str, object]]:
    order = np.argsort(scores)[::-1]
    seen = set()
    segments = []
    for idx in order:
        if len(segments) >= limit:
            break
        if idx in seen:
            continue
        seen.add(idx)
        top_drivers = _build_top_drivers(feature_scores[idx], feature_names)
        explanation = (
            "Review recommended. " + _build_explanation(top_drivers)
        )
        segments.append(
            {
                "start_time": float(timestamps[idx]),
                "end_time": float(timestamps[idx]),
                "severity": "low",
                "score_peak": float(scores[idx]),
                "top_drivers": top_drivers,
                "explanation": explanation,
            }
        )
    return segments


def detect_anomalies(
    path: str,
    window_size: int = DEFAULT_WINDOW_SIZE,
    stride: int = DEFAULT_STRIDE,
    epochs: int = DEFAULT_EPOCHS,
    threshold_percentile: float = DEFAULT_THRESHOLD_PERCENTILE,
    batch_size: int = DEFAULT_BATCH_SIZE,
    debug: bool = False,
) -> Dict[str, object]:
    from services.fdr_anomaly.fdr_format import normalize_dataframe  # noqa: PLC0415

    df = _load_data(path)
    df, _fmt = normalize_dataframe(df)

    timestamps = _parse_session_time(df["Session Time"])
    order = np.argsort(timestamps)
    df = df.iloc[order].reset_index(drop=True)
    timestamps = timestamps[order]

    # Task 9 — label each row with its flight phase BEFORE numeric selection so
    # that VS / altitude columns are still present.
    phase_labels = _get_phase_labels(df, timestamps)

    numeric_df, feature_names, dropped_columns = _select_numeric_columns(df)
    if dropped_columns:
        logger.info("FDR autoencoder dropped columns: %s", sorted(set(dropped_columns)))

    if not feature_names:
        raise ValueError(
            "Insufficient numeric features after preprocessing. "
            "Ensure the file includes sensor columns with numeric values."
        )

    numeric_df = numeric_df.reset_index(drop=True)
    numeric_df = _fill_missing_bidirectional(numeric_df)
    numeric_df = numeric_df.astype(float)
    feature_names = list(numeric_df.columns)

    if len(feature_names) < MIN_NUMERIC_FEATURES:
        raise ValueError(
            f"Insufficient numeric features after preprocessing: found {len(feature_names)}, "
            f"need at least {MIN_NUMERIC_FEATURES}."
        )

    logger.info("FDR autoencoder final feature count: %d", len(feature_names))

    n_rows = numeric_df.shape[0]
    if n_rows == 0:
        raise ValueError("No rows available for anomaly detection.")

    if n_rows < window_size:
        window_size = max(5, n_rows)
        stride = 1

    train_end = max(1, int(n_rows * 0.7))
    train_std = numeric_df.iloc[:train_end].std()
    stable_feature_names = train_std[train_std >= MIN_TRAIN_STD].index.tolist()
    if len(stable_feature_names) >= MIN_NUMERIC_FEATURES:
        dropped_for_low_std = sorted(set(feature_names) - set(stable_feature_names))
        if dropped_for_low_std:
            logger.info(
                "FDR autoencoder dropped low-variance training features: %s",
                dropped_for_low_std,
            )
        numeric_df = numeric_df[stable_feature_names]
        feature_names = stable_feature_names

    if len(feature_names) < MIN_NUMERIC_FEATURES:
        raise ValueError(
            f"Insufficient stable numeric features after preprocessing: found {len(feature_names)}, "
            f"need at least {MIN_NUMERIC_FEATURES}."
        )

    standardized, mean, std = _standardize(numeric_df, train_end)
    standardized = standardized.clip(lower=-MAX_STANDARDIZED_ABS, upper=MAX_STANDARDIZED_ABS)
    values = standardized.to_numpy(dtype=float)

    windows, starts = _build_windows(values, window_size, stride)
    if windows.size == 0:
        raise ValueError("Unable to build windows for anomaly detection.")

    n_windows, _, n_features = windows.shape
    flat_windows = windows.reshape(n_windows, window_size * n_features)

    train_window_end = max(1, int(n_windows * 0.7))
    backend = _get_backend(flat_windows.shape[1])
    backend.fit(flat_windows[:train_window_end], epochs=epochs, batch_size=batch_size)
    reconstructed = backend.reconstruct(flat_windows)

    window_errors = np.mean((flat_windows - reconstructed) ** 2, axis=1)
    window_feature_errors = ((flat_windows - reconstructed) ** 2).reshape(
        n_windows, window_size, n_features
    ).mean(axis=1)

    timeline_scores, timeline_feature_scores = _map_window_scores(
        n_rows, window_size, starts, window_errors, window_feature_errors
    )

    # ── Global threshold (used as fallback for small phases) ─────────────────────
    threshold = np.percentile(timeline_scores, threshold_percentile) if n_rows > 0 else 0.0

    logger.info(
        "FDR score stats: n_rows=%d n_windows=%d "
        "score_min=%.6g score_max=%.6g score_mean=%.6g score_median=%.6g "
        "threshold_pct=%g threshold=%.6g",
        n_rows, len(starts),
        float(np.min(timeline_scores)), float(np.max(timeline_scores)),
        float(np.mean(timeline_scores)), float(np.median(timeline_scores)),
        threshold_percentile, float(threshold),
    )

    # ── Task 9 — Per-phase thresholding ──────────────────────────────────────────
    # Each phase gets its own threshold at the same percentile of that phase's
    # score distribution.  Phases with fewer than MIN_PHASE_ROWS_FOR_THRESHOLD
    # rows fall back to the global threshold to avoid false positives from tiny
    # samples (e.g. TAKEOFF / LANDING often have < 30 rows).
    unique_phases = sorted(set(phase_labels))
    phase_thresholds: Dict[str, float] = {}
    phase_scores_map: Dict[str, np.ndarray] = {}   # phase → scores array (for severity)
    phase_used_global_fallback: set = set()

    for ph in unique_phases:
        ph_mask = phase_labels == ph
        ph_scores = timeline_scores[ph_mask]
        phase_scores_map[ph] = ph_scores
        if ph_mask.sum() < MIN_PHASE_ROWS_FOR_THRESHOLD:
            phase_thresholds[ph] = float(threshold)
            phase_used_global_fallback.add(ph)
            logger.info(
                "Phase %s has only %d rows — using global threshold (%.6g)",
                ph, int(ph_mask.sum()), threshold,
            )
        else:
            phase_thresholds[ph] = float(np.percentile(ph_scores, threshold_percentile))
            logger.info(
                "Phase %s: %d rows, per-phase threshold=%.6g",
                ph, int(ph_mask.sum()), phase_thresholds[ph],
            )

    # Build a per-row threshold array then construct the anomaly mask.
    phase_threshold_per_row = np.array(
        [phase_thresholds.get(ph, threshold) for ph in phase_labels],
        dtype=float,
    )
    if np.allclose(timeline_scores, timeline_scores[0]):
        per_phase_anomaly_mask = np.zeros(n_rows, dtype=bool)
    else:
        per_phase_anomaly_mask = timeline_scores >= phase_threshold_per_row

    # ─────────────────────────────────────────────────────────────────────────────

    segments = _group_segments(
        timestamps, timeline_scores, timeline_feature_scores, feature_names,
        threshold, anomaly_mask_override=per_phase_anomaly_mask,
    )

    if not segments:
        segments = _build_review_segments(
            timestamps, timeline_scores, timeline_feature_scores, feature_names
        )

    # ── Task 9 — annotate each segment with its dominant phase ────────────────
    def _segment_phase(seg: Dict[str, object]) -> str:
        start_t = seg.get("start_time")
        end_t = seg.get("end_time")
        if start_t is None:
            return "CRUISE"
        mid_t = ((start_t or 0) + (end_t or start_t or 0)) / 2
        idx = int(np.argmin(np.abs(timestamps - mid_t)))
        return str(phase_labels[idx]) if idx < len(phase_labels) else "CRUISE"

    for seg in segments:
        seg_phase = _segment_phase(seg)
        seg["phase_label"] = seg_phase
        seg["baseline_method"] = (
            "global_fallback_insufficient_data"
            if seg_phase in phase_used_global_fallback
            else "per_phase_threshold"
        )
        # Re-score severity against the phase-specific distribution.
        ph_scores_ref = phase_scores_map.get(seg_phase)
        if ph_scores_ref is not None and len(ph_scores_ref) > 1:
            peak_raw = seg.get("score_peak", 0.0)
            seg["severity"] = _score_to_severity(
                float(peak_raw), timeline_scores, phase_scores=ph_scores_ref
            )

    # ── Normalize score_peak relative to the *global* threshold so values remain
    # comparable across runs (1.0 = at global threshold; 2.0 = twice).
    if threshold > 0:
        for seg in segments:
            raw = seg.get("score_peak", 0.0)
            seg["score_peak"] = round(float(raw) / float(threshold), 4)

    # Sort by severity then peak score; cap at 10 for UI clarity
    _SEVERITY_ORDER = {"high": 3, "med": 2, "low": 1}
    segments = sorted(
        segments,
        key=lambda s: (_SEVERITY_ORDER.get(s.get("severity", "low"), 0), s.get("score_peak", 0)),
        reverse=True,
    )
    _MAX_SEGMENTS = 10
    extra_segments_omitted = max(0, len(segments) - _MAX_SEGMENTS)
    segments = segments[:_MAX_SEGMENTS]

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

    # ── Build flagged_mask for baseline stats (union of per-phase mask + segments) ──
    flagged_mask = per_phase_anomaly_mask.copy()
    for segment in segments:
        start_time = segment.get("start_time")
        end_time = segment.get("end_time")
        if start_time is None or end_time is None:
            continue
        flagged_mask |= (timestamps >= start_time) & (timestamps <= end_time)

    # ── Task 9 — per-phase baseline stats for driver_stats ───────────────────
    # Non-flagged rows within the same phase give the phase-local baseline;
    # fall back to all phase rows if everything in the phase is flagged.
    def _phase_baseline_stats(ph: str) -> Dict[str, Dict[str, float]]:
        ph_mask = phase_labels == ph
        nf_mask = ph_mask & ~flagged_mask
        ref_df = numeric_df[nf_mask] if not numeric_df[nf_mask].empty else numeric_df[ph_mask]
        if ref_df.empty:
            ref_df = numeric_df
        stats: Dict[str, Dict[str, float]] = {}
        for col in feature_names:
            vals = ref_df[col].to_numpy(dtype=float)
            if vals.size == 0:
                continue
            stats[col] = {
                "baseline_p5": float(np.percentile(vals, 5)),
                "baseline_p95": float(np.percentile(vals, 95)),
                "baseline_median": float(np.median(vals)),
            }
        return stats

    # Cache per-phase baselines (only compute for phases that appear in segments).
    phase_baseline_cache: Dict[str, Dict[str, Dict[str, float]]] = {}

    for segment in segments:
        start_time = segment.get("start_time")
        end_time = segment.get("end_time")
        if start_time is None or end_time is None:
            continue
        seg_phase = segment.get("phase_label", "CRUISE")
        if seg_phase not in phase_baseline_cache:
            phase_baseline_cache[seg_phase] = _phase_baseline_stats(seg_phase)
        baseline_stats = phase_baseline_cache[seg_phase]

        segment_mask = (timestamps >= start_time) & (timestamps <= end_time)
        driver_stats = []
        for driver in segment.get("top_drivers", []):
            name = driver.get("parameter")
            if not name or name not in numeric_df.columns:
                continue
            segment_values = numeric_df.loc[segment_mask, name].to_numpy(dtype=float)
            if segment_values.size == 0:
                continue
            baseline = baseline_stats.get(name, {})
            driver_stats.append(
                {
                    "param": name,
                    "unit": _extract_unit(name),
                    "segment_min": float(np.min(segment_values)),
                    "segment_max": float(np.max(segment_values)),
                    "baseline_p5": baseline.get("baseline_p5"),
                    "baseline_p95": baseline.get("baseline_p95"),
                    "baseline_median": baseline.get("baseline_median"),
                }
            )
        segment["driver_stats"] = driver_stats

    flagged_row_count = int(flagged_mask.sum())
    flagged_percent = (flagged_row_count / n_rows) * 100 if n_rows else 0.0

    # ── Task 9 — phase_breakdown for UI Phase Breakdown section ──────────────
    _SEV_RANK = {"high": 3, "med": 2, "low": 1}
    phase_breakdown: Dict[str, Dict[str, object]] = {}
    for ph in unique_phases:
        ph_mask = phase_labels == ph
        ph_segs = [s for s in segments if s.get("phase_label") == ph]
        worst_sev = None
        top_param = None
        if ph_segs:
            worst_seg = max(ph_segs, key=lambda s: _SEV_RANK.get(s.get("severity", "low"), 0))
            worst_sev = worst_seg.get("severity")
            dc: Dict[str, int] = {}
            for s in ph_segs:
                for d in s.get("top_drivers", []):
                    n = d.get("parameter")
                    if n:
                        dc[n] = dc.get(n, 0) + 1
            if dc:
                top_param = max(dc, key=dc.get)  # type: ignore[arg-type]
        phase_breakdown[ph] = {
            "n_rows": int(ph_mask.sum()),
            "segments_found": int(len(ph_segs)),
            "worst_severity": worst_sev,
            "top_param": top_param,
            "threshold": float(phase_thresholds.get(ph, threshold)),
            "used_global_fallback": ph in phase_used_global_fallback,
        }

    summary = {
        "n_rows": int(n_rows),
        "n_params_used": int(len(feature_names)),
        "segments_found": int(len(segments)),
        "extra_segments_omitted": int(extra_segments_omitted),
        "top_parameters": top_parameters,
        "flaggedRowCount": flagged_row_count,
        "flaggedPercent": round(flagged_percent, 4),
        "window_size": int(window_size),
        "stride": int(stride),
        "threshold_percentile": float(threshold_percentile),
        "threshold_value": float(threshold),
        "phase_breakdown": phase_breakdown,
        "phase_aware": True,
    }

    timeline = TimelineData(
        time=timestamps.astype(float).round(4).tolist(),
        score=np.round(timeline_scores, 6).tolist(),
    )

    payload = {
        "summary": summary,
        "segments": segments,
        "timeline": timeline.__dict__,
    }

    if debug:
        payload["debugInfo"] = {
            "columns_used": feature_names,
            "threshold": float(threshold),
            "max_score": float(np.max(timeline_scores) if timeline_scores.size else 0.0),
            "window_size": int(window_size),
            "stride": int(stride),
            "epochs": int(epochs),
            "backend": backend.__class__.__name__,
            "mean": mean.to_dict(),
            "std": std.to_dict(),
        }

    return payload


def detect_to_json(path: str, debug: bool = False) -> str:
    payload = detect_anomalies(path, debug=debug)
    return json.dumps(payload, indent=2)
