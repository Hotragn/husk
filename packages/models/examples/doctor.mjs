/**
 * What `husk doctor` renders from `ModelRouter.detect()`.
 *
 * Run it with nothing configured to see the free-path hints:
 *   node packages/models/examples/doctor.mjs
 *
 * Requires `npm run build --workspace=@husk/models` first.
 */

import { createLogger } from '@husk/core';
import { ModelRouter } from '@husk/models';

// Simulate a machine with nothing set up, whatever this one actually has.
if (process.argv.includes('--pristine')) {
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$|^OLLAMA_HOST$|^LMSTUDIO_HOST$/.test(key)) delete process.env[key];
  }
}

const router = new ModelRouter({ logger: createLogger({ level: 'silent' }) });
const started = Date.now();
const report = await router.detect();

console.log(`detect() took ${Date.now() - started}ms\n`);
console.log('PROVIDERS');
for (const p of report.providers) {
  const mark = p.available ? 'ok  ' : 'no  ';
  console.log(`  ${mark} ${p.displayName.padEnd(14)} ${p.available ? `${p.models} models` : p.reason}`);
  if (!p.available && p.hint) console.log(`       -> ${p.hint}`);
}

console.log('\nRECOMMENDED :', report.recommended ?? '(none)');
console.log('CHEAPEST    :', report.cheapest ?? '(none)');
console.log('\nHINTS');
for (const [i, hint] of report.hints.entries()) console.log(`  ${i + 1}. ${hint}`);

console.log('\nWhat happens if you ask for a model anyway:');
try {
  await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  console.log('  (a model answered)');
} catch (err) {
  console.log(`  ${err.code}: ${err.message}`);
  console.log(`  hint: ${err.hint}`);
}
