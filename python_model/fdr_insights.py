"""
NASA FDR — Full Parameter Insights & Data Quality Report
Auto-detects .mat struct layout, parses all 186 parameters,
groups by category, and gives preprocessing recommendations.

Run from:
  python_model/
Usage:
  python fdr_insights.py
"""

import scipy.io
import numpy as np
import os
from collections import defaultdict

DATA_DIR = r"C:\Users\fatim\Desktop\Current pending papers\FDR phase 2\data\nasa_fdr_sample\Tail_652_7"

mat_files = sorted([f for f in os.listdir(DATA_DIR) if f.endswith('.mat')])
first_file = os.path.join(DATA_DIR, mat_files[0])
print(f"📂 Loading: {mat_files[0]}\n")
mat = scipy.io.loadmat(first_file, squeeze_me=False)
params = {k: v for k, v in mat.items() if not k.startswith("__")}

# ── AUTO-DETECT STRUCT LAYOUT ─────────────────────────────────────────────────
print("🔬 AUTO-DETECTING STRUCT LAYOUT...\n")

def smart_extract(val):
    """
    Try every known NASA .mat struct layout and return
    (data, sample_rate, units, description) or raise.
    NASA FOQA structs vary — some have 4 fields, some 5, some are nested differently.
    """
    data        = None
    sample_rate = 0.0
    units       = "?"
    description = "?"

    # ── Layout A: val[0][0] is a structured array with named fields ───────────
    # Common in newer scipy loadmat with squeeze_me=False
    try:
        inner = val[0][0]
        # Named fields (dtype.names)?
        if inner.dtype.names:
            names = inner.dtype.names
            # data is first named field
            data = inner[names[0]].flatten().astype(float)
            if len(names) > 1:
                try: sample_rate = float(inner[names[1]].flatten()[0])
                except: pass
            if len(names) > 2:
                try: units = str(inner[names[2]]).strip()
                except: pass
            if len(names) > 3:
                try: description = str(inner[names[3]]).strip()
                except: pass
            if data is not None:
                return data, sample_rate, units, description
    except:
        pass

    # ── Layout B: val[0][0][0] is the data array (original assumption) ────────
    try:
        data = val[0][0][0].flatten().astype(float)
        try: sample_rate = float(val[0][0][1].flatten()[0])
        except: pass
        try: units = str(val[0][0][2]).strip()
        except: pass
        try: description = str(val[0][0][3]).strip()
        except: pass
        return data, sample_rate, units, description
    except:
        pass

    # ── Layout C: val itself is a plain array ─────────────────────────────────
    try:
        data = np.array(val).flatten().astype(float)
        return data, 0.0, "?", "?"
    except:
        pass

    # ── Layout D: val[0] is the data ──────────────────────────────────────────
    try:
        data = val[0].flatten().astype(float)
        return data, 0.0, "?", "?"
    except:
        pass

    raise ValueError("No known layout matched")


# Print layout debug for first param so we can verify
first_key = list(params.keys())[0]
first_val = params[first_key]
print(f"  Sample param: {first_key}")
print(f"  val.shape         : {first_val.shape}  dtype: {first_val.dtype}")
try:
    inner = first_val[0][0]
    print(f"  val[0][0].shape   : {inner.shape}  dtype: {inner.dtype}")
    print(f"  val[0][0].names   : {inner.dtype.names}")
    for i, name in enumerate(inner.dtype.names or []):
        field = inner[name]
        print(f"    field '{name}': shape={field.shape}  preview={str(field.flat[0])[:60]}")
except Exception as e:
    print(f"  inner inspect failed: {e}")
print()

# ── STEP 1: PARSE ALL PARAMETERS ─────────────────────────────────────────────
print(f"{'='*90}")
print(f"  STEP 1 — ALL {len(params)} PARAMETERS")
print(f"{'='*90}\n")

parsed = {}
for key, val in params.items():
    try:
        data, sample_rate, units, description = smart_extract(val)

        nan_count = int(np.sum(np.isnan(data)))
        nan_pct   = round(nan_count / len(data) * 100, 1)
        valid     = data[~np.isnan(data)]
        is_const  = (len(valid) > 0 and float(np.std(valid)) < 1e-6)
        is_binary = (len(valid) > 0 and len(np.unique(valid)) <= 2)

        parsed[key] = {
            "key":         key,
            "description": description,
            "units":       units,
            "sample_rate": sample_rate,
            "n_samples":   len(data),
            "min":         round(float(np.nanmin(data)), 3) if len(valid) > 0 else "NaN",
            "max":         round(float(np.nanmax(data)), 3) if len(valid) > 0 else "NaN",
            "mean":        round(float(np.nanmean(data)), 3) if len(valid) > 0 else "NaN",
            "std":         round(float(np.nanstd(data)),  3) if len(valid) > 0 else "NaN",
            "nan_pct":     nan_pct,
            "is_constant": is_const,
            "is_binary":   is_binary,
            "data":        data
        }
    except Exception as e:
        parsed[key] = {"key": key, "error": str(e)}

