"""
scripts/generate_subset.py

Generates a clean 10,000-record subset from the full RAPIDS dataset,
using only occupation strings with confidence >= 95 from reconciliation.

Reads:
  ~/Python/semantic-data-portal/output/reconciliation.csv
  ~/Data/eta_apprenticeship/*.csv

Writes:
  ../data/subset.csv
"""

import pandas as pd
import glob, os, sys

# ── Configuration ─────────────────────────────────────────────────────────────
RECON_CSV   = os.path.expanduser('~/Python/semantic-data-portal/output/reconciliation.csv')
DATA_DIR    = os.path.expanduser('~/Data/eta_apprenticeship')
OUT_DIR     = os.path.join(os.path.dirname(__file__), '..', 'data')
OUT_CSV     = os.path.join(OUT_DIR, 'subset.csv')
SAMPLE_N    = 10_000
SEED        = 42
MIN_CONF    = 95.0

os.makedirs(OUT_DIR, exist_ok=True)

# ── Load reconciliation ───────────────────────────────────────────────────────
print(f'Loading reconciliation results...')
recon = pd.read_csv(RECON_CSV)

high_conf = recon[
    (recon['status'] == 'auto_matched') &
    (recon['confidence'] >= MIN_CONF)
][['raw_occupation', 'soc_code', 'official_title', 'confidence']]

print(f'  Occupation strings with confidence >= {MIN_CONF}: {len(high_conf)}')
print(f'  Confidence distribution:')
print(f'    100.0: {len(high_conf[high_conf["confidence"] == 100.0])}')
print(f'    95-99: {len(high_conf[(high_conf["confidence"] >= 95) & (high_conf["confidence"] < 100)])}')

valid_occupations = set(high_conf['raw_occupation'])

# ── Load RAPIDS chunks ────────────────────────────────────────────────────────
print(f'\nLoading RAPIDS dataset chunks...')
chunks = sorted(glob.glob(os.path.join(DATA_DIR, '*.csv')))
print(f'  Found {len(chunks)} chunks')

wanted_cols = [
    'APPRENTICE_ID', 'Occupation', 'STARTING_WAGE', 'County Fips',
    'State', 'Fiscal Year', 'Gender', 'Race', 'Ethnicity',
    'Veteran Status Title', 'Individuals with Disabilities',
    'NAICS_CD', 'Industry', 'APPR_STATE', 'APPR_COUNTY_FIPS',
    'Start Date', 'Exit Date', 'Program Number',
]

dfs = []
for chunk in chunks:
    try:
        # Read all columns first, then select only the ones that exist
        df_chunk = pd.read_csv(chunk, dtype=str, low_memory=False)
        available = [c for c in wanted_cols if c in df_chunk.columns]
        dfs.append(df_chunk[available])
    except Exception as e:
        print(f'  Warning: could not read {chunk}: {e}')

df_full = pd.concat(dfs, ignore_index=True)
print(f'  Total rows: {len(df_full):,}')

# ── Filter ────────────────────────────────────────────────────────────────────
print(f'\nFiltering to high-confidence occupations and valid wages...')

df_full['STARTING_WAGE'] = pd.to_numeric(df_full['STARTING_WAGE'], errors='coerce')

df_valid = df_full[
    df_full['Occupation'].isin(valid_occupations) &
    df_full['STARTING_WAGE'].between(7.25, 150)
].copy()

print(f'  Valid rows: {len(df_valid):,}')
print(f'  Unique occupations in valid rows: {df_valid["Occupation"].nunique()}')

# ── Merge SOC codes ────────────────────────────────────────────────────────────
df_valid = df_valid.merge(
    high_conf[['raw_occupation', 'soc_code', 'official_title', 'confidence']],
    left_on='Occupation',
    right_on='raw_occupation',
    how='inner'
).drop(columns=['raw_occupation'])

# ── Sample ────────────────────────────────────────────────────────────────────
print(f'\nSampling {SAMPLE_N:,} records...')

# Stratified sample by occupation to ensure broad coverage
# Cap each occupation at proportional representation
occ_counts    = df_valid['soc_code'].value_counts()
total_valid   = len(df_valid)
n_occs        = len(occ_counts)

# Sample proportionally but cap to avoid any single occupation dominating
sampled_parts = []
remaining     = SAMPLE_N

for soc, count in occ_counts.items():
    proportion  = count / total_valid
    n_from_occ  = max(1, min(
        round(proportion * SAMPLE_N),
        count,
        SAMPLE_N // max(1, n_occs // 10)  # no occupation gets more than 10x its fair share
    ))
    part = df_valid[df_valid['soc_code'] == soc].sample(
        n=min(n_from_occ, count),
        random_state=SEED
    )
    sampled_parts.append(part)

df_sample = pd.concat(sampled_parts, ignore_index=True)

# If we got fewer than SAMPLE_N, top up with random sample from remainder
if len(df_sample) < SAMPLE_N:
    already_sampled = df_sample.index
    remainder = df_valid[~df_valid.index.isin(already_sampled)]
    n_needed  = SAMPLE_N - len(df_sample)
    if len(remainder) >= n_needed:
        top_up    = remainder.sample(n=n_needed, random_state=SEED)
        df_sample = pd.concat([df_sample, top_up], ignore_index=True)

# Final shuffle
df_sample = df_sample.sample(frac=1, random_state=SEED).reset_index(drop=True)
df_sample = df_sample.head(SAMPLE_N)

print(f'  Final sample size: {len(df_sample):,}')
print(f'  Unique SOC codes:  {df_sample["soc_code"].nunique()}')
print(f'  Median wage:       ${df_sample["STARTING_WAGE"].median():.2f}/hr')

print(f'\nTop 10 occupations in sample:')
top10 = df_sample.groupby(['official_title', 'soc_code']).size().sort_values(ascending=False).head(10)
for (title, soc), count in top10.items():
    print(f'  {count:>5,}  {title:<50}  {soc}')

# ── Save ──────────────────────────────────────────────────────────────────────
df_sample.to_csv(OUT_CSV, index=False)
print(f'\nSaved: {OUT_CSV}')
print(f'Ready for load_sqlite.py')