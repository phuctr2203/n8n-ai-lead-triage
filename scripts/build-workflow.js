#!/usr/bin/env node
// Generates the importable n8n workflow JSON.
//   node scripts/build-workflow.js            -> workflow/ai-lead-triage.json (Gemini)
//   node scripts/build-workflow.js --ollama   -> workflow/ai-lead-triage.ollama.json (local model, no API key)
const fs = require('fs');
const path = require('path');

const useOllama = process.argv.includes('--ollama');

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['sales_inquiry', 'support_request', 'partnership', 'job_application', 'spam', 'other'],
      description: 'Primary reason the person is reaching out',
    },
    urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
    budget_usd: {
      type: ['number', 'null'],
      description: 'Budget in USD if stated or clearly implied, otherwise null',
    },
    timeline: { type: 'string', description: 'Requested timeline, or "unspecified"' },
    company_size: { type: 'string', enum: ['solo', 'small', 'mid_market', 'enterprise', 'unknown'] },
    use_case: { type: 'string', description: 'What they want built or solved, in under 15 words' },
    summary: { type: 'string', description: 'One-sentence summary for a sales rep' },
    suggested_reply: { type: 'string', description: 'A short, friendly first reply (max 80 words)' },
  },
  required: ['intent', 'urgency', 'budget_usd', 'timeline', 'company_size', 'use_case', 'summary', 'suggested_reply'],
};

const SYSTEM_PROMPT = `You are a lead-qualification assistant for an AI consultancy that builds AI agents, RAG chatbots and document-automation pipelines.
Extract the requested fields from the inbound message. Rules:
- Only use facts present in the message; never invent a budget. Convert other currencies to approximate USD.
- "spam" = marketing blasts, SEO/backlink offers, crypto, or irrelevant mass mail.
- urgency is "high" when the sender names a deadline within ~4 weeks or describes a blocking problem.
- suggested_reply must be addressed to the sender by first name and ask one clarifying question.`;

const NORMALIZE_JS = `// Accepts a website form / email-parser payload and normalises it.
return $input.all().map((item) => {
  const b = item.json.body ?? item.json;
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const email = clean(b.email).toLowerCase();
  return {
    json: {
      lead_id: 'lead_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      received_at: new Date().toISOString(),
      name: clean(b.name) || 'there',
      email,
      company: clean(b.company),
      source: clean(b.source) || 'webhook',
      message: clean(b.message).slice(0, 4000),
      valid: /.+@.+\\..+/.test(email) && clean(b.message).length > 0,
    },
  };
});`;

// Deterministic scoring keeps routing auditable: the LLM extracts, code decides.
const SCORE_JS = `const INTENT = { sales_inquiry: 40, partnership: 25, other: 5, support_request: 0, job_application: 0, spam: -100 };
const URGENCY = { high: 20, medium: 10, low: 0 };
const SIZE = { enterprise: 20, mid_market: 15, small: 10, solo: 5, unknown: 5 };

return $input.all().map((item, i) => {
  const lead = $('Normalize Input').all()[i].json;
  const ai = item.json.output;
  const budget = typeof ai.budget_usd === 'number' ? ai.budget_usd : null;
  const budgetPts = budget === null ? 0 : budget >= 10000 ? 20 : budget >= 3000 ? 15 : budget >= 1000 ? 8 : 0;

  const score = Math.max(0, Math.min(100,
    (INTENT[ai.intent] ?? 0) + (URGENCY[ai.urgency] ?? 0) + (SIZE[ai.company_size] ?? 5) + budgetPts));

  let route = 'nurture';
  if (ai.intent === 'spam') route = 'discard';
  else if (ai.intent === 'support_request') route = 'support';
  else if (ai.intent === 'job_application') route = 'discard';
  else if (score >= 70) route = 'hot';

  return {
    json: {
      ...lead,
      intent: ai.intent,
      urgency: ai.urgency,
      budget_usd: budget,
      timeline: ai.timeline,
      company_size: ai.company_size,
      use_case: ai.use_case,
      summary: ai.summary,
      suggested_reply: ai.suggested_reply,
      score,
      route,
    },
  };
});`;

