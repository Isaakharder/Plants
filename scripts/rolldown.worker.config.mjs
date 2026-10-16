// Bundles the forecast lock worker into one Node file (dist-worker/).
export default {
  input: 'scripts/forecast-lock-worker.ts',
  platform: 'node',
  output: { file: 'dist-worker/forecast-lock-worker.js', format: 'esm' },
}
