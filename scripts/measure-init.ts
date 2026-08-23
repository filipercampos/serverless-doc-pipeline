/**
 * Measures module initialisation time of each bundled handler in a fresh Node process
 * (the part of a cold start our code controls: parsing the bundle + module-scope composition).
 * It does NOT include Lambda sandbox creation or runtime bootstrap; numbers are relative.
 *
 *   npm run build && npm run measure:init
 */
import { execFileSync } from 'node:child_process';

const handlers = ['create-upload', 'query-documents', 'process-uploads'];
const runs = Number(process.env.RUNS ?? 15);

const env = {
  ...process.env,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'x',
  AWS_SECRET_ACCESS_KEY: 'x',
  DOCUMENTS_TABLE: 't',
  UPLOAD_BUCKET: 'b',
  EVENT_BUS_NAME: 'e',
  IDEMPOTENCY_TABLE: 'i',
  POWERTOOLS_TRACE_ENABLED: 'false',
  POWERTOOLS_LOG_LEVEL: 'SILENT',
};

const probe = (file: string) =>
  `const t=process.hrtime.bigint();require(${JSON.stringify(file)});` +
  `process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6))`;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const rows = handlers.map((name) => {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const out = execFileSync(process.execPath, ['-e', probe(`./dist/${name}/index.js`)], { env });
    samples.push(Number(out.toString()));
  }
  samples.sort((a, b) => a - b);
  return {
    handler: name,
    runs,
    p50ms: percentile(samples, 50).toFixed(1),
    p90ms: percentile(samples, 90).toFixed(1),
    maxms: samples[samples.length - 1]!.toFixed(1),
  };
});

console.log(`node ${process.version} ${process.platform}/${process.arch}`);
console.table(rows);
