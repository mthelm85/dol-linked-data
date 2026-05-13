import "dotenv/config";
import { app } from "@azure/functions";
import type {
    HttpRequest,
    HttpResponseInit,
    InvocationContext,
} from "@azure/functions";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";

// =============================================================================
// DOL Workforce Linked Data — Azure Function API
//
// Routes:
//   GET /id/apprentice/:id     — individual apprentice record (content negotiated)
//   GET /id/apprentice          — paginated list of all apprentices
//   GET /vocab/apprenticeship   — vocabulary document (content negotiated)
//   GET /vocab/context.jsonld   — JSON-LD context document
//   GET /                       — void:Dataset description
//
// Content negotiation:
//   Accept: application/ld+json  → JSON-LD
//   Accept: text/turtle          → Turtle RDF (vocabulary only)
//   Accept: text/html / *        → HTML
// =============================================================================

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = config.dbPath;
let db: Database.Database;

function getDb(): Database.Database {
    if (!db) {
        console.log(`DB_PATH: ${DB_PATH}`);
        console.log(`File exists: ${fs.existsSync(DB_PATH)}`);
        if (!fs.existsSync(DB_PATH)) {
            throw new Error(
                `Database not found at: ${DB_PATH} (exists: ${fs.existsSync(DB_PATH)})`,
            );
        }
        db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    }
    return db;
}

// ── Content negotiation ───────────────────────────────────────────────────────
type ResponseFormat = "jsonld" | "turtle" | "html";

function negotiateFormat(req: HttpRequest): ResponseFormat {
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("application/ld+json")) return "jsonld";
    if (accept.includes("text/turtle")) return "turtle";
    if (accept.includes("application/rdf+xml")) return "jsonld"; // fallback to JSON-LD
    return "html";
}

function corsHeaders(): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        Vary: "Accept",
    };
}

// ── JSON-LD builder ───────────────────────────────────────────────────────────
interface ApprenticeRow {
    apprentice_id: string;
    apprentice_number: string | null;
    program_number: string | null;
    soc_code: string;
    official_title: string;
    raw_occupation: string | null;
    match_confidence: number | null;
    starting_wage: number | null;
    exit_wage: number | null;
    county_fips: string | null;
    state: string | null;
    naics_cd: string | null;
    industry: string | null;
    appr_county_fips: string | null;
    appr_state: string | null;
    gender: string | null;
    race: string | null;
    ethnicity: string | null;
    has_disability: number | null;
    veteran_status: string | null;
    education: string | null;
    age_cohort: string | null;
    start_date: string | null;
    exit_date: string | null;
    fiscal_year: number | null;
    apprentice_status: string | null;
}

