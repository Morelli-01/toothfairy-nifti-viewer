import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
  },
  {
    entryPoints: ['src/webview.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    sourcemap: true,
    loader: { '.glsl': 'text' },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
