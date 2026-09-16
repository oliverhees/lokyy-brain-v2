// Container build only: compile apps/server/src into a single ESM file so the
// runtime image does not need tsx or TypeScript sources.
//
// - Packages declared in apps/server/package.json `dependencies` stay external
//   and are resolved at runtime from the production-only node_modules.
//   @mindbase/core (workspace, partly imported as TypeScript source) and any
//   transitive import that is not a declared server dependency are bundled, so
//   nothing has to resolve through pnpm's non-hoisted layout from dist/.
// - `import.meta.dirname` is rewritten per source file to the directory the file
//   had in the repository, relative to the app root. The server resolves
//   schema/, apps/web/dist and .env relative to its source files at different
//   depths; a plain bundle would collapse all of them onto dist/.
// - Other file-location primitives (`import.meta.url`, `import.meta.filename`,
//   `__dirname`, `__filename`) would silently change meaning in a bundle, so the
//   build fails if server or bundled @mindbase/core code starts using them. Extend the rewrite if needed.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// esbuild is a devDependency of apps/app (the npm launcher bundles the server too).
const { build } = createRequire(path.join(repo, 'apps/app/package.json'))('esbuild');

const serverSrc = path.join(repo, 'apps/server/src') + path.sep;
// Every first-party source tree that ends up inside the bundle.
const firstPartySrc = [serverSrc, ...['packages/core/src', 'packages/core/dist'].map((d) => path.join(repo, d) + path.sep)];
const outfile = path.join(repo, 'apps/server/dist/server.mjs');
const forbidden = /\bimport\.meta\.(url|filename)\b|\b__dirname\b|\b__filename\b/;

const serverPkg = JSON.parse(await readFile(path.join(repo, 'apps/server/package.json'), 'utf8'));
const externalPkgs = new Set(Object.keys(serverPkg.dependencies ?? {}).filter((n) => !n.startsWith('@mindbase/')));
const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const externalServerDeps = {
  name: 'external-server-deps',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point' || /^(\.|\/|node:)/.test(args.path)) return undefined;
      return externalPkgs.has(pkgName(args.path)) ? { path: args.path, external: true } : undefined;
    });
  },
};

const importMetaDirname = {
  name: 'import-meta-dirname',
  setup(b) {
    b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      if (!firstPartySrc.some((root) => args.path.startsWith(root))) return undefined;
      const source = await readFile(args.path, 'utf8');
      const rel = path.relative(repo, args.path);
      const hit = source.match(forbidden);
      if (hit) {
        return { errors: [{ text: `${rel}: "${hit[0]}" is not supported by deploy/build-server.mjs` }] };
      }
      const dir = path.relative(repo, path.dirname(args.path)).split(path.sep).join('/');
      return {
        contents: source.replaceAll('import.meta.dirname', `__mbJoin(__mbAppRoot, ${JSON.stringify(dir)})`),
        loader: path.extname(args.path).slice(1).replace(/^[cm]/, ''),
      };
    });
  },
};

await build({
  entryPoints: [path.join(serverSrc, 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  plugins: [externalServerDeps, importMetaDirname],
  banner: {
    // dist/server.mjs lives in apps/server/dist -> app root is three levels up.
    // Bundled CommonJS modules (e.g. transitive deps of @mindbase/core) call require().
    js: [
      "import { createRequire as __mbCreateRequire } from 'node:module';",
      "const require = __mbCreateRequire(import.meta.url);",
      "import { join as __mbJoin } from 'node:path';",
      "const __mbAppRoot = __mbJoin(import.meta.dirname, '..', '..', '..');",
    ].join('\n'),
  },
});
