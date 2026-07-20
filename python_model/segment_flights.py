"""
NASA FDR — Flight Segmentation Script
Task 6: Detect and segment multiple flights within one FDR file

Run from:
  C:\\Users\\fatim\\Desktop\\Research Assistant Work\\ACoE\\aviation-recorder-intelligence\\python_model

Usage:
  python segment_flights.py
"""

import scipy.io
import numpy as np
import os
import json
from datetime import datetime

# ── CONFIG ────────────────────────────────────────────────────────────────────
DATA_DIR = r"C:\Users\fatim\Desktop\Current pending papers\FDR phase 2\data\nasa_fdr_sample\Tail_652_7"
OUTPUT_DIR = r"C:\Users\fatim\Desktop\Research Assistant Work\ACoE\aviation-recorder-intelligence\python_model\fdr_segments"

# Minimum samples to count as a real flight (avoids tiny blips)
# At 4Hz sampling, 4836 samples ≈ ~20 minutes
MIN_FLIGHT_SAMPLES = 500

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── HELPER: Extract raw array from NASA .mat struct ───────────────────────────
def extract(mat, key):
    """NASA stores each param as a tuple: (data, sample_rate, unit, description, name)"""
    try:
        val = mat[key]
        # It's a structured array — get the first element (the actual data array)
        data = val[0][0][0]
        return data.flatten().astype(float)
    except Exception as e:
        return None

# ── HELPER: Build GMT timestamp array ────────────────────────────────────────
def build_time_array(mat, n_samples):
    """Reconstruct a time index in seconds from GMT_HOUR, GMT_MINUTE, GMT_SEC."""
    try:
        hours   = extract(mat, 'GMT_HOUR')
        minutes = extract(mat, 'GMT_MINUTE')
        seconds = extract(mat, 'GMT_SEC')

        # These are sampled at 2Hz (shape 9672) vs WOW at 1Hz (shape 4836)
        # Resample to match WOW length
        def resample(arr, target_len):
            indices = np.linspace(0, len(arr) - 1, target_len).astype(int)
            return arr[indices]

        h = resample(hours,   n_samples)
        m = resample(minutes, n_samples)
        s = resample(seconds, n_samples)

        time_seconds = h * 3600 + m * 60 + s
        return time_seconds
    except:
        return np.arange(n_samples)  # fallback: sample index

# ── HELPER: Format seconds to HH:MM:SS ───────────────────────────────────────
def fmt_time(sec):
    sec = int(sec) % 86400
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

# ── MAIN SEGMENTATION FUNCTION ────────────────────────────────────────────────
def segment_file(filepath):
    filename = os.path.basename(filepath)
    mat = scipy.io.loadmat(filepath)

    # Weight On Wheels: 1 = on ground, 0 = airborne
    wow = extract(mat, 'WOW')
    if wow is None:
        print(f"  ⚠️  WOW not found in {filename}, skipping.")
        return []

    n = len(wow)
    time_s = build_time_array(mat, n)

    # Load key parameters (resampled to WOW length)
    def get_param(key, target_len=n):
        arr = extract(mat, key)
        if arr is None:
            return np.full(target_len, np.nan)
        if len(arr) != target_len:
            idx = np.linspace(0, len(arr) - 1, target_len).astype(int)
            arr = arr[idx]
        return arr

    alt   = get_param('ALT')
    cas   = get_param('CAS')
    roll  = get_param('ROLL')
    latp  = get_param('LATP')
    lonp  = get_param('LONP')

    # ── DETECT FLIGHT SEGMENTS ────────────────────────────────────────────────
    # A flight = continuous block where WOW == 0 (wheels off ground)
    in_air = (wow == 0).astype(int)

    segments = []
    i = 0
    while i < n:
        if in_air[i] == 1:
            start = i
            while i < n and in_air[i] == 1:
                i += 1
            end = i - 1
            length = end - start + 1

            if length >= MIN_FLIGHT_SAMPLES:
                seg_alt  = alt[start:end+1]
                seg_cas  = cas[start:end+1]
                seg_lat  = latp[start:end+1]
                seg_lon  = lonp[start:end+1]

                segment = {
                    "segment_id":    len(segments) + 1,
                    "file":          filename,
                    "start_idx":     int(start),
                    "end_idx":       int(end),
                    "duration_samples": int(length),
                    "duration_min":  round(length / 4 / 60, 1),  # ~4Hz effective
                    "start_time":    fmt_time(time_s[start]),
                    "end_time":      fmt_time(time_s[end]),
                    "max_alt_ft":    round(float(np.nanmax(seg_alt)), 0),
                    "avg_cas_kts":   round(float(np.nanmean(seg_cas)), 1),
                    "start_lat":     round(float(seg_lat[0]),  6),
                    "start_lon":     round(float(seg_lon[0]),  6),
                    "end_lat":       round(float(seg_lat[-1]), 6),
                    "end_lon":       round(float(seg_lon[-1]), 6),
                }
                segments.append(segment)
        else:
            i += 1

    return segments

# ── PROCESS ALL FILES ─────────────────────────────────────────────────────────
mat_files = sorted([f for f in os.listdir(DATA_DIR) if f.endswith('.mat')])

print(f"🛫 NASA FDR Flight Segmentation — Tail_652_7")
print(f"   Files to process : {len(mat_files)}")
print(f"   Output dir       : {OUTPUT_DIR}")
print(f"   Min flight size  : {MIN_FLIGHT_SAMPLES} samples\n")

all_segments = []
total_flights = 0

for idx, fname in enumerate(mat_files):
    fpath = os.path.join(DATA_DIR, fname)
    try:
        segs = segment_file(fpath)
        if segs:
            total_flights += len(segs)
            all_segments.extend(segs)
            print(f"  [{idx+1:>3}/{len(mat_files)}] {fname}  →  {len(segs)} flight(s) detected")
            for s in segs:
                print(f"          ✈  Segment {s['segment_id']}: {s['start_time']} → {s['end_time']} "
                      f"| {s['duration_min']} min | Max alt: {s['max_alt_ft']} ft | Avg CAS: {s['avg_cas_kts']} kts")
        else:
            print(f"  [{idx+1:>3}/{len(mat_files)}] {fname}  →  no valid flights")
    except Exception as e:
        print(f"  [{idx+1:>3}/{len(mat_files)}] {fname}  →  ❌ ERROR: {e}")

# ── SAVE RESULTS ──────────────────────────────────────────────────────────────
out_path = os.path.join(OUTPUT_DIR, "segments_tail652_7.json")
with open(out_path, "w") as f:
    json.dump(all_segments, f, indent=2)

print(f"\n── Summary ─────────────────────────────────────────")
print(f"  Total .mat files processed : {len(mat_files)}")
print(f"  Total flight segments found: {total_flights}")
print(f"  Results saved to           : {out_path}")
print(f"\nNext: run segment_flights.py and paste the summary here → we'll build Task 7 (phase detection) 🚀")
