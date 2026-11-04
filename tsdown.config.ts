import { defineConfig } from 'tsdown'
import { builtinModules } from 'node:module'

/**
 * Node half: the host plugin plus the three world providers (`fs`, `shell`,
 * `search`). Every `@deepseek-ai/*` and node builtin stays external — at
 * runtime they resolve from the harness's own dependency tree, and the preset
 * installer references `lib/fs.js` / `lib/shell.js` / `lib/search.js` by
 * absolute path, so those entry names are load-bearing.
 *
 * Browser half: the closure-factory bundle the client registry serves
 * (`window.__ModuleLoader__.load`). Externals are the platform module table.
 */

const NODE_EXTERNALS = [/^@deepseek-ai\//, /^node:/, ...builtinModules]

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: 'dsh-wsl',
    entry: {
      index: 'src/index.ts',
      fs: 'src/fs.ts',
      shell: 'src/shell.ts',
      search: 'src/search.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: true,
    sourcemap: false,
    external: NODE_EXTERNALS,
  },
  {
    name: 'dsh-wsl/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    external: CLIENT_EXTERNALS,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-wsl", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
