import 'dotenv/config';

// =============================================================================
// Configuration — single source of truth for all URIs and environment settings
//
// To change the namespace URI for deployment:
//   1. Update BASE_URL in .env (local) or Azure portal app settings (production)
//   2. Re-run the build-vocab script to regenerate public vocab files
//   Everything else updates automatically.
// =============================================================================

const baseUrl      = process.env.BASE_URL      ?? 'http://localhost:7071';
const datasetUri   = process.env.DATASET_URI   ?? 'https://data.dol.gov/datasets/10264';
const publisherUri = process.env.PUBLISHER_URI ?? 'https://www.dol.gov';

export const config = {
  // ── Environment ─────────────────────────────────────────────────────────────
  baseUrl,
  datasetUri,
  publisherUri,
  isDevelopment: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',

  // ── Namespace ────────────────────────────────────────────────────────────────
  // The vocabulary namespace URI. Append # + term name for individual terms.
  // e.g. config.vocabNs + 'Apprentice' → https://.../vocab/apprenticeship#Apprentice
  vocabNs: `${baseUrl}/vocab/apprenticeship#`,

  // ── URI builders ─────────────────────────────────────────────────────────────
  // All URIs in the linked data publication are constructed here.
  // Never hardcode a URI anywhere else in the codebase.

  uris: {
    // Individual apprentice record
    apprentice: (id: string) =>
      `${baseUrl}/id/apprentice/${encodeURIComponent(id)}`,

    // Occupation node — reuses O*NET's own dereferenceable URI
    occupation: (socCode: string) =>
      `https://www.onetonline.org/link/summary/${encodeURIComponent(socCode)}`,

    // County node
    county: (fips: string) =>
      `${baseUrl}/id/county/${encodeURIComponent(fips)}`,

    // JSON-LD context document
    context: `${baseUrl}/vocab/context.jsonld`,

    // Vocabulary namespace document
    vocab: `${baseUrl}/vocab/apprenticeship`,

    // Dataset-level void:Dataset description
    dataset: `${baseUrl}/`,

    // Apprentice status concept URIs
    status: (code: string) =>
      `${baseUrl}/vocab/apprenticeship#status_${encodeURIComponent(code)}`,
  },

  // ── Prefixes (for JSON-LD @context reference) ─────────────────────────────
  prefixes: {
    dol:    `${baseUrl}/vocab/apprenticeship#`,
    schema: 'https://schema.org/',
    skos:   'http://www.w3.org/2004/02/skos/core#',
    prov:   'http://www.w3.org/ns/prov#',
    xsd:    'http://www.w3.org/2001/XMLSchema#',
    void:   'http://rdfs.org/ns/void#',
    dcterms:'http://purl.org/dc/terms/',
    occ:    'https://www.onetonline.org/link/summary/',
  },

  // ── SQLite ───────────────────────────────────────────────────────────────────
  dbPath: process.env.DB_PATH
    ?? '../data/apprenticeship.db',

  // ── Pagination ───────────────────────────────────────────────────────────────
  defaultPageSize: 100,
  maxPageSize:     1000,
} as const;

// Type export for use elsewhere
export type Config = typeof config;