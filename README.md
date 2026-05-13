# dol-linked-data

A proof of concept demonstrating four-star linked open data publishing for the U.S. Department of Labor's [Apprenticeship Participant Characteristics](https://data.dol.gov/datasets/10264) dataset.

Each apprentice record is available as a dereferenceable URI returning JSON-LD or HTML depending on the `Accept` header. Occupation fields link to [O\*NET](https://www.onetonline.org) using standard SOC code URIs.

**This is not an official DOL publication.**

---

## What this demonstrates

- Four-star linked open data publishing using RDF and JSON-LD
- Content negotiation — same URI serves HTML for humans, JSON-LD for machines
- Vocabulary governance — standard Schema.org terms reused where possible, novel `dol:` terms formally defined
- The cost of retrofitting linked data onto data that wasn't designed for it

## Architecture

```
vocab/                  ← source vocabulary files (substituted at build time)
  dol_vocabulary.ttl    ← RDFS/OWL formal definitions for novel dol: terms
  context.jsonld        ← JSON-LD context mapping RAPIDS fields to vocabulary terms

api/                    ← Azure Functions (TypeScript)
  src/
    index.ts            ← HTTP handler with content negotiation
    config.ts           ← single source of truth for all URIs

public/                 ← static assets (served by Azure Static Web Apps)
  index.html            ← dataset landing page
  vocab/                ← generated at build time from vocab/ source files
  .well-known/void      ← machine-readable dataset description

scripts/
  generate_subset.py    ← creates 10,000-record subset from full RAPIDS dataset
  load_sqlite.py        ← loads subset into SQLite for the API to query
  build_vocab.ts        ← substitutes BASE_URL into vocab files and index.html

data/
  apprenticeship.db     ← SQLite database (generated, not committed)
  subset.csv            ← 10,000-record subset (generated, not committed)
```

## Setup

### Prerequisites

- Node.js 22
- Python 3.11+
- Azure Functions Core Tools v4

### Environment

```bash
cp .env.example .env
# Edit .env and set BASE_URL to your deployment URL
```

### Install dependencies

```bash
npm install
cd api && npm install && cd ..
pip install pandas rapidfuzz python-dateutil
```

### Generate the data

Download the [Apprenticeship Participant Characteristics](https://data.dol.gov/datasets/10264) dataset and extract to `~/Data/eta_apprenticeship/`.

Download the O\*NET database files (Text format) from [onetcenter.org](https://www.onetcenter.org/database.html#individual-files) and place in `onet/`:
- `Occupation Data.txt`
- `Alternate Titles.txt`
- `Sample of Reported Titles.txt`

Then run:

```bash
python scripts/generate_subset.py   # creates data/subset.csv
python scripts/load_sqlite.py       # creates data/apprenticeship.db
```

### Build and run locally

```bash
npm run build:vocab                  # generates public/vocab/ and public/.well-known/

cd api
npm run build                        # compiles TypeScript
func start                           # starts Azure Functions on localhost:7071
```

### Test

```bash
# HTML
curl http://localhost:7071/api/id/apprentice/1294199

# JSON-LD
curl -H "Accept: application/ld+json" http://localhost:7071/api/id/apprentice/1294199

# List
curl http://localhost:7071/api/id/apprentice
```

## Deployment

Deployed via GitHub Actions to Azure Static Web Apps. On push to `main`:

1. `npm run build:vocab` runs to generate static assets
2. `api/` is deployed as Azure Functions
3. `public/` is deployed as static assets

Set `BASE_URL` in Azure portal under **Settings → Configuration → Application settings** to your live URL. Re-run the build workflow after updating.

## Vocabulary

Novel DOL-specific terms are defined in `vocab/dol_vocabulary.ttl`. Standard terms are reused from:

- [Schema.org](https://schema.org) — person, occupation, wage, location, dates
- [SKOS](https://www.w3.org/2004/02/skos/core) — concept schemes, notations
- [PROV-O](https://www.w3.org/ns/prov) — provenance and attribution

## Gaps this demonstrates

This publication required manual preprocessing that would be unnecessary if the source data were published as linked data from the start:

- RAPIDS has no SOC codes — a fuzzy-matching pipeline was required to reconcile 1,328 free-text occupation strings
- 33.7% of RAPIDS records have no usable occupation data
- No SPARQL endpoint — records are dereferenceable but not federatable

## License

Code and vocabulary: MIT
Data: derived from DOL public domain data — see [source dataset](https://data.dol.gov/datasets/10264)