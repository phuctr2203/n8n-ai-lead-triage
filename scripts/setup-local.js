#!/usr/bin/env node
// One-time setup for a fresh local n8n: creates the owner account (if none) and the `leads` Data Table.
//   N8N_OWNER_EMAIL=you@example.test N8N_OWNER_PASSWORD=... node scripts/setup-local.js [http://localhost:5678]
const base = process.argv[2] || 'http://localhost:5678';
const email = process.env.N8N_OWNER_EMAIL;
const password = process.env.N8N_OWNER_PASSWORD;
if (!email || !password) {
  console.error('Set N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD');
  process.exit(1);
}

const COLUMNS = [
  ['lead_id', 'string'], ['received_at', 'string'], ['name', 'string'], ['email', 'string'],
  ['company', 'string'], ['source', 'string'], ['intent', 'string'], ['urgency', 'string'],
  ['budget_usd', 'number'], ['timeline', 'string'], ['company_size', 'string'], ['use_case', 'string'],
  ['summary', 'string'], ['suggested_reply', 'string'], ['score', 'number'], ['route', 'string'],
].map(([name, type]) => ({ name, type }));

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(base + '/rest' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: body && JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  const setup = await api('POST', '/owner/setup', { email, password, firstName: 'Demo', lastName: 'Owner' });
  if (setup.status !== 200) {
    const login = await api('POST', '/login', { emailOrLdapLoginId: email, password });
    if (login.status !== 200) throw new Error(`login failed (${login.status}): ${JSON.stringify(login.json)}`);
    console.log('owner exists, logged in');
  } else {
    console.log('owner created');
  }

  const project = (await api('GET', '/projects/personal')).json.data;
  const existing = (await api('GET', `/projects/${project.id}/data-tables`)).json.data;
  const list = Array.isArray(existing) ? existing : existing?.data ?? [];
  if (list.some((t) => t.name === 'leads')) {
    console.log('data table "leads" already exists');
  } else {
    const t = await api('POST', `/projects/${project.id}/data-tables`, { name: 'leads', columns: COLUMNS });
    if (t.status !== 200) throw new Error(`create table failed (${t.status}): ${JSON.stringify(t.json)}`);
    console.log('data table "leads" created:', t.json.data.id);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
