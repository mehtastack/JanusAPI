import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
// core's sandbox calls getQuickJS(), which loads the wasmfile variant (a .wasm read from disk next to the module). The CLI ships one
// file, so the bundle swaps in the single-file variant, whose wasm is embedded.
const singlefile = require.resolve('@jitl/quickjs-singlefile-mjs-release-sync');

// core's sandbox reads chai's browser build (chai.js) from disk at run time. A lone copy of the bundle has no node_modules beside it
// (and could pick up an unrelated chai), so serve core's own chai.js (the version core pins) as the virtual module janus:chai-source;
// main.ts hands it to core's setChaiSource.
const coreRequire = createRequire(require.resolve('@apijanus/core/package.json'));
const chaiSource = readFileSync(join(dirname(coreRequire.resolve('chai')), 'chai.js'), 'utf8');
const chaiSourceModule = {
  name: 'chai-source',
  setup(b) {
    b.onResolve({ filter: /^janus:chai-source$/ }, () => ({ path: 'janus:chai-source', namespace: 'janus-chai' }));
    b.onLoad({ filter: /.*/, namespace: 'janus-chai' }, () => ({ contents: `export default ${JSON.stringify(chaiSource)};`, loader: 'js' }));
  },
};

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/janus.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  alias: { '@jitl/quickjs-wasmfile-release-sync': singlefile },
  plugins: [chaiSourceModule],
  define: { __JANUS_VERSION__: JSON.stringify(pkg.version) },
  // Bundled CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
