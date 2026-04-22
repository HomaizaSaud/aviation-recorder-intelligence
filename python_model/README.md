# Python Anomaly Detection Service

This folder hosts the Python-based anomaly detection pipeline for the CVR/FDR analyzer. It replaces the previous pseudo-AI scoring with a reproducible training workflow and a FastAPI inference service.

## Dependencies

Install Python requirements:

```bash
pip install -r requirements.txt
```

## Training

Run the trainer against the sample dataset (or provide your own CSV):

```bash
python train_model.py --csv ../docs/Data_Samples/EXAMPLE\ FDR_with\ anomaly.csv
```

Artifacts are saved next to the scripts:

- `model.joblib` – trained Isolation Forest
- `scaler.joblib` – preprocessing pipeline (median imputer + standard scaler)
- `features.joblib` – ordered list of feature names (aligned with the JS config)

If you retrain later, simply re-run `train_model.py` to overwrite the artifacts. Keep the feature names synchronized with the JS configuration to prevent API mismatches.

## Inference API

Start the FastAPI service (defaults to port 8000):

```bash
uvicorn inference_service:app --host 0.0.0.0 --port 8000
```

Endpoints:

- `GET /health` — liveness check
- `POST /predict` — accept JSON rows shaped as:

```json
{
  "rows": [
    {
      "timestamp": "2024-05-12T00:00:00Z",
      "GPS Altitude": 1234,
      "Pressure Altitude": 1200,
      "Indicated Airspeed": 80,
      "Ground Speed": 82,
      "True Airspeed": 81,
      "Vertical Speed": 450,
      "Pitch": 3.2,
      "Roll": 1.1,
      "Magnetic Heading": 90,
      "RPM Left": 2500,
      "RPM Right": 2505,
      "Fuel Flow 1": 12.4,
      "Outside Air Temperature": 18,
      "Latitude": 33.94,
      "Longitude": -118.40
    }
  ]
}
```

The response contains anomaly flags, decision scores, and a normalized anomaly count/percentage.

## Backend integration

The Node backend calls `POST /predict` whenever a user clicks **Run Anomaly Detection** in the dashboard. It forwards feature rows (using the same parameter names as the JS config), receives anomaly decisions from the Python service, and relays the results back to the React UI.