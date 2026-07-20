"""
NASA FDR — Data Explorer
Run this before any processing to understand what's in the .mat files.

Run from:
  C:\\Users\\fatim\\Desktop\\Research Assistant Work\\ACoE\\aviation-recorder-intelligence\\python_model
"""

import scipy.io
import numpy as np
import os

DATA_DIR = r"C:\Users\fatim\Desktop\Current pending papers\FDR phase 2\data\nasa_fdr_sample\Tail_652_7"

# ── Pick first 3 files to inspect ─────────────────────────────────────────────
mat_files = sorted([f for f in os.listdir(DATA_DIR) if f.endswith('.mat')])

if not mat_files:
    print("❌ No .mat files found. Check your DATA_DIR path.")
    exit()

print(f"\n🔍 Found {len(mat_files)} .mat files in Tail_652_7\n")
print(f"── First 5 files ──────────────────────────────────────")
for f in mat_files[:5]:
    print(f"   {f}")
print()

# ── LOAD THE FIRST FILE ────────────────────────────────────────────────────────
first_file = os.path.join(DATA_DIR, mat_files[0])
print(f"── Loading: {mat_files[0]} ──────────────────────────────────────")

mat = scipy.io.loadmat(first_file)

# Filter out MATLAB metadata keys (start with __)
params = {k: v for k, v in mat.items() if not k.startswith("__")}

print(f"\n🔢 Parameters found ({len(params)} total):\n")
print(f"   {'Parameter':<35} {'Shape':<20} {'Sample Values'}")
print(f"   {'-'*35} {'-'*20} {'-'*30}")

for key, val in params.items():
    try:
        # NASA .mat struct: (data, sample_rate, units, description, name)
        data        = val[0][0][0].flatten().astype(float)
        sample_rate = val[0][0][1].flatten()[0] if val[0][0].shape[0] > 1 else "?"
        units       = str(val[0][0][2]).strip()       if val[0][0].shape[0] > 2 else "?"
        description = str(val[0][0][3]).strip()       if val[0][0].shape[0] > 3 else "?"

        n       = len(data)
        minv    = round(float(np.nanmin(data)), 2)
        maxv    = round(float(np.nanmax(data)), 2)
        meanv   = round(float(np.nanmean(data)), 2)
        nans    = int(np.sum(np.isnan(data)))

        print(f"   {key:<35} n={n:<6} @{str(sample_rate)+'Hz':<8}  "
              f"min={minv:<10} max={maxv:<10} mean={meanv:<10} "
              f"NaNs={nans}  unit={units}")
        print(f"   {'':35} → {description}")
        print()

    except Exception as e:
        print(f"   {key:<35} ⚠️  Could not parse: {e}\n")

# ── CROSS-FILE CONSISTENCY CHECK ───────────────────────────────────────────────
print(f"\n── Cross-file check (first 10 files) ────────────────────────────────")
print(f"   {'File':<35} {'# Params':<12} {'WOW length':<15} {'ALT length':<15} {'Duration (min)'}")
print(f"   {'-'*35} {'-'*12} {'-'*15} {'-'*15} {'-'*15}")

for fname in mat_files[:10]:
    fpath = os.path.join(DATA_DIR, fname)
    try:
        m = scipy.io.loadmat(fpath)
        p = {k: v for k, v in m.items() if not k.startswith("__")}

        def get_len(key):
            try:
                return len(m[key][0][0][0].flatten())
            except:
                return "N/A"

        wow_len = get_len('WOW')
        alt_len = get_len('ALT')
        dur = round(wow_len / 4 / 60, 1) if isinstance(wow_len, int) else "?"

        print(f"   {fname:<35} {len(p):<12} {str(wow_len):<15} {str(alt_len):<15} {dur}")
    except Exception as e:
        print(f"   {fname:<35} ❌ {e}")

# ── KEY PARAMETERS SUMMARY ─────────────────────────────────────────────────────
KEY_PARAMS = ['WOW', 'ALT', 'CAS', 'ROLL', 'PITCH', 'LATP', 'LONP',
              'GMT_HOUR', 'GMT_MINUTE', 'GMT_SEC',
              'N1L', 'N1R', 'N2L', 'N2R',       # engine speeds
              'HEADING', 'HDG',                   # heading
              'VS', 'VRTG',                       # vertical speed / g
              'AOA1', 'AOA2',                     # angle of attack
              'FLAP', 'FLAPS',                    # flap position
              'IVV', 'RALT']                      # inertial vert vel, radio alt

print(f"\n── Key aviation parameters — present in this file? ──────────────────")
for p in KEY_PARAMS:
    present = "✅" if p in params else "❌"
    if p in params:
        try:
            data = mat[p][0][0][0].flatten().astype(float)
            sr   = mat[p][0][0][1].flatten()[0]
            unit = str(mat[p][0][0][2]).strip()
            print(f"   {present} {p:<12} — {len(data)} samples @ {sr}Hz  unit={unit}")
        except:
            print(f"   {present} {p:<12} — (parse error)")
    else:
        print(f"   {present} {p}")

print(f"\n── WOW signal preview (first 50 values) ─────────────────────────────")
try:
    wow = mat['WOW'][0][0][0].flatten().astype(float)
    preview = ''.join(['▓' if w == 0 else '░' for w in wow[:200]])
    print(f"   ▓=airborne  ░=on ground")
    print(f"   [{preview}]  (first 200 samples)")
    n_air    = int(np.sum(wow == 0))
    n_ground = int(np.sum(wow == 1))
    total    = len(wow)
    print(f"\n   Total samples : {total}  (~{round(total/4/60,1)} min at 4Hz)")
    print(f"   Airborne      : {n_air}  ({round(n_air/total*100,1)}%)")
    print(f"   On ground     : {n_ground}  ({round(n_ground/total*100,1)}%)")
except Exception as e:
    print(f"   ❌ WOW not available: {e}")

print(f"\n✅ Exploration complete. Check the parameter list above before running segment_flights.py\n")