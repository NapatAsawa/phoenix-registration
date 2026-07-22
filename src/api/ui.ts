import type { FastifyInstance } from 'fastify';

/**
 * The throwaway demo UI (issue #8): a single static page at `/` that drives the
 * whole registration flow by hand against the live API — register, resend, reveal
 * the latest confirmation link (the dev-only endpoint), and verify a pasted token.
 * It is deliberately dependency-free: one inlined HTML string, no build step, no
 * static-file server. The page talks to the same-origin API, so it works wherever
 * the API is reachable.
 *
 * "Reveal latest link" calls `GET /dev/latest-link`, which only exists outside
 * production; the page degrades gracefully (shows a hint) when it 404s.
 */
export function registerUiRoutes(app: FastifyInstance): void {
  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(PAGE);
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Phoenix Registration — demo</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  section { border: 1px solid #8886; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
  label { display: block; font-size: .85rem; margin: .5rem 0 .15rem; }
  input { width: 100%; padding: .5rem; box-sizing: border-box; font: inherit; }
  button { margin-top: .8rem; padding: .5rem 1rem; font: inherit; cursor: pointer; }
  .out { margin-top: .8rem; padding: .5rem .7rem; border-radius: 6px; background: #8881; white-space: pre-wrap; word-break: break-word; font-size: .85rem; min-height: 1.2rem; }
  .ok { box-shadow: inset 3px 0 #2a2; }
  .err { box-shadow: inset 3px 0 #c33; }
  a { word-break: break-all; }
</style>
</head>
<body>
<h1>Phoenix Registration — demo</h1>
<p>Throwaway UI to drive the flow by hand against the live API.</p>

<section>
  <h2>1. Register</h2>
  <label for="r-email">Email</label>
  <input id="r-email" type="email" value="alice@example.com" />
  <label for="r-pass">Password</label>
  <input id="r-pass" type="text" value="longenough" />
  <button id="r-btn">Register</button>
  <div class="out" id="r-out"></div>
</section>

<section>
  <h2>2. Resend confirmation</h2>
  <label for="s-email">Email</label>
  <input id="s-email" type="email" value="alice@example.com" />
  <button id="s-btn">Resend</button>
  <div class="out" id="s-out"></div>
</section>

<section>
  <h2>3. Reveal latest link (dev only)</h2>
  <p style="font-size:.85rem;margin:.2rem 0">Pulls the newest confirmation link and drops its token into the verify box.</p>
  <button id="l-btn">Reveal latest link</button>
  <div class="out" id="l-out"></div>
</section>

<section>
  <h2>4. Verify</h2>
  <label for="v-token">Token</label>
  <input id="v-token" type="text" placeholder="paste token or reveal it above" />
  <button id="v-btn">Verify</button>
  <div class="out" id="v-out"></div>
</section>

<script>
const $ = (id) => document.getElementById(id);
function show(el, ok, text) { el.textContent = text; el.className = 'out ' + (ok ? 'ok' : 'err'); }

$('r-btn').onclick = async () => {
  const res = await fetch('/registrations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('r-email').value, password: $('r-pass').value }),
  });
  const body = await res.text();
  show($('r-out'), res.ok, res.status + ' ' + body);
};

$('s-btn').onclick = async () => {
  const email = encodeURIComponent($('s-email').value.trim().toLowerCase());
  const res = await fetch('/registrations/' + email + '/resend', { method: 'POST' });
  const body = await res.text();
  show($('s-out'), res.ok, res.status + ' ' + body);
};

$('l-btn').onclick = async () => {
  const res = await fetch('/dev/latest-link');
  if (res.status === 404) { show($('l-out'), false, 'No link yet — register first, or the dev endpoint is disabled in production.'); return; }
  const data = await res.json();
  const token = new URL(data.link).searchParams.get('token');
  $('v-token').value = token || '';
  show($('l-out'), true, 'account ' + data.accountId + '\\n' + data.link);
};

$('v-btn').onclick = async () => {
  const token = encodeURIComponent($('v-token').value.trim());
  const res = await fetch('/verify?token=' + token);
  const body = await res.text();
  show($('v-out'), res.ok, res.status + ' ' + body);
};
</script>
</body>
</html>`;