# ── PRINT FULL TABLE ──────────────────────────────────────────────────────────
print(f"  {'#':<4} {'Key':<14} {'Hz':<5} {'N':<8} {'Min':<11} {'Max':<11} {'Mean':<11} {'Std':<11} {'NaN%':<6} {'Flags':<20} Description")
print(f"  {'-'*4} {'-'*14} {'-'*5} {'-'*8} {'-'*11} {'-'*11} {'-'*11} {'-'*11} {'-'*6} {'-'*20} {'-'*35}")

ok_count  = 0
err_count = 0

for i, (key, p) in enumerate(parsed.items(), 1):
    if "error" in p:
        print(f"  {i:<4} {key:<14} ❌  {p['error']}")
        err_count += 1
        continue

    ok_count += 1
    flags = []
    if p["is_constant"]: flags.append("CONSTANT")
    if p["is_binary"]:   flags.append("BINARY")
    if p["nan_pct"] > 50: flags.append("HIGH_NAN")
    elif p["nan_pct"] > 0: flags.append("HAS_NAN")
    flag_str = ",".join(flags) if flags else "OK"

    desc = str(p["description"])[:35] if p["description"] != "?" else "(no description)"

    print(f"  {i:<4} {key:<14} {p['sample_rate']:<5} {p['n_samples']:<8} "
          f"{str(p['min']):<11} {str(p['max']):<11} {str(p['mean']):<11} {str(p['std']):<11} "
          f"{p['nan_pct']:<6} {flag_str:<20} {desc}")

print(f"\n  ✅ Parsed OK: {ok_count}   ❌ Failed: {err_count}\n")


# ── STEP 2: GROUP BY CATEGORY ─────────────────────────────────────────────────
print(f"\n{'='*90}")
print(f"  STEP 2 — PARAMETERS BY CATEGORY")
print(f"{'='*90}\n")

# Updated with actual NASA FOQA param names (underscore variants)
CATEGORIES = {
    "🛫 Flight Dynamics": [
        'ALT','ALTR','RALT','CALT','CAS','CASM','TAS','MACH',
        'IVV','VRTG','LONG','LATG','PTCH','ROLL','RUDD',
        'AOA1','AOA2','AOAI','AOAC','GS','WS','WD'
    ],
    "⚙️  Engine": [
        'N1_1','N1_2','N1_3','N1_4','N1T','N1C','N1CO',
        'N2_1','N2_2','N2_3','N2_4',
        'EGT_1','EGT_2','EGT_3','EGT_4',
        'FF_1','FF_2','FF_3','FF_4',
        'PLA_1','PLA_2','PLA_3','PLA_4',
        'VIB_1','VIB_2','VIB_3','VIB_4',
        'OIT_1','OIT_2','OIT_3','OIT_4',
        'OIP_1','OIP_2','OIP_3','OIP_4',
        'OIPL','FIRE_1','FIRE_2','FIRE_3','FIRE_4',
        'ECYC_1','ECYC_2','ECYC_3','ECYC_4',
        'EHRS_1','EHRS_2','EHRS_3','EHRS_4',
        'ESN_1','ESN_2','ESN_3','ESN_4'
    ],
    "🛬 Gear / Flaps / Controls": [
        'WOW','FLAP','LGDN','LGUP','ABRK',
        'AIL_1','AIL_2','ELEV_1','ELEV_2',
        'SPL_1','SPL_2','SPLY','SPLG',
        'CCPC','CCPF','CWPC','CWPF','RUDP','PTRM'
    ],
    "🧭 Navigation / Time": [
        'LATP','LONP','GMT_HOUR','GMT_MINUTE','GMT_SEC',
        'DATE_YEAR','DATE_MONTH','DATE_DAY','ACMT',
        'MH','TH','TRK','TRKM','DA','TMAG'
    ],
    "🌡️  Environmental": [
        'TAT','SAT','DWPT','DISA','PSA','PI','PS','PT','PH'
    ],
    "⚡ Autopilot / FMS": [
        'APFD','MACH','HDGS','ALTS','CASS','VSPS','CRSS',
        'VMODE','LMOD','A_T','MNS','SNAP','LOC','GLS',
        'FPAC','BLAC','CTAC','FGC3','ILSF','DFGS'
    ],
    "📡 Radio / Comms": [
        'VHF1','VHF2','VHF3','HF1','HF2'
    ],
    "⚠️  Warnings / Safety": [
        'TCAS','GPWS','WSHR','SHKR','PUSH',
        'SMOK','SMKB','WAI_1','WAI_2','TAI','EAI',
        'EVNT','MRK','MSQT_1','MSQT_2','NSQT','DVER_1','DVER_2'
    ],
    "🔧 Systems / Misc": [
        'FQTY_1','FQTY_2','FQTY_3','FQTY_4',
        'HYDY','HYDG','PACK','BLV','BAL1','BAL2',
        'APUF','TOCW','ACID','FRMC','FADF','FADS',
        'ATEN','TMODE','SPLY','OIPL',
        'VAR_1107','VAR_2670','VAR_5107','VAR_6670',
        'POVT','MW','AOAI'
    ],
}