const HOT_ALERT_JS = `// Slack-ready alert. Swap this node for a Slack / Teams / Gmail node in production.
return $input.all().map(({ json: l }) => ({
  json: {
    channel: '#sales-hot-leads',
    text: [
      \`🔥 *Hot lead (\${l.score}/100)*: \${l.name}\${l.company ? ' @ ' + l.company : ''}\`,
      \`> \${l.summary}\`,
      \`Budget: \${l.budget_usd ? '$' + l.budget_usd.toLocaleString('en-US') : 'not stated'} · Timeline: \${l.timeline} · Urgency: \${l.urgency}\`,
      \`Draft reply ready. Email: \${l.email}\`,
    ].join('\\n'),
    lead_id: l.lead_id,
  },
}));`;

const TICKET_JS = `// Help-desk ticket payload. Swap for a Zendesk / Jira / Freshdesk node in production.
return $input.all().map(({ json: l }) => ({
  json: {
    subject: \`[\${l.urgency.toUpperCase()}] \${l.use_case}\`,
    requester: l.email,
    priority: l.urgency === 'high' ? 'urgent' : 'normal',
    description: l.message,
    ai_summary: l.summary,
    lead_id: l.lead_id,
  },
}));`;

const NURTURE_JS = `// Nurture-sequence enrolment payload. Swap for a Brevo / HubSpot / Mailchimp node in production.
return $input.all().map(({ json: l }) => ({
  json: { list: 'ai-services-nurture', email: l.email, first_name: l.name.split(' ')[0], tags: [l.intent, l.company_size], lead_id: l.lead_id },
}));`;

const CRM_COLUMNS = [
  'lead_id', 'received_at', 'name', 'email', 'company', 'source', 'intent', 'urgency',
  'budget_usd', 'timeline', 'company_size', 'use_case', 'summary', 'suggested_reply', 'score', 'route',
];

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id, name, type, typeVersion, position, ...extra,
});

