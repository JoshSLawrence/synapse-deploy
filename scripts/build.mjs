import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

// The banner lets CommonJS code inside the bundled dependencies (for example
// @azure/identity's tree) require Node built-ins from an ES module.
const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  legalComments: 'eof',
  metafile: true,
  banner: {
    js:
      "import { createRequire } from 'node:module';" +
      'const require = createRequire(import.meta.url);',
  },
});

// Bundling copies third-party code into dist/index.js, and their licenses ask
// for their notices to travel with it. The list is sorted and holds no paths
// or dates, so the build stays reproducible.
const LICENSE_FILE = /^(licen[sc]e|copying)(\..*)?$/i;
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) continue;
  const length = parts[at + 1]?.startsWith('@') ? 2 : 1;
  packageDirs.add(parts.slice(0, at + 1 + length).join('/'));
}

const entries = [...packageDirs]
  .map((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir)
      .filter((name) => LICENSE_FILE.test(name))
      .sort()[0];
    const text = file
      ? readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim()
      : `(no license file in the package; package.json declares ${JSON.stringify(manifest.license ?? 'no license')})`;
    return {
      id: `${manifest.name}@${manifest.version}`,
      license: manifest.license ?? 'unknown',
      text,
    };
  })
  // The same package can be installed twice (nested node_modules).
  .filter((entry, i, all) => all.findIndex((other) => other.id === entry.id) === i);
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const separator = '='.repeat(72);
writeFileSync(
  'dist/licenses.txt',
  'Licenses of the packages bundled into dist/index.js\n\n' +
    entries
      .map((e) => `${separator}\n${e.id} (${e.license})\n${separator}\n\n${e.text}\n`)
      .join('\n'),
);
