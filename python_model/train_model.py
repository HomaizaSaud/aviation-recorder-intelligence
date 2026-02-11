"""Training script for the Isolation Forest anomaly detector.

Usage:
    python train_model.py [--csv /path/to/EXAMPLE FDR_with anomaly.csv]

The script loads the example CSV, applies preprocessing (numeric coercion,
median imputation, standard scaling), trains an IsolationForest model, and
writes the artifacts to the current directory:

- model.joblib
- scaler.joblib (imputer + scaler pipeline)
- features.joblib (ordered list of feature names)
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from sklearn.ensemble import IsolationForest

from utils import (
    FEATURE_MAP,
    add_timestamp_column,
    build_feature_dataframe,
    create_preprocess_pipeline,
    get_feature_names,
    resolve_dataset_path,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the anomaly detection model")
    parser.add_argument(
        "--csv",
        dest="csv_path",
        default=None,
        help="Optional path to the training CSV file (defaults to repository sample)",
    )
    parser.add_argument(
        "--output-dir",
        dest="output_dir",
        default=Path(__file__).resolve().parent,
        type=Path,
        help="Directory to store trained artifacts",
    )
    return parser.parse_args()


def load_training_data(csv_path: str | Path | None = None) -> pd.DataFrame:
    path = resolve_dataset_path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"Training CSV not found at {path}")

    df = pd.read_csv(path)
    df = add_timestamp_column(df)
    feature_df = build_feature_dataframe(df)
    # Drop rows that are entirely missing after coercion.
    feature_df = feature_df.dropna(how="all")
    return feature_df.reset_index(drop=True)


def train_model(features: pd.DataFrame) -> dict[str, Any]:
    preprocess = create_preprocess_pipeline()
    transformed = preprocess.fit_transform(features)

    model = IsolationForest(
        n_estimators=300,
        contamination="auto",
        random_state=42,
        n_jobs=-1,
    )
    model.fit(transformed)

    return {
        "model": model,
        "scaler": preprocess,
        "features": get_feature_names(),
    }


def persist_artifacts(artifacts: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifacts["model"], output_dir / "model.joblib")
    joblib.dump(artifacts["scaler"], output_dir / "scaler.joblib")
    joblib.dump(artifacts["features"], output_dir / "features.joblib")


if __name__ == "__main__":
    args = parse_args()
    feature_data = load_training_data(args.csv_path)
    artifacts = train_model(feature_data)
    persist_artifacts(artifacts, args.output_dir)

    print(f"Saved model artifacts to {args.output_dir.resolve()}")
    print(f"Trained on {len(feature_data)} rows using features: {', '.join(FEATURE_MAP.keys())}")