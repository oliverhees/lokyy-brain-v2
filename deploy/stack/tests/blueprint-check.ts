// LBV2-29/LBV2-27 — static checks of Authentik blueprints on the parsed YAML (anchors, aliases, merge keys,
// quoting and indentation resolved by a real YAML parser; comments never count).
//   node deploy/stack/tests/blueprint-check.ts <blueprint.yaml>...   exit 1 on any problem
// Parsing runs PyYAML inside the pinned Authentik image (no new dependency); Authentik tags (!Find, !KeyOf,
// !Env, !Format, ...) become { "!Tag": value } objects.
// Rules:
//  1. An entry for user akadmin that sets `groups` REPLACES all its groups: it must keep
//     !Find [authentik_core.group, [name, "authentik Admins"]] (else akadmin loses superuser, bootstrap token 403).
//  2. Such an entry depends on the system blueprint "authentik Bootstrap" (creates akadmin and that group).
//  3. Every proxy provider sets property_mappings explicitly to Authentik's managed proxy scopes; a provider
//     created before those mappings exist otherwise gets none and the outpost sends an empty identity.
//  4. Blueprints with proxy providers depend on "System - OAuth2 Provider - Scopes" and
//     "System - Proxy Provider - Scopes" (metaapplyblueprint, required: true) before the first provider.
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHENTIK_IMAGE = 'ghcr.io/goauthentik/server:2026.8.2';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const PROXY_SCOPES = [
  'goauthentik.io/providers/oauth2/scope-openid',
  'goauthentik.io/providers/oauth2/scope-profile',
  'goauthentik.io/providers/oauth2/scope-email',
  'goauthentik.io/providers/oauth2/scope-entitlements',
  'goauthentik.io/providers/proxy/scope-proxy',
];

const PARSER = `
import json, sys, yaml
class L(yaml.SafeLoader): pass
def tagged(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode): v = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode): v = loader.construct_sequence(node, deep=True)
    else: v = loader.construct_mapping(node, deep=True)
    return {"!" + suffix: v}
L.add_multi_constructor("!", tagged)
out = {}
for p in sys.argv[1:]:
    with open(p, encoding="utf-8") as f: out[p] = yaml.load(f, L)
print(json.dumps(out, default=str))
`;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses the files (paths inside the repository) with the Authentik image's YAML loader. */
export function parseFiles(files: string[]): Map<string, Json> {
  const rel = files.map((f) => relative(repo, resolve(f)));
  for (const r of rel) if (r.startsWith('..')) throw new Error(`${r}: blueprints must be inside the repository`);
  const out = execFileSync('docker', ['run', '--rm', '-i', '--network', 'none', '-v', `${repo}:/r:ro`, '-w', '/r',
    '--entrypoint', 'python', AUTHENTIK_IMAGE, '-c', PARSER, ...rel], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const parsed = JSON.parse(out) as Record<string, Json>;
  return new Map(files.map((f, i) => [f, parsed[rel[i]]]));
}

const isFind = (v: Json, model: string, field: string, value: string): boolean => {
  if (!isObj(v) || !Array.isArray(v['!Find'])) return false;
  const [m, [k, val] = []] = v['!Find'] as [Json, Json[]];
  return m === model && k === field && val === value;
};

export function checkBlueprint(doc: Json): string[] {
  const problems: string[] = [];
  const entries = isObj(doc) && Array.isArray(doc.entries) ? doc.entries : [];
  const metaIndex = (name: string) => entries.findIndex((e) => isObj(e) && e.model === 'authentik_blueprints.metaapplyblueprint'
    && isObj(e.attrs) && isObj(e.attrs.identifiers) && e.attrs.identifiers.name === name && e.attrs.required === true);
  const requireMeta = (name: string, before: number, why: string) => {
    const i = metaIndex(name);
    if (i < 0 || i > before) problems.push(`entry ${before}: ${why} needs metaapplyblueprint "${name}" (required: true) before it`);
  };
  let firstAkadmin = -1, firstProxy = -1;
  entries.forEach((e, i) => {
    if (!isObj(e)) return;
    const attrs = isObj(e.attrs) ? e.attrs : {};
    const ids = isObj(e.identifiers) ? e.identifiers : {};
    if (e.model === 'authentik_core.user' && (ids.username === 'akadmin' || attrs.username === 'akadmin') && 'groups' in attrs) {
      if (firstAkadmin < 0) firstAkadmin = i;
      const groups = Array.isArray(attrs.groups) ? attrs.groups : [];
      if (!groups.some((g) => isFind(g, 'authentik_core.group', 'name', 'authentik Admins'))) {
        problems.push(`entry ${i}: akadmin groups without !Find "authentik Admins" (drops superuser)`);
      }
    }
    if (e.model === 'authentik_providers_proxy.proxyprovider') {
      if (firstProxy < 0) firstProxy = i;
      const pm = Array.isArray(attrs.property_mappings) ? attrs.property_mappings : [];
      const missing = PROXY_SCOPES.filter((s) => !pm.some((m) => isFind(m, 'authentik_providers_oauth2.scopemapping', 'managed', s)));
      if (missing.length) problems.push(`entry ${i} (${String(ids.name ?? attrs.name)}): property_mappings missing ${missing.join(', ')}`);
    }
  });
  if (firstAkadmin >= 0) requireMeta('authentik Bootstrap', firstAkadmin, 'akadmin entry');
  if (firstProxy >= 0) {
    requireMeta('System - OAuth2 Provider - Scopes', firstProxy, 'proxy provider');
    requireMeta('System - Proxy Provider - Scopes', firstProxy, 'proxy provider');
  }
  return problems;
}

export function checkFiles(files: string[]): Map<string, string[]> {
  const parsed = parseFiles(files);
  return new Map(files.map((f) => [f, checkBlueprint(parsed.get(f) ?? null)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: blueprint-check.ts <blueprint.yaml>...'); process.exit(2); }
  let fail = 0;
  for (const [file, problems] of checkFiles(files)) {
    const name = relative(process.cwd(), file) || join('.', file);
    if (problems.length) { fail = 1; for (const p of problems) console.log(`FAIL ${name}: ${p}`); } else console.log(`ok   ${name}`);
  }
  process.exit(fail);
}
