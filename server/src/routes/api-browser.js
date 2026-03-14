import { Router } from 'express';

const router = Router();

// Override CSP for api-browser pages — inline scripts are required for the self-contained UI
router.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  next();
});

/**
 * Walk the Express router stack and extract all registered routes.
 * Returns an array of { method, path } sorted by path then method.
 */
function extractRoutes(app) {
  const routes = [];

  function getMountPath(layer) {
    // Express stores the mount path in different places depending on version
    if (layer.path && typeof layer.path === 'string') return layer.path;
    // Fallback: decode the regexp that Express generates for the mount path
    const src = layer.regexp?.source;
    if (!src) return '';

    // Handle parameterized mounts like /api/subnets/:subnetId/ranges
    // Express converts params to capture groups: ^\\/api\\/subnets\\/(?:([^\\/]+?))\\/ranges\\/?
    if (layer.keys?.length) {
      let path = src
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/')
        .replace(/\\-/g, '-')
        .replace(/\\./g, '.');
      // Replace param capture groups with :paramName
      // After unescaping, Express pattern looks like: (?:/([^/]+?))
      let keyIdx = 0;
      path = path.replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, () => {
        const name = layer.keys[keyIdx]?.name || 'param' + keyIdx;
        keyIdx++;
        return '/:' + name;
      });
      // Clean up trailing /?
      path = path.replace(/\/\?$/, '');
      return path;
    }

    // Simple mount: ^\\/api\\/auth\\/?(?=\\/|$)
    const m = src.match(/^\^\\\/([\w\-\\/\\:.]+)/);
    if (m) return '/' + m[1].replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\./g, '.');
    return '';
  }

  function walkStack(stack, basePath = '') {
    for (const layer of stack) {
      if (layer.route) {
        // Leaf route — has .methods
        const suffix = layer.route.path === '/' ? '' : layer.route.path;
        const routePath = (basePath + suffix).replace(/\/+/g, '/') || '/';
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) {
            routes.push({ method: method.toUpperCase(), path: routePath });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Mounted sub-router
        const prefix = basePath + getMountPath(layer);
        walkStack(layer.handle.stack, prefix);
      }
    }
  }

  if (app._router?.stack) {
    walkStack(app._router.stack);
  }

  // Filter to /api* routes only, deduplicate, sort
  const seen = new Set();
  return routes
    .filter(r => r.path.startsWith('/api') && !r.path.startsWith('/api-browser') && !r.path.startsWith('/api/setup'))
    .map(r => ({ ...r, path: r.path.replace(/\/$/, '') || '/' }))
    .filter(r => {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// GET /api-browser/routes — JSON endpoint for route list
router.get('/routes', (req, res) => {
  const routes = extractRoutes(req.app);
  res.json(routes);
});

// GET /api-browser — HTML interface
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildHtml());
});

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CIDRella API Browser</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #242836;
    --border: #2e3348; --text: #e1e4ed; --dim: #8b90a5;
    --accent: #6c8aff; --green: #4ade80; --yellow: #fbbf24;
    --red: #f87171; --blue: #60a5fa; --purple: #a78bfa;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--mono); background: var(--bg); color: var(--text); line-height: 1.5; }

  header {
    padding: 1.5rem 2rem 1rem; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
  }
  header h1 { font-size: 1.1rem; font-weight: 600; white-space: nowrap; }
  header h1 span { color: var(--accent); }

  .auth-bar {
    display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 300px;
  }
  .auth-bar label { color: var(--dim); font-size: 0.75rem; white-space: nowrap; }
  .auth-bar input {
    flex: 1; background: var(--surface); border: 1px solid var(--border);
    color: var(--text); padding: 0.4rem 0.6rem; border-radius: 4px;
    font-family: var(--mono); font-size: 0.75rem;
  }
  .auth-bar input:focus { outline: none; border-color: var(--accent); }
  .auth-bar button {
    background: var(--accent); color: #fff; border: none; padding: 0.4rem 0.8rem;
    border-radius: 4px; cursor: pointer; font-family: var(--mono); font-size: 0.75rem;
    white-space: nowrap;
  }
  .auth-bar button:hover { opacity: 0.85; }

  .toolbar {
    padding: 0.75rem 2rem; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
  }
  .filter-input {
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    padding: 0.4rem 0.6rem; border-radius: 4px; font-family: var(--mono);
    font-size: 0.8rem; width: 250px;
  }
  .filter-input:focus { outline: none; border-color: var(--accent); }
  .method-filters { display: flex; gap: 0.25rem; }
  .method-toggle {
    background: var(--surface); border: 1px solid var(--border); color: var(--dim);
    padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer;
    font-family: var(--mono); font-size: 0.7rem; font-weight: 600;
  }
  .method-toggle.active { color: #fff; }
  .method-toggle.active[data-method="GET"] { background: var(--green); border-color: var(--green); color: #000; }
  .method-toggle.active[data-method="POST"] { background: var(--blue); border-color: var(--blue); color: #000; }
  .method-toggle.active[data-method="PUT"] { background: var(--yellow); border-color: var(--yellow); color: #000; }
  .method-toggle.active[data-method="DELETE"] { background: var(--red); border-color: var(--red); color: #000; }
  .route-count { color: var(--dim); font-size: 0.75rem; margin-left: auto; }

  main { padding: 1rem 2rem 3rem; }

  .group-header {
    color: var(--dim); font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 1rem 0 0.25rem; border-bottom: 1px solid var(--border);
    margin-top: 0.5rem;
  }

  .route-row {
    display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.5rem;
    border-radius: 4px; cursor: pointer; transition: background 0.1s;
  }
  .route-row:hover { background: var(--surface); }
  .route-row.expanded { background: var(--surface); }

  .method-badge {
    font-size: 0.65rem; font-weight: 700; padding: 0.15rem 0.4rem;
    border-radius: 3px; min-width: 52px; text-align: center;
  }
  .method-badge.GET { background: rgba(74,222,128,0.15); color: var(--green); }
  .method-badge.POST { background: rgba(96,165,250,0.15); color: var(--blue); }
  .method-badge.PUT { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .method-badge.DELETE { background: rgba(248,113,113,0.15); color: var(--red); }

  .route-path { font-size: 0.8rem; }
  .route-path .param { color: var(--accent); }

  .try-panel {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    margin: 0.25rem 0 0.5rem 0; padding: 1rem; display: none;
  }
  .try-panel.open { display: block; }

  .try-panel .param-row {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;
  }
  .try-panel .param-label {
    color: var(--accent); font-size: 0.75rem; min-width: 120px;
  }
  .try-panel input, .try-panel textarea {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    padding: 0.35rem 0.5rem; border-radius: 4px; font-family: var(--mono);
    font-size: 0.75rem; flex: 1;
  }
  .try-panel textarea { min-height: 80px; resize: vertical; }
  .try-panel input:focus, .try-panel textarea:focus { outline: none; border-color: var(--accent); }

  .try-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .btn-send {
    background: var(--accent); color: #fff; border: none; padding: 0.4rem 1rem;
    border-radius: 4px; cursor: pointer; font-family: var(--mono); font-size: 0.75rem;
  }
  .btn-send:hover { opacity: 0.85; }
  .btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

  .response-panel {
    margin-top: 0.75rem; background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; overflow: hidden;
  }
  .response-status {
    padding: 0.35rem 0.6rem; font-size: 0.7rem; font-weight: 600;
    border-bottom: 1px solid var(--border); display: flex; gap: 1rem;
  }
  .response-status .code { font-weight: 700; }
  .response-status .code.ok { color: var(--green); }
  .response-status .code.err { color: var(--red); }
  .response-status .time { color: var(--dim); }
  .response-body {
    padding: 0.6rem; font-size: 0.72rem; max-height: 400px; overflow: auto;
    white-space: pre-wrap; word-break: break-all; color: var(--dim);
  }
</style>
</head>
<body>

<header>
  <h1><span>CIDRella</span> API Browser</h1>
  <div class="auth-bar">
    <label>Token:</label>
    <input type="text" id="token" placeholder="Paste JWT or click Login">
    <button onclick="doLogin()">Login</button>
  </div>
</header>

<div class="toolbar">
  <input class="filter-input" type="text" id="filter" placeholder="Filter routes..." oninput="renderRoutes()">
  <div class="method-filters">
    <button class="method-toggle active" data-method="GET" onclick="toggleMethod(this)">GET</button>
    <button class="method-toggle active" data-method="POST" onclick="toggleMethod(this)">POST</button>
    <button class="method-toggle active" data-method="PUT" onclick="toggleMethod(this)">PUT</button>
    <button class="method-toggle active" data-method="DELETE" onclick="toggleMethod(this)">DELETE</button>
  </div>
  <span class="route-count" id="routeCount"></span>
</div>

<main id="routeList"></main>

<script>
let allRoutes = [];
const activeMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);

async function init() {
  // Restore saved token
  const saved = localStorage.getItem('cidrella_api_token');
  if (saved) document.getElementById('token').value = saved;

  try {
    const res = await fetch('/api-browser/routes');
    allRoutes = await res.json();
    renderRoutes();
  } catch (e) {
    document.getElementById('routeList').innerHTML = '<p style="color:var(--red);padding:1rem">Failed to load routes</p>';
  }
}

function getToken() {
  const t = document.getElementById('token').value.trim();
  localStorage.setItem('cidrella_api_token', t);
  return t;
}

async function doLogin() {
  const user = prompt('Username:', 'admin');
  if (!user) return;
  const pass = prompt('Password:');
  if (!pass) return;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if (data.token) {
      document.getElementById('token').value = data.token;
      localStorage.setItem('cidrella_api_token', data.token);
      alert('Logged in as ' + data.user.username);
    } else {
      alert('Login failed: ' + (data.error || 'unknown error'));
    }
  } catch (e) {
    alert('Login failed: ' + e.message);
  }
}

function toggleMethod(btn) {
  const m = btn.dataset.method;
  if (activeMethods.has(m)) { activeMethods.delete(m); btn.classList.remove('active'); }
  else { activeMethods.add(m); btn.classList.add('active'); }
  renderRoutes();
}

function extractParams(path) {
  const matches = path.match(/:([\\w]+)/g);
  return matches ? matches.map(m => m.slice(1)) : [];
}

function highlightParams(path) {
  return path.replace(/:([\\w]+)/g, '<span class="param">:$1</span>');
}

function renderRoutes() {
  const filter = document.getElementById('filter').value.toLowerCase();
  const filtered = allRoutes.filter(r =>
    activeMethods.has(r.method) &&
    (r.path.toLowerCase().includes(filter) || r.method.toLowerCase().includes(filter))
  );

  // Group by prefix (first two path segments)
  const groups = {};
  for (const r of filtered) {
    const parts = r.path.split('/').filter(Boolean);
    const group = parts.length >= 2 ? '/' + parts.slice(0, 2).join('/') : '/';
    if (!groups[group]) groups[group] = [];
    groups[group].push(r);
  }

  let html = '';
  for (const [group, routes] of Object.entries(groups)) {
    html += '<div class="group-header">' + group + ' (' + routes.length + ')</div>';
    for (const r of routes) {
      const id = btoa(r.method + r.path).replace(/[^a-zA-Z0-9]/g, '');
      const params = extractParams(r.path);
      const needsBody = ['POST', 'PUT', 'PATCH'].includes(r.method);

      html += '<div class="route-row" onclick="togglePanel(\\'' + id + '\\')">';
      html += '  <span class="method-badge ' + r.method + '">' + r.method + '</span>';
      html += '  <span class="route-path">' + highlightParams(r.path) + '</span>';
      html += '</div>';
      html += '<div class="try-panel" id="panel-' + id + '">';

      for (const p of params) {
        html += '<div class="param-row">';
        html += '  <span class="param-label">:' + p + '</span>';
        html += '  <input type="text" data-param="' + p + '" placeholder="value">';
        html += '</div>';
      }

      // Query params input for GET
      if (r.method === 'GET') {
        html += '<div class="param-row">';
        html += '  <span class="param-label">?query</span>';
        html += '  <input type="text" data-query="1" placeholder="key=val&key2=val2">';
        html += '</div>';
      }

      if (needsBody) {
        html += '<div class="param-row">';
        html += '  <span class="param-label">Body (JSON)</span>';
        html += '  <textarea data-body="1" placeholder="&#123;&quot;key&quot;: &quot;value&quot;&#125;"></textarea>';
        html += '</div>';
      }

      html += '<div class="try-actions">';
      html += '  <button class="btn-send" onclick="event.stopPropagation(); sendRequest(\\'' + id + '\\', \\'' + r.method + '\\', \\'' + r.path + '\\')">Send</button>';
      html += '</div>';
      html += '<div class="response-panel" id="resp-' + id + '" style="display:none"></div>';
      html += '</div>';
    }
  }

  document.getElementById('routeList').innerHTML = html;
  document.getElementById('routeCount').textContent = filtered.length + ' / ' + allRoutes.length + ' routes';
}

function togglePanel(id) {
  const panel = document.getElementById('panel-' + id);
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  // Close all
  document.querySelectorAll('.try-panel.open').forEach(p => { p.classList.remove('open'); p.parentElement?.querySelector('.route-row')?.classList.remove('expanded'); });
  if (!isOpen) {
    panel.classList.add('open');
    panel.previousElementSibling?.classList.add('expanded');
  }
}

async function sendRequest(id, method, pathTemplate) {
  const panel = document.getElementById('panel-' + id);
  const respEl = document.getElementById('resp-' + id);
  const btn = panel.querySelector('.btn-send');
  const token = getToken();

  // Build URL with path params
  let url = pathTemplate;
  panel.querySelectorAll('input[data-param]').forEach(inp => {
    const val = inp.value.trim();
    if (val) url = url.replace(':' + inp.dataset.param, encodeURIComponent(val));
  });

  // Append query params
  const queryInput = panel.querySelector('input[data-query]');
  if (queryInput?.value.trim()) {
    url += '?' + queryInput.value.trim();
  }

  // Build request options
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;

  const bodyInput = panel.querySelector('textarea[data-body]');
  if (bodyInput?.value.trim()) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = bodyInput.value.trim();
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  const t0 = performance.now();

  try {
    const res = await fetch(url, opts);
    const elapsed = Math.round(performance.now() - t0);
    const contentType = res.headers.get('content-type') || '';
    let body;
    if (contentType.includes('json')) {
      body = JSON.stringify(await res.json(), null, 2);
    } else {
      body = await res.text();
    }

    const codeClass = res.status < 400 ? 'ok' : 'err';
    respEl.style.display = 'block';
    respEl.innerHTML =
      '<div class="response-status">' +
      '  <span class="code ' + codeClass + '">' + escHtml(res.status + ' ' + res.statusText) + '</span>' +
      '  <span class="time">' + elapsed + 'ms</span>' +
      '</div>' +
      '<div class="response-body">' + escHtml(body) + '</div>';
  } catch (e) {
    respEl.style.display = 'block';
    respEl.innerHTML =
      '<div class="response-status"><span class="code err">Error</span></div>' +
      '<div class="response-body">' + escHtml(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
</script>
</body>
</html>`;
}

export default router;
