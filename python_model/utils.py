"""Utility helpers for the Python anomaly detection model.

This module keeps feature definitions and reusable preprocessing logic so that
training and inference stay consistent.
"""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Iterable, List, Mapping, Sequence

import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

# Feature names must stay aligned with the JS configuration (Prompt 1)
# and the CSV headers present in docs/Data_Samples/EXAMPLE FDR_with anomaly.csv.
FEATURE_MAP: "OrderedDict[str, str]" = OrderedDict(
    [
        ("GPS Altitude", "GPS Altitude (feet)"),
        ("Pressure Altitude", "Pressure Altitude (ft)"),
        ("Indicated Airspeed", "Indicated Airspeed (knots)"),
        ("Ground Speed", "Ground Speed (knots)"),
        ("True Airspeed", "True Airspeed (knots)"),
        ("Vertical Speed", "Vertical Speed (ft/min)"),
        ("Pitch", "Pitch (deg)"),
        ("Roll", "Roll (deg)"),
        ("Magnetic Heading", "Magnetic Heading (deg)"),
        ("RPM Left", "RPM L"),
        ("RPM Right", "RPM R"),
        ("Fuel Flow 1", "Fuel Flow 1 (gal/hr)"),
        ("Outside Air Temperature", "OAT (deg C)"),
        ("Latitude", "Latitude (deg)"),
        ("Longitude", "Longitude (deg)"),
    ]
)

DEFAULT_TIMESTAMP_FIELDS: Sequence[str] = (
    "GPS Date & Time",
    "Session Time",
    "System Time",
)


def get_feature_names() -> List[str]:
    """Return the ordered list of normalized feature names used by the model."""

    return list(FEATURE_MAP.keys())


def resolve_dataset_path(csv_path: str | Path | None = None) -> Path:
    """Resolve the dataset path for training.

    Parameters
    ----------
    csv_path: str | Path | None
        Optional override to point the training job to a different CSV file.
    """

    if csv_path:
        return Path(csv_path).expanduser().resolve()

    repo_root = Path(__file__).resolve().parent.parent
    return repo_root / "docs" / "Data_Samples" / "EXAMPLE FDR_with anomaly.csv"


def add_timestamp_column(df: pd.DataFrame, timestamp_fields: Iterable[str] = DEFAULT_TIMESTAMP_FIELDS) -> pd.DataFrame:
    """Create a `timestamp` column and drop rows where it is missing."""

    timestamp_series = None
    for field in timestamp_fields:
        if field in df.columns:
            timestamp_series = df[field]
            if timestamp_series.notna().any():
                break

    if timestamp_series is None:
        df = df.copy()
        df["timestamp"] = pd.NA
    else:
        df = df.copy()
        df["timestamp"] = timestamp_series

    df["timestamp"] = df["timestamp"].replace("", pd.NA)
    return df.dropna(subset=["timestamp"]).reset_index(drop=True)


def build_feature_dataframe(df: pd.DataFrame, feature_map: Mapping[str, str] = FEATURE_MAP) -> pd.DataFrame:
    """Select and coerce the configured features from a DataFrame.

    All numeric columns are coerced with ``errors="coerce"`` to ensure
    downstream preprocessing can impute and scale missing values.
    """

    feature_frames = {}
    for feature_name, column in feature_map.items():
        series = df[column] if column in df.columns else pd.Series([pd.NA] * len(df))
        feature_frames[feature_name] = pd.to_numeric(series, errors="coerce")

    return pd.DataFrame(feature_frames)


def create_preprocess_pipeline() -> Pipeline:
    """Build the preprocessing pipeline shared between training and inference."""

    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
        ]
    )


__all__ = [
    "DEFAULT_TIMESTAMP_FIELDS",
    "FEATURE_MAP",
    "add_timestamp_column",
    "build_feature_dataframe",
    "create_preprocess_pipeline",
    "get_feature_names",
    "resolve_dataset_path",
]