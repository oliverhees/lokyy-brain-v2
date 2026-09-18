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

const BRAND = /Mind ?[Bb]ase/g;

// Wire-protocol names that are identifiers, not branding.
const ALLOWLIST = [
  'X-Mindbase-User',
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
        for (const allowed of ALLOWLIST) cleaned = cleaned.split(allowed).join('');
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
    console.error(`Brand guard: found ${violations.length} occurrence(s) of the old product name in user-visible surfaces.`);
    console.error('Use "Lokyy Brain" instead (see docs/adr/0001-rebrand-lokyy-brain.md).\n');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log('Brand guard: OK — no old product name in user-visible surfaces.');
}