const nodes = [
  node('a1', 'Lead Intake (Webhook)', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
    httpMethod: 'POST',
    path: 'lead-intake',
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: '6b1c3f0e-2a4d-4c8e-9a51-7d1f0c2b9e11' }),
  node('a2', 'Normalize Input', 'n8n-nodes-base.code', 2, [220, 0], { jsCode: NORMALIZE_JS }),
  node('a3', 'Valid?', 'n8n-nodes-base.if', 2.2, [440, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'c1', leftValue: '={{ $json.valid }}', rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),
  node('a4', 'Reject Invalid', 'n8n-nodes-base.respondToWebhook', 1.4, [660, 200], {
    respondWith: 'json',
    responseBody: '={{ { "ok": false, "error": "email and message are required" } }}',
    options: { responseCode: 400 },
  }),
  node('a5', 'AI: Qualify Lead', '@n8n/n8n-nodes-langchain.informationExtractor', 1.2, [660, -20], {
    text: '=From: {{ $json.name }} <{{ $json.email }}>\nCompany: {{ $json.company || "not given" }}\nSource: {{ $json.source }}\n\nMessage:\n{{ $json.message }}',
    schemaType: 'manual',
    inputSchema: JSON.stringify(LEAD_SCHEMA, null, 2),
    options: { systemPromptTemplate: SYSTEM_PROMPT },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),
  useOllama
    ? node('a6', 'Ollama Chat Model', '@n8n/n8n-nodes-langchain.lmChatOllama', 1, [640, 200], {
      model: 'llama3.2:latest',
      options: { temperature: 0, format: 'json' },
    }, { credentials: { ollamaApi: { id: 'ollama-local', name: 'Ollama (local)' } } })
    : node('a6', 'Gemini Chat Model', '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1.2, [640, 200], {
      modelName: 'models/gemini-3.8-flash',
      options: { temperature: 0 },
    }, { credentials: { googlePalmApi: { id: 'gemini-api', name: 'Google Gemini API' } } }),
  node('a7', 'Score & Route', 'n8n-nodes-base.code', 2, [1000, -20], { jsCode: SCORE_JS }),
  node('a8', 'CRM: Save Lead', 'n8n-nodes-base.dataTable', 1.1, [1220, -20], {
    resource: 'row',
    operation: 'insert',
    dataTableId: { __rl: true, mode: 'name', value: 'leads' },
    columns: {
      mappingMode: 'defineBelow',
      value: Object.fromEntries(CRM_COLUMNS.map((c) => [c, `={{ $json.${c} }}`])),
      matchingColumns: [],
      schema: CRM_COLUMNS.map((c) => ({
        id: c, displayName: c, required: false, defaultMatch: false, display: true,
        type: ['budget_usd', 'score'].includes(c) ? 'number' : 'string',
        readOnly: false, removed: false,
      })),
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
    options: {},
  }),
  node('a9', 'Respond to Caller', 'n8n-nodes-base.respondToWebhook', 1.4, [1440, -20], {
    respondWith: 'json',
    responseBody: `={{ { "ok": true, "lead_id": $('Score & Route').item.json.lead_id, "intent": $('Score & Route').item.json.intent, "score": $('Score & Route').item.json.score, "route": $('Score & Route').item.json.route, "summary": $('Score & Route').item.json.summary } }}`,
    options: {},
  }),
  node('a10', 'Route', 'n8n-nodes-base.switch', 3.2, [1660, -20], {
    mode: 'expression',
    numberOutputs: 4,
    output: '={{ ({ hot: 0, nurture: 1, support: 2, discard: 3 })[$json.route] }}',
  }),
  node('a11', 'Hot Lead Alert', 'n8n-nodes-base.code', 2, [1900, -260], {
    jsCode: HOT_ALERT_JS,
  }),
  node('a12', 'Nurture Sequence', 'n8n-nodes-base.code', 2, [1900, -80], {
    jsCode: NURTURE_JS,
  }),
  node('a13', 'Support Ticket', 'n8n-nodes-base.code', 2, [1900, 100], {
    jsCode: TICKET_JS,
  }),
  node('a14', 'Discard (spam / jobs)', 'n8n-nodes-base.noOp', 1, [1900, 280], {}),
  node('n1', 'Sticky: Overview', 'n8n-nodes-base.stickyNote', 1, [-40, -420], {
    width: 760, height: 330, color: 4,
    content: '## AI Lead Triage\n**Inbound lead → LLM qualification → deterministic scoring → CRM → routed follow-up**\n\n1. A website form or email parser POSTs `{name, email, company, message, source}` to the webhook.\n2. The LLM extracts structured fields (intent, urgency, budget, timeline, company size, summary, draft reply) against a strict JSON schema.\n3. **Code, not the LLM, scores and routes** (0–100): auditable, testable, cheap.\n4. Every lead is saved to the `leads` Data Table (swap for HubSpot / Sheets / Airtable).\n5. Caller gets an instant JSON response; then the lead is routed: 🔥 hot alert · 🌱 nurture · 🛠 support ticket · 🗑 discard.',
  }),
  node('n2', 'Sticky: Model', 'n8n-nodes-base.stickyNote', 1, [560, 380], {
    width: 360, height: 150, color: 6,
    content: '### Model\nDefault: **Gemini Flash** (temperature 0). Swap for Claude, OpenAI or a local Ollama model by replacing this one sub-node, with no other changes.',
  }),
];

const connections = {
  'Lead Intake (Webhook)': { main: [[{ node: 'Normalize Input', type: 'main', index: 0 }]] },
  'Normalize Input': { main: [[{ node: 'Valid?', type: 'main', index: 0 }]] },
  'Valid?': { main: [
    [{ node: 'AI: Qualify Lead', type: 'main', index: 0 }],
    [{ node: 'Reject Invalid', type: 'main', index: 0 }],
  ] },
  [nodes.find((n) => n.id === 'a6').name]: { ai_languageModel: [[{ node: 'AI: Qualify Lead', type: 'ai_languageModel', index: 0 }]] },
  'AI: Qualify Lead': { main: [[{ node: 'Score & Route', type: 'main', index: 0 }]] },
  'Score & Route': { main: [[{ node: 'CRM: Save Lead', type: 'main', index: 0 }]] },
  'CRM: Save Lead': { main: [[{ node: 'Respond to Caller', type: 'main', index: 0 }]] },
  'Respond to Caller': { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
  Route: { main: [
    [{ node: 'Hot Lead Alert', type: 'main', index: 0 }],
    [{ node: 'Nurture Sequence', type: 'main', index: 0 }],
    [{ node: 'Support Ticket', type: 'main', index: 0 }],
    [{ node: 'Discard (spam / jobs)', type: 'main', index: 0 }],
  ] },
};

const workflow = {
  id: useOllama ? 'aiLeadTriageOllama' : 'aiLeadTriage01',
  name: useOllama ? 'AI Lead Triage (Ollama)' : 'AI Lead Triage',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
  pinData: {},
  active: false,
};

const out = path.join(__dirname, '..', 'workflow', useOllama ? 'ai-lead-triage.ollama.json' : 'ai-lead-triage.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log('wrote', path.relative(process.cwd(), out));
