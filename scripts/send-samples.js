#!/usr/bin/env node
// Posts every lead in samples/leads.json to the webhook and checks the route.
//   node scripts/send-samples.js [webhookUrl]
const leads = require('../samples/leads.json');

const url = process.argv[2] || 'http://localhost:5678/webhook/lead-intake';

(async () => {
  let pass = 0;
  for (const { expect, ...lead } of leads) {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lead),
    });
    const body = await res.json().catch(() => ({}));
    const got = res.status === 400 ? 'invalid' : body.route;
    const ok = got === expect;
    if (ok) pass++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${lead.name.padEnd(16)} expected=${expect.padEnd(8)} got=${String(got).padEnd(8)}` +
      ` score=${body.score ?? '-'}  intent=${body.intent ?? '-'}  ${Date.now() - t0}ms`,
    );
    if (body.summary) console.log(`      ↳ ${body.summary}`);
  }
  console.log(`\n${pass}/${leads.length} routed as expected`);
  process.exit(pass === leads.length ? 0 : 1);
})();
