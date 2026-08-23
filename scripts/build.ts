/**
 * Bundles each Lambda handler the same way `sam build` does (esbuild, minified, source maps)
 * and prints the bundle sizes. Used to keep an eye on cold-start cost (ADR 0007).
 *
 *   npm run build
 */
import { build, type Metafile } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const handlers = ['create-upload', 'query-documents', 'process-uploads'];

async function main(): Promise<void> {
  mkdirSync('dist', { recursive: true });
  const rows: { handler: string; kib: string; inputs: number }[] = [];
  for (const name of handlers) {
    const result = await build({
      entryPoints: [`src/handlers/${name}.ts`],
      outfile: join('dist', name, 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      minify: true,
      sourcemap: true,
      metafile: true,
      logLevel: 'warning',
    });
    const meta: Metafile = result.metafile;
    writeFileSync(join('dist', name, 'meta.json'), JSON.stringify(meta));
    const out = meta.outputs[join('dist', name, 'index.js').replace(/\\/g, '/')];
    rows.push({
      handler: name,
      kib: ((out?.bytes ?? 0) / 1024).toFixed(1),
      inputs: Object.keys(meta.inputs).length,
    });
  }
  console.table(rows);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
