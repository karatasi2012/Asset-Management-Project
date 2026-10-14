// Asset Ledger agent service (Cloudflare Worker).
// Receives a few facts about one car, asks Claude to search the web for the latest
// information on that model, and returns structured advice with source links.
//
// Settings (Cloudflare > your worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  (secret)  your key from console.anthropic.com
//   ALLOWED_ORIGIN     (text)    your site, e.g. https://your-username.github.io
//   APP_TOKEN          (secret)  a long random phrase; paste the same one into the app
//   MODEL              (text, optional) defaults to claude-sonnet-5-5

const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || 'null'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-app-token',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405, cors);
    if (!allowed.includes(origin)) return reply({ error: 'This site is not allowed to use the agent' }, 403, cors);
    if (!env.APP_TOKEN || req.headers.get('x-app-token') !== env.APP_TOKEN) return reply({ error: 'Wrong or missing access token' }, 401, cors);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: 'The service has no API key set' }, 500, cors);

    let body;
    try { body = await req.json(); } catch (e) { return reply({ error: 'Request was not valid JSON' }, 400, cors); }
    const car = cleanCar(body && body.car);
    if (!car.make && !car.model) return reply({ error: 'Send the car make and model' }, 400, cors);

    try {
      const out = await research(env, buildPrompt(car));
      return reply(out, 200, cors);
    } catch (e) {
      return reply({ error: String(e && e.message ? e.message : e).slice(0, 300) }, 502, cors);
    }
  }
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, cors) });
}

const s = (x, n) => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').slice(0, n);
const n = x => (Number.isFinite(Number(x)) ? Number(x) : null);

// Only known fields are accepted, so the service cannot be used as a general AI proxy.
function cleanCar(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    make: s(c.make, 40), model: s(c.model, 60), year: n(c.year), fuel: s(c.fuel, 20), region: s(c.region, 60),
    ageMonths: n(c.ageMonths), odometerKm: n(c.odometerKm), kmLast12Months: n(c.kmLast12Months),
    kmPerLitreLast12Months: n(c.kmPerLitreLast12Months), kmToNextService: n(c.kmToNextService),
    recentJobs: (Array.isArray(c.recentJobs) ? c.recentJobs : []).slice(0, 6).map(x => s(x, 90))
  };
}

function buildPrompt(f) {
  const facts = [
    'Fuel: ' + f.fuel, 'Age in our fleet: ' + f.ageMonths + ' months', 'Odometer: ' + f.odometerKm + ' km',
    'Driven in the last 12 months: ' + f.kmLast12Months + ' km',
    'Fuel economy over the last 12 months: ' + (f.kmPerLitreLast12Months ? f.kmPerLitreLast12Months + ' km per litre' : 'not recorded'),
    'Distance to next service: ' + (f.kmToNextService === null ? 'not tracked' : f.kmToNextService + ' km'),
    'Recent jobs: ' + (f.recentJobs.length ? f.recentJobs.join('; ') : 'none recorded')
  ].join('\n');
  return [
    'You are a fleet vehicle advisor helping a company in ' + (f.region || 'East Africa') + ' run its cars economically and reliably.',
    'Vehicle: ' + [f.year || '', f.make, f.model].filter(Boolean).join(' ') + '.',
    'Facts from the company records:\n' + facts,
    'Search the web for the latest official and reputable information on this model and its recent updates. Prefer manufacturer, regulator and well-known motoring sources, and note the date of what you find.',
    'Cover: (1) advancements: notable recent updates, facelifts, new generation, engine, safety, efficiency or software changes, and any recalls or service campaigns that apply to this model and year; (2) improvements: practical, safe, legal ways to improve this car\'s performance, reliability, fuel economy or running cost, tailored to the facts above (maintenance practice, tyres and pressures, driving habits, genuine updates and parts, fuel quality, helpful accessories); (3) watchouts: known weak points for this model and what to inspect.',
    'Rules: never suggest anything that removes emission equipment, voids the warranty, or is unsafe or illegal. If unsure, say so and mark low confidence. Say when to check with the dealer. Keep each item short and concrete.',
    'Your final message must be only one JSON object and no other text: {"summary": string (2-3 sentences), "advancements": [{"title": string, "detail": string, "when": string}] (up to 6), "improvements": [{"action": string, "why": string, "effect": string, "effort": "low"|"medium"|"high", "caution": string}] (up to 8), "watchouts": [{"issue": string, "detail": string}] (up to 5), "fleetNote": string (one sentence on what the company records suggest), "confidence": "high"|"medium"|"low"}'
  ].join('\n\n');
}

async function research(env, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  let blocks = [];
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', max_tokens: 4000, tools: [SEARCH_TOOL], messages })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic API error ' + r.status));
    blocks = blocks.concat(j.content || []);
    if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue; }
    break;
  }
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const seen = new Set(), sources = [];
  const add = (url, title) => { if (url && /^https?:\/\//i.test(url) && !seen.has(url) && sources.length < 12) { seen.add(url); sources.push({ title: s(title || url, 140), url }); } };
  blocks.forEach(b => {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(x => add(x.url, x.title));
    if (b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach(x => add(x.url, x.title));
  });
  let data = null;
  const a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) { try { data = JSON.parse(text.slice(a, z + 1)); } catch (e) { data = null; } }
  return { data, sources, searchedAt: new Date().toISOString() };
}
