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
DEFAULT_THRESHOLD_PERCENTILE = float(os.getenv("FDR_THRESHOLD_PERCENTILE", "97"))
DEFAULT_BATCH_SIZE = int(os.getenv("FDR_BATCH_SIZE", "128"))
DEFAULT_BACKEND = os.getenv("FDR_AUTOENCODER_BACKEND", "pca").strip().lower()
MIN_TRAIN_STD = float(os.getenv("FDR_MIN_TRAIN_STD", "1e-3"))
MAX_STANDARDIZED_ABS = float(os.getenv("FDR_MAX_STANDARDIZED_ABS", "20"))
SEGMENT_GAP_SECONDS = 2.0

TIME_COLUMNS = {"Session Time", "System Time", "GPS Date & Time"}
EXCLUDED_COLUMNS = {
    "Session Time",
    "System Time",
    "GPS Date & Time",
    "Destination Waypoint ID",
    "Transponder Code (octal)",
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
) -> List[Dict[str, object]]:
    if np.allclose(scores, scores[0]):
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
            "severity": _score_to_severity(seg_scores.max(), scores, threshold),
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


def _score_to_severity(score: float, scores: np.ndarray, high_threshold: float) -> str:
    if np.allclose(scores, scores[0]):
        return "low"
    medium_threshold = np.percentile(scores, 90)
    if score >= high_threshold:
        return "high"
    if score >= medium_threshold:
        return "med"
    return "low"


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
    df = _load_data(path)
    if "Session Time" not in df.columns:
        raise ValueError("Input file must include a 'Session Time' column.")

    timestamps = _parse_session_time(df["Session Time"])
    order = np.argsort(timestamps)
    df = df.iloc[order].reset_index(drop=True)
    timestamps = timestamps[order]

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

    threshold = np.percentile(timeline_scores, threshold_percentile) if n_rows > 0 else 0.0
    segments = _group_segments(
        timestamps, timeline_scores, timeline_feature_scores, feature_names, threshold
    )

    if not segments:
        segments = _build_review_segments(
            timestamps, timeline_scores, timeline_feature_scores, feature_names
        )

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

    if np.allclose(timeline_scores, timeline_scores[0]):
        flagged_mask = np.zeros_like(timeline_scores, dtype=bool)
    else:
        flagged_mask = timeline_scores >= threshold

    for segment in segments:
        start_time = segment.get("start_time")
        end_time = segment.get("end_time")
        if start_time is None or end_time is None:
            continue
        flagged_mask |= (timestamps >= start_time) & (timestamps <= end_time)

    baseline_mask = ~flagged_mask
    baseline_df = numeric_df[baseline_mask]
    if baseline_df.empty:
        baseline_df = numeric_df

    baseline_stats: Dict[str, Dict[str, float]] = {}
    for name in feature_names:
        values = baseline_df[name].to_numpy(dtype=float)
        if values.size == 0:
            continue
        baseline_stats[name] = {
            "baseline_p5": float(np.percentile(values, 5)),
            "baseline_p95": float(np.percentile(values, 95)),
            "baseline_median": float(np.median(values)),
        }

    for segment in segments:
        start_time = segment.get("start_time")
        end_time = segment.get("end_time")
        if start_time is None or end_time is None:
            continue
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

    summary = {
        "n_rows": int(n_rows),
        "n_params_used": int(len(feature_names)),
        "segments_found": int(len(segments)),
        "top_parameters": top_parameters,
        "flaggedRowCount": flagged_row_count,
        "flaggedPercent": round(flagged_percent, 4),
        "window_size": int(window_size),
        "stride": int(stride),
        "threshold_percentile": float(threshold_percentile),
        "threshold_value": float(threshold),
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
