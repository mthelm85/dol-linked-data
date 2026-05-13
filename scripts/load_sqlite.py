"""
scripts/load_sqlite.py

Loads the clean 10,000-record subset into a SQLite database
for the Azure Function to query at runtime.

Reads:
  ../data/subset.csv

Writes:
  ../data/apprenticeship.db

Run after generate_subset.py.
"""

import pandas as pd
import sqlite3, os, re
from dateutil import parser as dateparser

SUBSET_CSV = os.path.join(os.path.dirname(__file__), '..', 'data', 'subset.csv')
DB_PATH    = os.path.join(os.path.dirname(__file__), '..', 'data', 'apprenticeship.db')

# ── Helpers ───────────────────────────────────────────────────────────────────
def normalize_fips(val) -> str | None:
    if pd.isna(val):
        return None
    s = str(val).split('.')[0].strip()
    return s.zfill(5) if s.isdigit() else None

def normalize_soc(val) -> str | None:
    if pd.isna(val):
        return None
    s = str(val).strip()
    if re.match(r'^\d{2}-\d{4}\.\d{2}$', s):
        return s
    return None

def parse_bool(val) -> int | None:
    """SQLite uses 0/1 for booleans."""
    if pd.isna(val):
        return None
    s = str(val).strip()
    if s in ('1', 'Yes', 'yes', 'Y', 'true', 'True'):
        return 1
    if s in ('2', 'No', 'no', 'N', 'false', 'False'):
        return 0
    return None

def clean_str(val) -> str | None:
    if pd.isna(val):
        return None
    s = str(val).strip()
    return None if s in ('', 'nan', 'Not Provided', 'Participant Did Not Self Identify',
                         'USMAP', 'nan') else s

def normalize_date(val) -> str | None:
    if pd.isna(val) or not val:
        return None
    try:
        return dateparser.parse(str(val)).strftime('%Y-%m-%d')
    except:
        return None

# ── Load CSV ──────────────────────────────────────────────────────────────────
print('Loading subset.csv...')
df = pd.read_csv(SUBSET_CSV, dtype=str, low_memory=False)
df['STARTING_WAGE'] = pd.to_numeric(df['STARTING_WAGE'], errors='coerce')
print(f'  {len(df):,} rows loaded')

# ── Create database ────────────────────────────────────────────────────────────
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
    print(f'Removed existing database.')

print(f'Creating {DB_PATH}...')
conn = sqlite3.connect(DB_PATH)
cur  = conn.cursor()

cur.executescript("""
PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;

-- ── Apprentice records ────────────────────────────────────────────────────────
CREATE TABLE apprentices (
    apprentice_id       TEXT PRIMARY KEY,
    apprentice_number   TEXT,
    program_number      TEXT,

    -- Occupation (the core interoperability field)
    soc_code            TEXT NOT NULL,
    official_title      TEXT NOT NULL,
    raw_occupation      TEXT,
    match_confidence    REAL,

    -- Wages
    starting_wage       REAL,
    exit_wage           REAL,

    -- Geography (program location)
    county_fips         TEXT,
    state               TEXT,
    naics_cd            TEXT,
    industry            TEXT,

    -- Geography (apprentice location)
    appr_county_fips    TEXT,
    appr_state          TEXT,

    -- Demographics
    gender              TEXT,
    race                TEXT,
    ethnicity           TEXT,
    has_disability      INTEGER,  -- 0/1/NULL
    veteran_status      TEXT,
    education           TEXT,
    age_cohort          TEXT,

    -- Temporal
    start_date          TEXT,
    exit_date           TEXT,
    fiscal_year         INTEGER,

    -- Program
    apprentice_status   TEXT,
    program_view        TEXT,
    is_union_program    INTEGER,  -- 0/1/NULL
    hud_state           TEXT
);

-- ── Occupation aggregates ─────────────────────────────────────────────────────
-- Pre-computed stats per SOC code for the dataset index and summary queries
CREATE TABLE occupations (
    soc_code            TEXT PRIMARY KEY,
    official_title      TEXT NOT NULL,
    participant_count   INTEGER NOT NULL,
    median_wage         REAL,
    mean_wage           REAL,
    min_wage            REAL,
    max_wage            REAL
);

-- ── Dataset metadata ──────────────────────────────────────────────────────────
CREATE TABLE dataset_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_soc_code        ON apprentices(soc_code);
CREATE INDEX idx_state           ON apprentices(state);
CREATE INDEX idx_county_fips     ON apprentices(county_fips);
CREATE INDEX idx_fiscal_year     ON apprentices(fiscal_year);
CREATE INDEX idx_starting_wage   ON apprentices(starting_wage);
CREATE INDEX idx_veteran_status  ON apprentices(veteran_status);
""")

conn.commit()
print('  Schema created.')

# ── Insert apprentices ────────────────────────────────────────────────────────
print('Inserting apprentice records...')

rows = []
skipped = 0

