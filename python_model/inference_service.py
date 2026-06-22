"""FastAPI inference service for the anomaly detection model."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Ensure the project root is on the path so segment module is importable
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from services.fdr_anomaly.segment import detect_flights_from_rows  # noqa: E402
from services.fdr_anomaly.phase import detect_phases_from_rows  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="FDR Anomaly Detection Service", version="1.0.0")


class PredictRequest(BaseModel):
    rows: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Rows of flight data with a timestamp and feature values",
    )

    class Config:
        extra = "allow"


class PredictResponse(BaseModel):
    total_rows: int
    evaluated_rows: int
    anomaly_count: int
    anomaly_percentage: float | None
    features: List[str]
    anomalies: List[Dict[str, Any]]
    scores: List[Dict[str, Any]]


class Artifacts:
    def __init__(self) -> None:
        self.model = None
        self.scaler = None
        self.features: List[str] = []

    def load(self) -> None:
        try:
            self.model = joblib.load(BASE_DIR / "model.joblib")
            self.scaler = joblib.load(BASE_DIR / "scaler.joblib")
            self.features = list(joblib.load(BASE_DIR / "features.joblib"))
        except FileNotFoundError as exc:
            raise RuntimeError(
                "Model artifacts are missing. Train the model with train_model.py first."
            ) from exc


ARTIFACTS = Artifacts()


@app.on_event("startup")
def _load_artifacts() -> None:
    ARTIFACTS.load()


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


def _normalize_rows(payload_rows: List[Dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(payload_rows)
    if "timestamp" not in df.columns:
        df["timestamp"] = pd.NA

    df["timestamp"] = df["timestamp"].replace("", pd.NA)
    df = df.dropna(subset=["timestamp"]).reset_index(drop=True)
    return df


def _prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    feature_frames = {}
    for feature in ARTIFACTS.features:
        series = df[feature] if feature in df.columns else pd.Series([pd.NA] * len(df))
        feature_frames[feature] = pd.to_numeric(series, errors="coerce")

    feature_df = pd.DataFrame(feature_frames)
    return feature_df[ARTIFACTS.features]


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest) -> PredictResponse:
    if not ARTIFACTS.model or not ARTIFACTS.scaler:
        raise HTTPException(status_code=500, detail="Model artifacts are not loaded")

    normalized = _normalize_rows(request.rows)
    if normalized.empty:
        raise HTTPException(status_code=400, detail="No valid rows supplied (missing timestamps)")

    feature_df = _prepare_features(normalized)
    scaled_features = ARTIFACTS.scaler.transform(feature_df)

    predictions = ARTIFACTS.model.predict(scaled_features)
    scores = ARTIFACTS.model.decision_function(scaled_features)

    response_scores: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []

    for idx, (label, score) in enumerate(zip(predictions, scores)):
        base_row = feature_df.iloc[idx]
        result = {
            "index": int(idx),
            "timestamp": str(normalized.iloc[idx].get("timestamp")),
            "score": float(score),
            "is_anomaly": bool(label == -1),
            "values": {name: None if pd.isna(value) else float(value) for name, value in base_row.items()},
        }
        response_scores.append(result)
        if result["is_anomaly"]:
            anomalies.append(result)

    evaluated_rows = len(feature_df)
    anomaly_percentage = None
    if evaluated_rows:
        anomaly_percentage = (len(anomalies) / evaluated_rows) * 100

    return PredictResponse(
        total_rows=len(request.rows),
        evaluated_rows=evaluated_rows,
        anomaly_count=len(anomalies),
        anomaly_percentage=anomaly_percentage,
        features=ARTIFACTS.features,
        anomalies=anomalies,
        scores=response_scores,
    )


# ── /segment endpoint (Task 6: GA-adaptive flight segmentation) ───────────────

class SegmentRequest(BaseModel):
    rows: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Rows of flight data including Session Time and sensor columns",
    )

    class Config:
        extra = "allow"


class FlightSegment(BaseModel):
    flight_index: int
    start_time: float
    end_time: float
    duration_s: float
    duration_min: float
    max_altitude_ft: Optional[float] = None
    avg_ias_knots: Optional[float] = None
    start_lat: Optional[float] = None
    start_lon: Optional[float] = None
    end_lat: Optional[float] = None
    end_lon: Optional[float] = None


class SegmentResponse(BaseModel):
    n_rows: int
    segments: List[FlightSegment]
    detection_method: str
    detection_badge: str


@app.post("/segment", response_model=SegmentResponse)
def segment(request: SegmentRequest) -> SegmentResponse:
    if not request.rows:
        raise HTTPException(status_code=400, detail="No rows supplied.")
    try:
        result = detect_flights_from_rows(request.rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return SegmentResponse(
        n_rows=result["n_rows"],
        segments=[FlightSegment(**s) for s in result["segments"]],
        detection_method=result["detection_method"],
        detection_badge=result["detection_badge"],
    )


# ── /phases endpoint (Task 7: GA flight phase detection) ──────────────────────

class PhaseRequest(BaseModel):
    rows: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Rows of flight data including Session Time and sensor columns",
    )

    class Config:
        extra = "allow"


class FlightPhase(BaseModel):
    phase: str
    start_time: float
    end_time: float
    duration_s: float


class PhaseResponse(BaseModel):
    n_rows: int
    phases: List[FlightPhase]
    detection_method: str
    detection_badge: str


@app.post("/phases", response_model=PhaseResponse)
def phases(request: PhaseRequest) -> PhaseResponse:
    if not request.rows:
        raise HTTPException(status_code=400, detail="No rows supplied.")
    try:
        result = detect_phases_from_rows(request.rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return PhaseResponse(
        n_rows=result["n_rows"],
        phases=[FlightPhase(**p) for p in result["phases"]],
        detection_method=result["detection_method"],
        detection_badge=result["detection_badge"],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("inference_service:app", host="127.0.0.1", port=8000, reload=False)