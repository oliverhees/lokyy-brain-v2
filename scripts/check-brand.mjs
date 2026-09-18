#!/usr/bin/env node
// Brand guard (LBV2-35, ADR 0001): the product is called "Lokyy Brain".
// Fails when the old product name shows up in a surface that users, admins or
// the LLM see. Internal identifiers (@mindbase/*, MINDBASE_*, mindbase://,
// mindbase_* tool names, file names) are lowercase and never match.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Directories/files whose text reaches users, admins or the LLM.
const SURFACES = [
  'apps/web/src',
  'apps/web/index.html',
  'apps/portal/src',
  'apps/mcp/src',
  'apps/server/src',
  'packages/core/src',
  'schema',
];

const EXTENSIONS = /\.(ts|tsx|js|mjs|html|md|json|css)$/;
// Tests may keep legacy fixtures (e.g. vault files written before the rebrand).
const SKIP = [/\.test\.tsx?$/, /\.spec\.tsx?$/, new RegExp(`\\${sep}__tests__\\${sep}`)];

// Old product name, and pointers to the upstream project/author (repo, npm package, contact).
// Case-insensitive: "MINDBASE" in an LLM prompt is branding too.
const BRAND = /mind ?base|frankchu91|haobing|@mindbase\/mcp-server/gi;

// Internal identifiers that keep the old name on purpose (ADR 0001), removed before matching.
const ALLOWLIST = [
  /X-Mindbase-User/gi,          // proxy → vault identity header (wire protocol)
  /\bMINDBASE_[A-Z0-9_]+/g,     // environment variables
  /mindbase:(?:\/\/|\\\/\\\/)/g, // MCP resource URI scheme (also regex-escaped)
  /@mindbase\/(?!mcp-server)[a-z0-9-]+/g, // workspace packages
  /_*mindbase_[a-z0-9_]+/g,     // MCP tool names and other identifiers
  /\bmindbase[.:][a-zA-Z][\w.-]*/g, // localStorage keys, DOM event names, mindbase.config.json
  /\bmindbase-(?:mcp(?:-server|-http)?|app|username|tesseract)\b/g, // package/log prefixes, storage key, temp dir
  /['"]mindbase-data['"]|--data-dir <path> .*mindbase-data/g, // default data dir in code and CLI help
  /(?<=^\s*(?:\*|\/\/).*)~\/mindbase-data/g, // default data dir named in code comments
  /\/tmp\/mindbase-[\w.-]+/g,     // design-mockup references in comments
  /Usage: mindbase\b/g,         // name of the dev CLI binary
  /\.config\/mindbase\/|'mindbase', 'server\.json'/g, // server config directory
  /_mindbase\._tcp|type: 'mindbase'/g, // mDNS service type (discovery protocol)
];

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(join(path, name), out);
    }
  } else if (EXTENSIONS.test(path) && !SKIP.some((re) => re.test(path))) {
    out.push(path);
  }
  return out;
}

export function findViolations(root = ROOT, surfaces = SURFACES) {
  const violations = [];
  for (const surface of surfaces) {
    const abs = join(root, surface);
    let files;
    try { files = walk(abs, []); } catch { continue; }
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        let cleaned = line;
        for (const allowed of ALLOWLIST) cleaned = cleaned.replace(allowed, '');
        if (BRAND.test(cleaned)) {
          violations.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
        BRAND.lastIndex = 0;
      });
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = findViolations();
  if (violations.length > 0) {
    console.error(`Brand guard: found ${violations.length} occurrence(s) of the old product name or an upstream pointer in user-visible surfaces.`);
    console.error('Use "Lokyy Brain" instead (see docs/adr/0001-rebrand-lokyy-brain.md).\n');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log('Brand guard: OK — no old product name or upstream pointer in user-visible surfaces.');
}