for _, row in df.iterrows():
    app_id = clean_str(row.get('APPRENTICE_ID'))
    soc    = normalize_soc(row.get('soc_code'))

    if not app_id or not soc:
        skipped += 1
        continue

    rows.append((
        app_id,
        clean_str(row.get('apprentice_number')),
        clean_str(row.get('Program Number')),
        soc,
        clean_str(row.get('official_title')),
        clean_str(row.get('Occupation')),
        float(row['confidence']) if pd.notna(row.get('confidence')) else None,
        float(row['STARTING_WAGE']) if pd.notna(row.get('STARTING_WAGE')) else None,
        float(row['exit_wage']) if pd.notna(row.get('exit_wage')) else None
            if 'exit_wage' in row else None,
        normalize_fips(row.get('County Fips')),
        clean_str(row.get('State')),
        clean_str(row.get('NAICS_CD')),
        clean_str(row.get('Industry')),
        normalize_fips(row.get('APPR_COUNTY_FIPS')),
        clean_str(row.get('APPR_STATE')),
        clean_str(row.get('Gender')),
        clean_str(row.get('Race')),
        clean_str(row.get('Ethnicity')),
        parse_bool(row.get('Individuals with Disabilities')),
        clean_str(row.get('Veteran Status Title')),
        clean_str(row.get('Education')),
        clean_str(row.get('Age Cohort')),
        normalize_date(row.get('Start Date')),
        normalize_date(row.get('Exit Date')),
        int(str(row.get('Fiscal Year', '')).strip()) if str(row.get('Fiscal Year', '')).strip().isdigit() else None,
        clean_str(row.get('apprentice_status_code')),
        None,  # program_view — not in RAPIDS participant data
        None,  # is_union_program — not in RAPIDS participant data
        None,  # hud_state — not in RAPIDS participant data
    ))

cur.executemany("""
INSERT OR IGNORE INTO apprentices VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)
""", rows)

conn.commit()
print(f'  Inserted: {len(rows):,}  Skipped: {skipped}')

# ── Insert occupation aggregates ──────────────────────────────────────────────
print('Computing occupation aggregates...')

cur.execute("""
INSERT INTO occupations
SELECT
    soc_code,
    official_title,
    COUNT(*) AS participant_count,
    ROUND(AVG(starting_wage), 4) AS mean_wage,
    MIN(starting_wage) AS min_wage,
    MAX(starting_wage) AS max_wage,
    NULL AS median_wage
FROM apprentices
WHERE starting_wage IS NOT NULL
GROUP BY soc_code, official_title
ORDER BY participant_count DESC
""")

# Compute median per SOC in Python (SQLite has no native MEDIAN)
occ_stats = df.groupby(['soc_code', 'official_title'])['STARTING_WAGE'].median().reset_index()
for _, row in occ_stats.iterrows():
    soc = normalize_soc(row['soc_code'])
    if not soc:
        continue
    cur.execute(
        'UPDATE occupations SET median_wage = ? WHERE soc_code = ?',
        (round(float(row['STARTING_WAGE']), 4), soc)
    )

conn.commit()

occ_count = cur.execute('SELECT COUNT(*) FROM occupations').fetchone()[0]
print(f'  {occ_count} occupation nodes computed')

# ── Insert dataset metadata ───────────────────────────────────────────────────
print('Writing dataset metadata...')

record_count  = cur.execute('SELECT COUNT(*) FROM apprentices').fetchone()[0]
median_wage   = df['STARTING_WAGE'].median()
unique_socs   = df['soc_code'].nunique()
unique_states = df['State'].nunique()
fiscal_years  = df['Fiscal Year'].dropna().unique()
fy_range      = f"{min(fiscal_years)}–{max(fiscal_years)}" if len(fiscal_years) > 0 else 'unknown'

meta = [
    ('record_count',    str(record_count)),
    ('unique_soc_codes',str(unique_socs)),
    ('unique_states',   str(unique_states)),
    ('median_wage',     f'{median_wage:.2f}'),
    ('fiscal_years',    fy_range),
    ('source_dataset',  'https://data.dol.gov/datasets/10264'),
    ('publisher',       'https://www.dol.gov/agencies/eta'),
    ('license',         'https://creativecommons.org/licenses/by/4.0/'),
    ('generated_date',  pd.Timestamp.now().strftime('%Y-%m-%d')),
    ('min_confidence',  '95.0'),
    ('sample_method',   'stratified by occupation'),
]

cur.executemany('INSERT INTO dataset_meta VALUES (?, ?)', meta)
conn.commit()

# ── Summary ────────────────────────────────────────────────────────────────────
conn.close()

db_size_mb = os.path.getsize(DB_PATH) / (1024 * 1024)

print(f"""
── Database summary ──────────────────────────────────────────────────────
  Path:            {DB_PATH}
  Size:            {db_size_mb:.1f} MB
  Apprentices:     {record_count:,}
  Occupations:     {occ_count}
  Unique states:   {unique_states}
  Fiscal years:    {fy_range}
  Median wage:     ${median_wage:.2f}/hr

── Next steps ────────────────────────────────────────────────────────────
  1. Run scripts/build_vocab.ts to generate public vocab files
  2. Run the Azure Function locally: cd api && func start
  3. Test: curl -H "Accept: application/ld+json" http://localhost:7071/id/apprentice/{{id}}
""")