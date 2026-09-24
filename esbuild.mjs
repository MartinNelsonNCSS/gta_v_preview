import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const toolsOnly = process.argv.includes('--tools');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions[]} */
const builds = toolsOnly
  ? [
      { ...common, entryPoints: ['tools/inspect.ts'], outfile: 'out/inspect.js', platform: 'node', format: 'cjs' },
      { ...common, entryPoints: ['tools/harness/host.ts'], outfile: 'out/harness.js', platform: 'browser', format: 'iife' },
    ]
  : [
      // Desktop extension host (Node).
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        external: ['vscode'],
        target: 'node18',
      },
      // Web extension host (vscode.dev / github.dev).
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.web.js',
        platform: 'browser',
        format: 'cjs',
        external: ['vscode'],
        target: 'es2022',
      },
      // Webview UI.
      {
        ...common,
        entryPoints: { webview: 'src/webview/main.ts' },
        outdir: 'dist',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
      },
      {
        ...common,
        entryPoints: { webview: 'src/webview/styles.css' },
        outdir: 'dist',
      },
    ];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