found_in_category = set()
for cat, keys in CATEGORIES.items():
    found   = [k for k in keys if k in parsed and "error" not in parsed[k]]
    errored = [k for k in keys if k in parsed and "error" in parsed[k]]
    missing = [k for k in keys if k not in parsed]
    found_in_category.update(found)

    print(f"  {cat}  ({len(found)} found)")
    if found:
        # Show with sample rate
        details = [f"{k}@{parsed[k]['sample_rate']}Hz" for k in found]
        for j in range(0, len(details), 6):
            print(f"    ✅  {', '.join(details[j:j+6])}")
    if errored:
        print(f"    ⚠️  Parse error: {', '.join(errored)}")
    if missing:
        print(f"    ❌  Not in file: {', '.join(missing)}")
    print()

uncategorized = [k for k in parsed if k not in found_in_category and "error" not in parsed[k]]
if uncategorized:
    print(f"  📦 Uncategorized ({len(uncategorized)} params):")
    for j in range(0, len(uncategorized), 10):
        print(f"    {', '.join(uncategorized[j:j+10])}")
    print()


# ── STEP 3: SAMPLE RATE DISTRIBUTION ─────────────────────────────────────────
print(f"\n{'='*90}")
print(f"  STEP 3 — SAMPLE RATE DISTRIBUTION")
print(f"{'='*90}\n")

rate_groups = defaultdict(list)
for key, p in parsed.items():
    if "error" not in p:
        rate_groups[p["sample_rate"]].append(key)

for rate in sorted(rate_groups.keys()):
    keys = rate_groups[rate]
    sample_count = parsed[keys[0]]["n_samples"]
    print(f"  {rate} Hz  →  {len(keys):>3} params  ({sample_count} samples each)")
    for j in range(0, len(keys), 12):
        print(f"    {', '.join(keys[j:j+12])}")
    print()

ref_key   = next((k for k in ['WOW','ALT','CAS'] if k in parsed and "error" not in parsed[k]), None)
ref_len   = parsed[ref_key]["n_samples"] if ref_key else "?"
ref_rate  = parsed[ref_key]["sample_rate"] if ref_key else "?"
print(f"  📌 Reference signal : {ref_key}  →  {ref_len} samples @ {ref_rate}Hz")
print(f"     All other params should be resampled to this length before ML\n")


# ── STEP 4: DATA QUALITY REPORT ───────────────────────────────────────────────
print(f"{'='*90}")
print(f"  STEP 4 — DATA QUALITY REPORT")
print(f"{'='*90}\n")

ok_params      = [k for k,p in parsed.items() if "error" not in p]
constants      = [k for k in ok_params if parsed[k]["is_constant"]]
high_nan       = [k for k in ok_params if parsed[k]["nan_pct"] > 50]
some_nan       = [k for k in ok_params if 0 < parsed[k]["nan_pct"] <= 50]
binary         = [k for k in ok_params if parsed[k]["is_binary"] and not parsed[k]["is_constant"]]
clean          = [k for k in ok_params if not parsed[k]["is_constant"] and parsed[k]["nan_pct"] == 0 and not parsed[k]["is_binary"]]

print(f"  Total params         : {len(params)}")
print(f"  ✅ Parsed OK          : {len(ok_params)}")
print(f"  ❌ Parse errors       : {len(params) - len(ok_params)}")
print()
print(f"  ✅ Clean continuous   : {len(clean)} params  → ready for ML as-is")
print(f"  🔘 Binary/discrete    : {len(binary)} params  → use as categorical features")
print(f"  ⚠️  Has NaNs (≤50%)   : {len(some_nan)} params  → linear interpolation")
print(f"  🔴 High NaN (>50%)    : {len(high_nan)} params  → drop from ML")
print(f"  📌 Constant           : {len(constants)} params  → drop from ML (zero variance)")
print()

