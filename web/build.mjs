import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/assets', { recursive: true });
await Promise.all([
  copyFile('index.html', 'dist/index.html'),
  copyFile('styles.css', 'dist/assets/styles.css'),
  build({
    entryPoints: ['src/app.ts'],
    outfile: 'dist/assets/app.js',
    bundle: true,
    format: 'esm',
    target: 'es2022',
  }),
]);
