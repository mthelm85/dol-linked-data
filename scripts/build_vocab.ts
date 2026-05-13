import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const ROOT        = path.resolve(__dirname, "..");
const VOCAB_SRC   = path.join(ROOT, "vocab");
const VOCAB_OUT   = path.join(ROOT, "public", "vocab");
const PLACEHOLDER = "https://NAMESPACE_PLACEHOLDER";

const baseUrl = process.env["BASE_URL"];
if (!baseUrl) {
    console.error("Error: BASE_URL is not set in .env");
    process.exit(1);
}

console.log(`Building vocab files...`);
console.log(`  BASE_URL: ${baseUrl}`);
console.log(`  Source:   ${VOCAB_SRC}`);
console.log(`  Output:   ${VOCAB_OUT}`);

fs.mkdirSync(VOCAB_OUT, { recursive: true });

const files = [
    { src: "dol_vocabulary.ttl", dest: "dol_vocabulary.ttl", type: "turtle" },
    { src: "context.jsonld",     dest: "context.jsonld",     type: "jsonld"  },
];

for (const file of files) {
    const srcPath  = path.join(VOCAB_SRC, file.src);
    const destPath = path.join(VOCAB_OUT, file.dest);

    if (!fs.existsSync(srcPath)) {
        console.error(`  Error: source file not found: ${srcPath}`);
        process.exit(1);
    }

    let content   = fs.readFileSync(srcPath, "utf8");
    const count   = (content.match(new RegExp(PLACEHOLDER, "g")) ?? []).length;
    content       = content.replaceAll(PLACEHOLDER, baseUrl);
    content       = content.replaceAll("BASE_URL_PLACEHOLDER", baseUrl);

    if (file.type === "jsonld") {
        content = content.replaceAll(
            '"context": "https://CONTEXT_PLACEHOLDER"',
            `"context": "${baseUrl}/vocab/context.jsonld"`,
        );
    }

    fs.writeFileSync(destPath, content, "utf8");
    console.log(`  ✓ ${file.src} → public/vocab/${file.dest} (${count} substitutions)`);
}

// ── Process index.html (in-place, separate path from vocab files) ──────────
const indexPath = path.join(ROOT, "public", "index.html");
if (fs.existsSync(indexPath)) {
    let content = fs.readFileSync(indexPath, "utf8");
    const count = (content.match(/BASE_URL_PLACEHOLDER/g) ?? []).length;
    content     = content.replaceAll("BASE_URL_PLACEHOLDER", baseUrl);
    fs.writeFileSync(indexPath, content, "utf8");
    console.log(`  ✓ public/index.html (${count} substitutions)`);
} else {
    console.warn("  ⚠ public/index.html not found — skipping");
}

// ── Write .well-known/void ─────────────────────────────────────────────────
const wellKnownDir = path.join(ROOT, "public", ".well-known");
fs.mkdirSync(wellKnownDir, { recursive: true });

const voidContent = JSON.stringify({
    "@context": {
        void:    "http://rdfs.org/ns/void#",
        schema:  "https://schema.org/",
        dcterms: "http://purl.org/dc/terms/",
        prov:    "http://www.w3.org/ns/prov#",
    },
    "@id":   `${baseUrl}/`,
    "@type": "void:Dataset",
    "schema:name": "DOL Apprenticeship Participant Characteristics — Linked Data",
    "schema:description": "Proof of concept demonstrating 4-star linked open data publishing for DOL workforce datasets.",
    "schema:publisher":    { "@id": "https://www.dol.gov/agencies/eta" },
    "schema:license":      { "@id": "https://creativecommons.org/licenses/by/4.0/" },
    "prov:wasDerivedFrom": { "@id": "https://data.dol.gov/datasets/10264" },
    "void:uriSpace":       `${baseUrl}/id/apprentice/`,
    "void:vocabulary": [
        { "@id": `${baseUrl}/vocab/apprenticeship` },
        { "@id": "https://schema.org/" },
        { "@id": "http://www.w3.org/2004/02/skos/core#" },
        { "@id": "http://www.w3.org/ns/prov#" },
    ],
    "void:sparqlEndpoint":  null,
    "schema:dateModified":  new Date().toISOString().split("T")[0],
}, null, 2);

fs.writeFileSync(path.join(wellKnownDir, "void"), voidContent, "utf8");
console.log("  ✓ .well-known/void written");
console.log(`\nDone. Run "cd api && func start" to start the local server.`);