function buildJsonLd(row: ApprenticeRow): object {
    const doc: Record<string, unknown> = {
        "@context": config.uris.context,
        "@id": config.uris.apprentice(row.apprentice_id),
        "@type": ["schema:Person", "dol:Apprentice"],

        "schema:identifier": row.apprentice_id,
    };

    // Occupation — the core interoperability field
    // Value is a dereferenceable O*NET URI, not a string
    doc["schema:occupationalCategory"] = {
        "@id": config.uris.occupation(row.soc_code),
        "rdfs:label": row.official_title,
    };

    if (row.raw_occupation) {
        doc["dol:rawOccupationString"] = row.raw_occupation;
    }

    // Wages
    if (row.starting_wage !== null) {
        doc["schema:baseSalary"] = {
            "@type": "schema:MonetaryAmount",
            "schema:currency": "USD",
            "schema:value": row.starting_wage,
        };
    }

    if (row.exit_wage !== null) {
        doc["dol:exitWage"] = row.exit_wage;
    }

    // Geography — program location
    if (row.county_fips) {
        doc["schema:workLocation"] = {
            "@id": config.uris.county(row.county_fips),
            "@type": "schema:Place",
            "schema:identifier": row.county_fips,
        };
    }

    if (row.state) {
        doc["schema:addressRegion"] = row.state;
    }

    // Geography — apprentice home location
    if (row.appr_county_fips && row.appr_county_fips !== row.county_fips) {
        doc["schema:homeLocation"] = {
            "@id": config.uris.county(row.appr_county_fips),
            "@type": "schema:Place",
            "schema:identifier": row.appr_county_fips,
        };
    }

    // Industry
    if (row.naics_cd) {
        doc["schema:naics"] = row.naics_cd;
    }

    if (row.industry) {
        doc["schema:industry"] = row.industry;
    }

    // Demographics
    if (row.gender) doc["schema:gender"] = row.gender;
    if (row.race) doc["schema:ethnicity"] = row.race;
    if (row.education) doc["schema:educationalLevel"] = row.education;
    if (row.age_cohort) doc["dol:ageCohort"] = row.age_cohort;

    if (row.has_disability !== null) {
        doc["dol:hasDisability"] = row.has_disability === 1;
    }

    if (row.veteran_status) {
        doc["dol:veteranStatus"] = row.veteran_status;
    }

    // Temporal
    if (row.start_date) doc["schema:startDate"] = row.start_date;
    if (row.exit_date) doc["schema:endDate"] = row.exit_date;
    if (row.fiscal_year) doc["dol:fiscalYear"] = row.fiscal_year;

    // Status
    if (row.apprentice_status) {
        doc["dol:apprenticeStatus"] = {
            "@id": config.uris.status(row.apprentice_status),
        };
    }

    // Provenance
    doc["prov:wasDerivedFrom"] = { "@id": config.datasetUri };

    return doc;
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHtml(row: ApprenticeRow): string {
    const onetUrl = config.uris.occupation(row.soc_code);
    const selfUrl = config.uris.apprentice(row.apprentice_id);
    const jsonldUrl = `${selfUrl}?format=jsonld`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apprentice ${row.apprentice_id} — DOL Workforce Linked Data</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; font-weight: 500; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th { text-align: left; padding: 8px 12px; font-size: 0.8rem; color: #666; border-bottom: 1px solid #e5e5e5; font-weight: 500; }
    td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; font-size: 0.9rem; }
    td:first-child { color: #666; width: 220px; }
    a { color: #0055cc; }
    .formats { background: #f8f8f8; padding: 1rem; border-radius: 6px; font-size: 0.85rem; }
    .formats code { background: #e8e8e8; padding: 2px 6px; border-radius: 3px; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; background: #e8f0fe; color: #1a56db; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; font-size: 0.8rem; color: #999; }
  </style>
</head>
<body>

  <h1>Apprentice <code>${row.apprentice_id}</code></h1>
  <p class="subtitle">
    U.S. Department of Labor — Registered Apprenticeship Program
    <span class="badge">Linked Data</span>
  </p>

  <table>
    <tr><th colspan="2">Occupation</th></tr>
    <tr>
      <td>Occupation</td>
      <td><a href="${onetUrl}" target="_blank">${row.official_title}</a>
          <br><small style="color:#888">SOC ${row.soc_code} — click to view O*NET occupation page</small></td>
    </tr>
    ${row.raw_occupation ? `<tr><td>As recorded in RAPIDS</td><td><code>${row.raw_occupation}</code></td></tr>` : ""}

    <tr><th colspan="2">Wages</th></tr>
    ${row.starting_wage !== null ? `<tr><td>Starting wage</td><td>$${row.starting_wage.toFixed(2)}/hr</td></tr>` : ""}
    ${row.exit_wage !== null ? `<tr><td>Exit wage</td><td>$${row.exit_wage.toFixed(2)}/hr</td></tr>` : ""}

    <tr><th colspan="2">Location</th></tr>
    ${row.state ? `<tr><td>State</td><td>${row.state}</td></tr>` : ""}
    ${row.county_fips ? `<tr><td>County FIPS</td><td>${row.county_fips}</td></tr>` : ""}

    <tr><th colspan="2">Demographics</th></tr>
    ${row.gender ? `<tr><td>Gender</td><td>${row.gender}</td></tr>` : ""}
    ${row.race ? `<tr><td>Race/Ethnicity</td><td>${row.race}</td></tr>` : ""}
    ${row.veteran_status ? `<tr><td>Veteran status</td><td>${row.veteran_status}</td></tr>` : ""}
    ${row.has_disability !== null ? `<tr><td>Has disability</td><td>${row.has_disability === 1 ? "Yes" : "No"}</td></tr>` : ""}
    ${row.education ? `<tr><td>Education</td><td>${row.education}</td></tr>` : ""}

    <tr><th colspan="2">Program</th></tr>
    ${row.fiscal_year ? `<tr><td>Fiscal year</td><td>FY${row.fiscal_year}</td></tr>` : ""}
    ${row.start_date ? `<tr><td>Start date</td><td>${row.start_date}</td></tr>` : ""}
    ${row.exit_date ? `<tr><td>Exit date</td><td>${row.exit_date}</td></tr>` : ""}
    ${row.apprentice_status ? `<tr><td>Status</td><td>${row.apprentice_status}</td></tr>` : ""}
  </table>

  <div class="formats">
    <strong>Machine-readable formats</strong><br><br>
    This record is available as linked data:<br><br>
    <code>curl -H "Accept: application/ld+json" ${selfUrl}</code><br><br>
    Or directly: <a href="${jsonldUrl}">${jsonldUrl}</a>
    <br><br>
    <a href="${config.uris.vocab}">Vocabulary definition</a> ·
    <a href="${config.uris.context}">JSON-LD context</a> ·
    <a href="${config.datasetUri}" target="_blank">Source dataset (data.dol.gov)</a>
  </div>

  <footer>
    Published by the U.S. Department of Labor, Employment and Training Administration.
    Data derived from the <a href="${config.datasetUri}" target="_blank">Apprenticeship Participant Characteristics</a> dataset.
    Licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
  </footer>

</body>
</html>`;
}

// =============================================================================
// Route handlers
// =============================================================================

// ── GET /id/apprentice/:id ────────────────────────────────────────────────────
async function getApprentice(
    req: HttpRequest,
    ctx: InvocationContext,
): Promise<HttpResponseInit> {
    const id = req.params["id"];
    const format =
        req.query.get("format") === "jsonld" ? "jsonld" : negotiateFormat(req);

    if (!id) {
        return { status: 400, body: "Missing apprentice ID" };
    }

    ctx.log(`GET /id/apprentice/${id} (format: ${format})`);

    let row: ApprenticeRow | undefined;
    try {
        row = getDb()
            .prepare("SELECT * FROM apprentices WHERE apprentice_id = ?")
            .get(id) as ApprenticeRow | undefined;
    } catch (err) {
        ctx.error("Database error:", err);
        return { status: 500, body: `Database error: ${String(err)}` };
    }

    if (!row) {
        return {
            status: 404,
            headers: { "Content-Type": "text/plain", ...corsHeaders() },
            body: `Apprentice '${id}' not found`,
        };
    }

    if (format === "jsonld") {
        return {
            status: 200,
            headers: {
                "Content-Type": "application/ld+json",
                Link: `<${config.uris.vocab}>; rel="describedby"`,
                ...corsHeaders(),
            },
            jsonBody: buildJsonLd(row),
        };
    }

    return {
        status: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            Link: `<${config.uris.apprentice(id)}>; rel="alternate"; type="application/ld+json"`,
            ...corsHeaders(),
        },
        body: buildHtml(row),
    };
}

// ── GET /id/apprentice (list) ─────────────────────────────────────────────────
async function listApprentices(
    req: HttpRequest,
    ctx: InvocationContext,
): Promise<HttpResponseInit> {
    const page = Math.max(1, parseInt(req.query.get("page") ?? "1"));
    const pageSize = Math.min(
        config.maxPageSize,
        Math.max(
            1,
            parseInt(req.query.get("size") ?? String(config.defaultPageSize)),
        ),
    );
    const offset = (page - 1) * pageSize;
    const socFilter = req.query.get("soc");

    ctx.log(
        `GET /id/apprentice (page: ${page}, size: ${pageSize}, soc: ${socFilter ?? "all"})`,
    );

    try {
        const db = getDb();
        const where = socFilter ? "WHERE soc_code = ?" : "";
        const params = socFilter
            ? [socFilter, pageSize, offset]
            : [pageSize, offset];
        const countParams = socFilter ? [socFilter] : [];

        const rows = db
            .prepare(
                `SELECT apprentice_id, soc_code, official_title, starting_wage, state, fiscal_year
       FROM apprentices ${where}
       ORDER BY apprentice_id
       LIMIT ? OFFSET ?`,
            )
            .all(...params) as Array<
            Pick<
                ApprenticeRow,
                | "apprentice_id"
                | "soc_code"
                | "official_title"
                | "starting_wage"
                | "state"
                | "fiscal_year"
            >
        >;

        const total = (
            db
                .prepare(`SELECT COUNT(*) as n FROM apprentices ${where}`)
                .get(...countParams) as { n: number }
        ).n;

        const format = negotiateFormat(req);

        if (format === "jsonld") {
            return {
                status: 200,
                headers: {
                    "Content-Type": "application/ld+json",
                    ...corsHeaders(),
                },
                jsonBody: {
                    "@context": config.uris.context,
                    "@id": `${config.uris.dataset}id/apprentice`,
                    "@type": "void:Dataset",
                    "void:uriSpace": config.uris.dataset,
                    "hydra:totalItems": total,
                    "hydra:member": rows.map((r) => ({
                        "@id": config.uris.apprentice(r.apprentice_id),
                        "@type": "dol:Apprentice",
                        "schema:occupationalCategory": {
                            "@id": config.uris.occupation(r.soc_code),
                        },
                        "schema:name": r.official_title,
                        "schema:baseSalary": r.starting_wage,
                        "schema:addressRegion": r.state,
                    })),
                },
            };
        }

        // HTML list view
        const rows_html = rows
            .map(
                (r) => `
      <tr>
        <td><a href="${config.uris.apprentice(r.apprentice_id)}">${r.apprentice_id}</a></td>
        <td><a href="${config.uris.occupation(r.soc_code)}" target="_blank">${r.official_title}</a></td>
        <td>${r.starting_wage !== null ? "$" + r.starting_wage.toFixed(2) : "—"}</td>
        <td>${r.state ?? "—"}</td>
        <td>${r.fiscal_year ?? "—"}</td>
      </tr>`,
            )
            .join("");

        return {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...corsHeaders(),
            },
            body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apprentice records — DOL Workforce Linked Data</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; font-size: 0.8rem; color: #666; border-bottom: 1px solid #e5e5e5; }
    td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; font-size: 0.875rem; }
    a { color: #0055cc; }
    .pager { margin-top: 1rem; font-size: 0.875rem; }
  </style>
</head>
<body>
  <h1>DOL Apprenticeship — Linked Data records</h1>
  <p style="color:#666; font-size:0.875rem;">
    Showing ${offset + 1}–${Math.min(offset + pageSize, total)} of ${total.toLocaleString()} records.
    <a href="?format=jsonld&page=${page}&size=${pageSize}">View as JSON-LD</a>
  </p>
  <table>
    <thead>
      <tr><th>ID</th><th>Occupation</th><th>Starting wage</th><th>State</th><th>FY</th></tr>
    </thead>
    <tbody>${rows_html}</tbody>
  </table>
  <div class="pager">
    ${page > 1 ? `<a href="?page=${page - 1}&size=${pageSize}">← Previous</a> ` : ""}
    ${offset + pageSize < total ? `<a href="?page=${page + 1}&size=${pageSize}">Next →</a>` : ""}
  </div>
</body>
</html>`,
        };
    } catch (err) {
        ctx.error("Error:", err);
        return { status: 500, body: String(err) };
    }
}

// ── GET / (void:Dataset description) ─────────────────────────────────────────
async function getDatasetIndex(
    req: HttpRequest,
    ctx: InvocationContext,
): Promise<HttpResponseInit> {
    ctx.log("GET /");

    const format = negotiateFormat(req);
    const voidPath = path.resolve(__dirname, "../../public/.well-known/void");

    if (format === "jsonld" && fs.existsSync(voidPath)) {
        const voidDoc = fs.readFileSync(voidPath, "utf8");
        return {
            status: 200,
            headers: {
                "Content-Type": "application/ld+json",
                ...corsHeaders(),
            },
            body: voidDoc,
        };
    }

    // Redirect to index.html for HTML clients
    return {
        status: 302,
        headers: { Location: "/index.html", ...corsHeaders() },
    };
}

function tryRead(p: string): string {
  try { 
    const stat = fs.statSync(p);
    return `exists, size: ${stat.size} bytes, mode: ${stat.mode.toString(8)}`;
  }
  catch (e) { return `ERROR: ${String(e)}`; }
}

async function getDiagnostics(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const diag = {
    __dirname,
    cwd: process.cwd(),
    files: {
      wwwroot:      fs.readdirSync('/home/site/wwwroot').catch?.() ?? tryList('/home/site/wwwroot'),
      wwwrootDist:  tryList('/home/site/wwwroot/dist'),
      wwwrootData:  tryList('/home/site/wwwroot/data'),
      distData:     tryList('/home/site/wwwroot/dist/data'),
      wwwrootDataDb: tryRead('/home/site/wwwroot/data/apprenticeship.db'),
    }
  };
  return { status: 200, jsonBody: diag };
}

function tryList(p: string): string[] | string {
  try { return fs.readdirSync(p); }
  catch (e) { return `ERROR: ${String(e)}`; }
}

app.http('getDiagnostics', {
  methods: ['GET'],
  route: 'diagnostics',
  authLevel: 'anonymous',
  handler: getDiagnostics,
});

// =============================================================================
// Route registration
// =============================================================================

app.http("getApprentice", {
    methods: ["GET"],
    route: "id/apprentice/{id}",
    authLevel: "anonymous",
    handler: getApprentice,
});

app.http("listApprentices", {
    methods: ["GET"],
    route: "id/apprentice",
    authLevel: "anonymous",
    handler: listApprentices,
});

app.http("getDatasetIndex", {
    methods: ["GET"],
    route: "",
    authLevel: "anonymous",
    handler: getDatasetIndex,
});