if high_nan:
    print(f"  🔴 High NaN params  : {high_nan}")
if constants:
    print(f"  📌 Constant params  : {constants[:20]}{'...' if len(constants)>20 else ''}")
if binary:
    print(f"  🔘 Binary params    : {binary}")
if some_nan:
    print(f"  ⚠️  Some NaN params  : {some_nan}")


# ── STEP 5: BEST PARAMS FOR EACH TASK ────────────────────────────────────────
print(f"\n{'='*90}")
print(f"  STEP 5 — RECOMMENDED PARAMS PER TASK (based on what's actually in the file)")
print(f"{'='*90}\n")

def check(keys):
    return [k for k in keys if k in parsed and "error" not in parsed[k]]

task7_primary   = check(['ALT','CAS','WOW','IVV','VRTG'])
task7_secondary = check(['PTCH','ROLL','FLAP','RALT','GS','TAS'])
task9_features  = check(['ALT','CAS','TAS','MACH','IVV','VRTG','PTCH','ROLL','LONG','LATG',
                          'AOA1','AOA2','AOAC','N1_1','N1_2','N1_3','N1_4',
                          'EGT_1','EGT_2','FF_1','FF_2','FLAP','RALT'])
task13_map      = check(['LATP','LONP','ALT','CAS','TAS','GMT_HOUR','GMT_MINUTE','GMT_SEC'])

print(f"  Task 7  — Phase Detection")
print(f"    Primary   : {task7_primary}")
print(f"    Secondary : {task7_secondary}\n")

print(f"  Task 9  — Per-phase Anomaly Baselines")
print(f"    Features  : {task9_features}\n")

print(f"  Task 13 — Map Track")
print(f"    Params    : {task13_map}\n")


# ── STEP 6: PREPROCESSING PIPELINE ───────────────────────────────────────────
print(f"{'='*90}")
print(f"  STEP 6 — PREPROCESSING PIPELINE RECOMMENDATION")
print(f"{'='*90}\n")

if ref_key:
    print(f"""  Step 1 — RESAMPLE to common length
    Reference: {ref_key} at {ref_rate}Hz ({ref_len} samples)
    All params sampled at different rates → resample using np.interp to {ref_len} samples

  Step 2 — DROP useless params
    Drop {len(constants)} constant params  (zero variance, useless for ML)
    Drop {len(high_nan)} high-NaN params   (>50% missing, unreliable)

  Step 3 — INTERPOLATE NaNs
    {len(some_nan)} params have some NaNs → linear interpolation (np.interp)
    For edge NaNs (start/end), use forward/backward fill

  Step 4 — SEGMENT by flight (Task 6 output JSON)
    Use segments_tail652_7.json to slice each param into per-flight arrays

  Step 5 — LABEL phases (Task 7)
    Within each flight, label every sample: TAKEOFF / CLIMB / CRUISE / DESCENT / LANDING

  Step 6 — NORMALIZE per phase (critical for Task 9)
    z-score = (x - phase_mean) / phase_std
    Do NOT normalize globally — a "normal" ALT in cruise is very different from takeoff

  Step 7 — BUILD feature matrix
    Shape: (n_samples, n_features)  where n_features = {len(task9_features)}
    Features: {task9_features}
""")


# ── STEP 7: CROSS-FILE STABILITY ─────────────────────────────────────────────
print(f"{'='*90}")
print(f"  STEP 7 — CROSS-FILE PARAM STABILITY (first 5 files)")
print(f"{'='*90}\n")

check_params = ['ALT','CAS','WOW','PTCH','ROLL','IVV','N1_1','N1_2','EGT_1','FLAP','LATP','LONP']

print(f"  {'File':<38}", end="")
for k in check_params:
    print(f" {k:<9}", end="")
print()
print(f"  {'-'*38}", end="")
for k in check_params:
    print(f" {'-'*9}", end="")
print()

for fname in mat_files[:5]:
    fpath = os.path.join(DATA_DIR, fname)
    try:
        m = scipy.io.loadmat(fpath, squeeze_me=False)
        print(f"  {fname:<38}", end="")
        for k in check_params:
            if k not in m:
                print(f" {'❌':<9}", end="")
                continue
            try:
                d, _, _, _ = smart_extract(m[k])
                print(f" ✅{len(d):<7}", end="")
            except:
                print(f" {'⚠️ err':<9}", end="")
        print()
    except Exception as e:
        print(f"  {fname:<38} ❌ {e}")

print(f"\n{'='*90}")
print(f"  ✅ INSIGHTS COMPLETE")
print(f"{'='*90}\n")