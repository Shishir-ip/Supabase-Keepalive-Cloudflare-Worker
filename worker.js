const DEFAULT_UI_PIN = 'YOUR_PIN';
const DEFAULT_KEEPALIVE_SECRET = 'YOUR_KEEPALIVE_SECRET';
const DEFAULT_COOKIE_SECRET = 'YOUR_COOKIE_SECRET';

const KV_KEY = 'supabase_keepalive_projects_v1';
const RPC_PATH = '/rest/v1/rpc/cf_keepalive_ping';
const COOKIE_NAME = 'sb_keepalive_auth';

function getPin(env) {
  return (env && env.UI_PIN ? String(env.UI_PIN) : DEFAULT_UI_PIN).trim();
}

function getKeepaliveSecret(env) {
  return env && env.KEEPALIVE_SECRET
    ? String(env.KEEPALIVE_SECRET)
    : DEFAULT_KEEPALIVE_SECRET;
}

function getCookieSecret(env) {
  return env && env.COOKIE_SECRET
    ? String(env.COOKIE_SECRET)
    : DEFAULT_COOKIE_SECRET;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...headers,
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
    },
  });
}

function getCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return '';

  const parts = header.split(';');
  for (const part of parts) {
    const pieces = part.trim().split('=');
    if (pieces[0] === name) {
      return decodeURIComponent(pieces.slice(1).join('='));
    }
  }

  return '';
}

async function makeToken(env) {
  const enc = new TextEncoder();
  const secret = getCookieSecret(env);
  const payload = 'keepalive:' + getPin(env) + ':v1';

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(payload)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function isAuthed(request, env) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;

  const expected = await makeToken(env);
  return cookie === expected;
}

async function setCookieHeader(env) {
  const token = await makeToken(env);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeSupabaseUrl(input) {
  let url = String(input || '').trim();

  if (!url) return '';

  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  url = url.replace(/\/+$/, '');
  url = url.replace(/\/rest\/v1.*$/i, '');
  url = url.replace(/\/+$/, '');

  return url;
}

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';

  if (value.length <= 12) {
    return '*'.repeat(value.length);
  }

  return value.slice(0, 6) + '...' + value.slice(-4);
}

async function getProjects(env) {
  if (!env || !env.PROJECTS_KV) return [];

  try {
    const data = await env.PROJECTS_KV.get(KV_KEY, 'json');
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('KV get error:', err);
    return [];
  }
}

async function saveProjects(env, projects) {
  if (!env || !env.PROJECTS_KV) return;
  await env.PROJECTS_KV.put(KV_KEY, JSON.stringify(projects));
}

function kvMissing(env) {
  return !env || !env.PROJECTS_KV;
}

async function keepAliveProject(project, env) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const base = normalizeSupabaseUrl(project.url);
    const endpoint = base + RPC_PATH;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: project.anonKey,
        Authorization: `Bearer ${project.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: getKeepaliveSecret(env),
      }),
      signal: controller.signal,
    });

    const text = await res.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!res.ok) {
      let message = `${res.status} ${res.statusText || 'error'}`;

      if (data && typeof data === 'object') {
        if (data.message) message = data.message;
        else if (data.error) message = data.error;
        else if (data.msg) message = data.msg;
        else if (text) message = text;
      } else if (text) {
        message = text;
      }

      return {
        ok: false,
        status: res.status,
        error: message,
      };
    }

    return {
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      data,
    };
  } catch (err) {
    const message =
      err && err.name === 'AbortError'
        ? 'Request timed out after 30 seconds'
        : String(err && err.message ? err.message : err);

    return {
      ok: false,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runAll(env, source) {
  const projects = await getProjects(env);

  if (!projects.length) {
    return {
      ok: true,
      source,
      checkedAt: new Date().toISOString(),
      total: 0,
      okCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  const results = new Array(projects.length);
  const concurrency = Math.min(5, projects.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < projects.length) {
      const i = currentIndex++;
      const project = projects[i];

      const result = await keepAliveProject(project, env);

      project.lastRunAt = new Date().toISOString();
      project.lastSource = source;
      project.lastStatus = result.ok
        ? 'ok'
        : String(result.error || 'error').slice(0, 300);

      results[i] = {
        id: project.id,
        name: project.name || project.url,
        ok: result.ok,
        status: result.status,
        ms: result.ms,
        error: result.error,
        data: result.data,
      };
    }
  }

  await Promise.all(
    Array.from(
      {
        length: concurrency,
      },
      worker
    )
  );

  await saveProjects(env, projects);

  const okCount = results.filter((r) => r && r.ok).length;

  return {
    ok: true,
    source,
    checkedAt: new Date().toISOString(),
    total: projects.length,
    okCount,
    failedCount: projects.length - okCount,
    results,
  };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') {
    const body = await readJson(request);
    const pin = String(body.pin || '').trim();

    if (pin === getPin(env)) {
      return jsonResponse(
        {
          ok: true,
        },
        200,
        {
          'Set-Cookie': await setCookieHeader(env),
        }
      );
    }

    return jsonResponse(
      {
        error: 'Wrong PIN',
      },
      401
    );
  }

  if (path === '/api/logout' && method === 'POST') {
    return jsonResponse(
      {
        ok: true,
      },
      200,
      {
        'Set-Cookie': clearCookieHeader(),
      }
    );
  }

  const authed = await isAuthed(request, env);

  if (!authed) {
    return jsonResponse(
      {
        error: 'Unauthorized',
      },
      401
    );
  }

  if (path === '/api/me' && method === 'GET') {
    return jsonResponse({
      ok: true,
    });
  }

  if (kvMissing(env)) {
    return jsonResponse(
      {
        error:
          'KV binding PROJECTS_KV is missing. Bind a KV namespace to this Worker with the variable name PROJECTS_KV.',
      },
      500
    );
  }

  if (path === '/api/projects' && method === 'GET') {
    const projects = await getProjects(env);

    return jsonResponse({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name || '',
        url: p.url,
        maskedKey: maskKey(p.anonKey),
        createdAt: p.createdAt || null,
        lastRunAt: p.lastRunAt || null,
        lastStatus: p.lastStatus || null,
      })),
    });
  }

  if (path === '/api/projects' && method === 'POST') {
    const body = await readJson(request);

    const name = String(body.name || '').trim();
    const projectUrl = normalizeSupabaseUrl(body.url);
    const anonKey = String(body.anonKey || '').trim();

    try {
      const parsed = new URL(projectUrl);
      if (parsed.protocol !== 'https:') {
        throw new Error('https only');
      }
    } catch {
      return jsonResponse(
        {
          error: 'Supabase URL must be a valid https URL.',
        },
        400
      );
    }

    if (!anonKey || anonKey.length < 20) {
      return jsonResponse(
        {
          error: 'Supabase anon key looks too short.',
        },
        400
      );
    }

    const projects = await getProjects(env);

    const duplicate = projects.some(
      (p) => p.url === projectUrl && p.anonKey === anonKey
    );

    if (duplicate) {
      return jsonResponse(
        {
          error: 'This project URL and anon key already exist.',
        },
        400
      );
    }

    const id =
      crypto.randomUUID ?
        crypto.randomUUID() :
        Date.now().toString(36) + Math.random().toString(36).slice(2);

    const project = {
      id,
      name,
      url: projectUrl,
      anonKey,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastStatus: null,
    };

    projects.push(project);
    await saveProjects(env, projects);

    return jsonResponse({
      ok: true,
      project: {
        id: project.id,
      },
    });
  }

  if (path === '/api/projects' && method === 'DELETE') {
    const id = url.searchParams.get('id');

    if (!id) {
      return jsonResponse(
        {
          error: 'Missing project id',
        },
        400
      );
    }

    const projects = await getProjects(env);
    const next = projects.filter((p) => p.id !== id);

    if (next.length === projects.length) {
      return jsonResponse(
        {
          error: 'Project not found',
        },
        404
      );
    }

    await saveProjects(env, next);

    return jsonResponse({
      ok: true,
    });
  }

  if (path === '/api/test' && method === 'POST') {
    const body = await readJson(request);
    const id = body.id;

    if (!id) {
      return jsonResponse(
        {
          error: 'Missing project id',
        },
        400
      );
    }

    const projects = await getProjects(env);
    const project = projects.find((p) => p.id === id);

    if (!project) {
      return jsonResponse(
        {
          error: 'Project not found',
        },
        404
      );
    }

    const result = await keepAliveProject(project, env);

    project.lastRunAt = new Date().toISOString();
    project.lastSource = 'manual-test';
    project.lastStatus = result.ok
      ? 'ok'
      : String(result.error || 'error').slice(0, 300);

    await saveProjects(env, projects);

    return jsonResponse({
      ok: result.ok,
      result,
      project: {
        id: project.id,
        lastRunAt: project.lastRunAt,
        lastStatus: project.lastStatus,
      },
    });
  }

  if (path === '/api/run' && method === 'POST') {
    const result = await runAll(env, 'manual');
    return jsonResponse(result);
  }

  return jsonResponse(
    {
      error: 'Not found',
    },
    404
  );
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Supabase Keepalive Login</title>
  <style>
    :root {
      color-scheme: dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, sans-serif;
      background:
        radial-gradient(circle at top, rgba(16, 185, 129, 0.18), transparent 30%),
        #020617;
      color: #e2e8f0;
      display: grid;
      place-items: center;
      padding: 24px;
    }

    .login-card {
      width: 100%;
      max-width: 380px;
      padding: 28px;
      border-radius: 18px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.14);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 22px;
    }

    p {
      margin: 0 0 18px;
      color: #94a3b8;
      line-height: 1.5;
      font-size: 14px;
    }

    label {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
      color: #94a3b8;
    }

    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(2, 6, 23, 0.65);
      color: #e2e8f0;
      outline: none;
      font: inherit;
    }

    input:focus {
      border-color: rgba(16, 185, 129, 0.65);
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.14);
    }

    button {
      margin-top: 16px;
      width: 100%;
      padding: 12px 14px;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, #10b981, #22c55e);
      color: #021207;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .error {
      margin-top: 14px;
      min-height: 18px;
      color: #fb7185;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>Supabase Keepalive</h1>
    <p>Enter the Worker PIN to continue.</p>

    <form id="login-form">
      <label for="pin">PIN</label>
      <input
        id="pin"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        required
      />
      <button id="login-button" type="submit">Enter</button>
      <div id="error" class="error"></div>
    </form>
  </div>

  <script>
    document.getElementById('login-form').addEventListener('submit', async function (e) {
      e.preventDefault();

      var pin = document.getElementById('pin').value;
      var btn = document.getElementById('login-button');
      var error = document.getElementById('error');

      btn.disabled = true;
      error.textContent = '';

      try {
        var res = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ pin: pin })
        });

        var data = await res.json().catch(function () {
          return {};
        });

        if (!res.ok) {
          throw new Error(data.error || 'Login failed');
        }

        window.location.href = '/';
      } catch (err) {
        error.textContent = err.message || 'Login failed';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Supabase Keepalive</title>
  <style>
    :root {
      color-scheme: dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, sans-serif;
      background:
        radial-gradient(circle at top, rgba(16, 185, 129, 0.16), transparent 28%),
        #020617;
      color: #e2e8f0;
      padding: 24px;
    }

    .container {
      width: 100%;
      max-width: 1000px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }

    .card {
      padding: 20px;
      border-radius: 18px;
      background: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(148, 163, 184, 0.14);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
    }

    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 20px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.16), rgba(34, 197, 94, 0.08));
      border: 1px solid rgba(16, 185, 129, 0.18);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    h2 {
      margin: 0 0 14px;
      font-size: 18px;
    }

    p {
      margin: 0;
      color: #94a3b8;
      line-height: 1.55;
      font-size: 14px;
    }

    .note {
      margin-top: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.14);
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.55;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      display: block;
      margin-bottom: 7px;
      color: #94a3b8;
      font-size: 14px;
    }

    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(2, 6, 23, 0.65);
      color: #e2e8f0;
      outline: none;
      font: inherit;
    }

    input:focus {
      border-color: rgba(16, 185, 129, 0.65);
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.14);
    }

    button {
      padding: 11px 14px;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, #10b981, #22c55e);
      color: #021207;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }

    button.secondary {
      background: rgba(148, 163, 184, 0.12);
      color: #e2e8f0;
      border: 1px solid rgba(148, 163, 184, 0.18);
      font-weight: 650;
    }

    button.danger {
      background: rgba(244, 63, 94, 0.12);
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.18);
      font-weight: 650;
    }

    button:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .projects {
      display: grid;
      gap: 12px;
    }

    .project {
      padding: 16px;
      border-radius: 16px;
      background: rgba(2, 6, 23, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .project-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .project-title {
      font-weight: 800;
      font-size: 16px;
      overflow-wrap: anywhere;
    }

    .project-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .project-meta {
      display: grid;
      gap: 7px;
      color: #94a3b8;
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .project-meta span {
      color: #64748b;
      margin-right: 6px;
      font-weight: 700;
    }

    .empty {
      padding: 18px;
      border-radius: 14px;
      border: 1px dashed rgba(148, 163, 184, 0.22);
      color: #94a3b8;
      line-height: 1.55;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: min(92vw, 420px);
      padding: 13px 15px;
      border-radius: 14px;
      display: none;
      z-index: 999;
      background: #052e16;
      color: #86efac;
      border: 1px solid rgba(34, 197, 94, 0.24);
      box-shadow: 0 18px 55px rgba(0, 0, 0, 0.35);
      font-size: 14px;
      line-height: 1.5;
    }

    .toast.error {
      background: #4c0519;
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.24);
    }

    @media (max-width: 700px) {
      body {
        padding: 14px;
      }

      header {
        display: grid;
        gap: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Supabase Keepalive</h1>
        <p>
          Keeps your Supabase projects active by running a dedicated read, delete,
          and insert in a dummy table.
        </p>
      </div>
    </header>

    <section class="card">
      <h2>Add Supabase project</h2>

      <form id="add-form">
        <div>
          <label for="project-name">Project name, optional</label>
          <input
            id="project-name"
            type="text"
            placeholder="My Supabase project"
            autocomplete="off"
          />
        </div>

        <div>
          <label for="project-url">Supabase URL</label>
          <input
            id="project-url"
            type="url"
            placeholder="https://abcdefgh.supabase.co"
            required
            autocomplete="off"
          />
        </div>

        <div>
          <label for="project-key">Supabase anon key</label>
          <input
            id="project-key"
            type="password"
            placeholder="eyJhbGciOi..."
            required
            autocomplete="off"
          />
        </div>

        <button id="add-btn" type="submit">Add project</button>
      </form>

      <div class="note">
        Run the Supabase SQL query in that project first. Then click Test after adding it.
      </div>
    </section>

    <section class="card">
      <div class="row">
        <h2 style="margin:0;">Projects</h2>

        <div class="actions">
          <button id="refresh-btn" class="secondary" type="button">Refresh</button>
          <button id="run-btn" type="button">Run all now</button>
          <button id="logout-btn" class="secondary" type="button">Log out</button>
        </div>
      </div>

      <div id="projects" class="projects"></div>
    </section>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        if (c === '&') return '&amp;';
        if (c === '<') return '&lt;';
        if (c === '>') return '&gt;';
        if (c === '"') return '&quot;';
        return '&#39;';
      });
    }

    function showToast(message, isError) {
      var toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = isError ? 'toast error' : 'toast';
      toast.style.display = 'block';

      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(function () {
        toast.style.display = 'none';
      }, 4500);
    }

    async function api(path, options) {
      options = options || {};
      options.headers = Object.assign(
        {
          'Content-Type': 'application/json'
        },
        options.headers || {}
      );

      var res = await fetch(path, options);

      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('Unauthorized');
      }

      var data = await res.json().catch(function () {
        return {};
      });

      if (!res.ok) {
        throw new Error(data.error || data.message || ('Request failed with ' + res.status));
      }

      return data;
    }

    async function loadProjects() {
      try {
        var data = await api('/api/projects');
        renderProjects(data.projects || []);
      } catch (err) {
        showToast(err.message, true);
      }
    }

    function renderProjects(projects) {
      var list = document.getElementById('projects');
      list.innerHTML = '';

      if (!projects.length) {
        list.innerHTML = '<div class="empty">No projects added yet. Add one above after running the SQL query in Supabase.</div>';
        return;
      }

      projects.forEach(function (p) {
        var card = document.createElement('div');
        card.className = 'project';

        var head = document.createElement('div');
        head.className = 'project-head';

        var title = document.createElement('div');
        title.className = 'project-title';
        title.textContent = p.name || p.url;

        var btns = document.createElement('div');
        btns.className = 'project-actions';

        var testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.textContent = 'Test';

        testBtn.onclick = async function () {
          testBtn.disabled = true;

          try {
            var data = await api('/api/test', {
              method: 'POST',
              body: JSON.stringify({ id: p.id })
            });

            if (data.ok) {
              showToast('Test succeeded for ' + (p.name || p.url) + '.');
              await loadProjects();
            } else {
              showToast(
                'Test failed: ' + ((data.result && data.result.error) || 'Unknown error'),
                true
              );
            }
          } catch (err) {
            showToast(err.message, true);
          }

          testBtn.disabled = false;
        };

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger';
        delBtn.textContent = 'Delete';

        delBtn.onclick = async function () {
          if (!confirm('Delete ' + (p.name || p.url) + '?')) return;

          try {
            await api('/api/projects?id=' + encodeURIComponent(p.id), {
              method: 'DELETE'
            });

            showToast('Project deleted.');
            await loadProjects();
          } catch (err) {
            showToast(err.message, true);
          }
        };

        btns.appendChild(testBtn);
        btns.appendChild(delBtn);

        head.appendChild(title);
        head.appendChild(btns);

        var lastRun = 'never';
        if (p.lastRunAt) {
          var d = new Date(p.lastRunAt);
          lastRun = isNaN(d.getTime()) ? p.lastRunAt : d.toLocaleString();
        }

        var meta = document.createElement('div');
        meta.className = 'project-meta';
        meta.innerHTML =
          '<div><span>URL</span>' + esc(p.url) + '</div>' +
          '<div><span>Anon key</span>' + esc(p.maskedKey) + '</div>' +
          '<div><span>Last run</span>' + esc(lastRun) + '</div>' +
          '<div><span>Status</span>' + esc(p.lastStatus || 'pending') + '</div>';

        card.appendChild(head);
        card.appendChild(meta);
        list.appendChild(card);
      });
    }

    async function addProject(e) {
      e.preventDefault();

      var form = e.target;
      var btn = document.getElementById('add-btn');

      btn.disabled = true;

      try {
        var payload = {
          name: document.getElementById('project-name').value,
          url: document.getElementById('project-url').value,
          anonKey: document.getElementById('project-key').value
        };

        await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        showToast('Project added. Click Test to verify it.');
        form.reset();
        await loadProjects();
      } catch (err) {
        showToast(err.message, true);
      }

      btn.disabled = false;
    }

    document.getElementById('add-form').addEventListener('submit', addProject);

    document.getElementById('refresh-btn').onclick = loadProjects;

    document.getElementById('run-btn').onclick = async function () {
      var btn = this;
      btn.disabled = true;

      try {
        var data = await api('/api/run', {
          method: 'POST'
        });

        showToast(
          'Run complete: ' + (data.okCount || 0) + ' succeeded, ' +
          (data.failedCount || 0) + ' failed.'
        );

        await loadProjects();
      } catch (err) {
        showToast(err.message, true);
      }

      btn.disabled = false;
    };

    document.getElementById('logout-btn').onclick = async function () {
      try {
        await api('/api/logout', {
          method: 'POST'
        });
      } catch (err) {
        // Ignore logout errors.
      }

      window.location.href = '/login';
    };

    loadProjects();
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/favicon.ico') {
        return new Response(null, {
          status: 204,
        });
      }

      if (path.startsWith('/api/')) {
        return await handleApi(request, env, ctx);
      }

      if (path === '/login') {
        if (await isAuthed(request, env)) {
          return redirect('/');
        }

        return htmlResponse(LOGIN_PAGE);
      }

      if (path === '/' || path === '/dashboard') {
        if (!(await isAuthed(request, env))) {
          return redirect('/login');
        }

        return htmlResponse(DASHBOARD_PAGE);
      }

      return redirect('/');
    } catch (err) {
      console.error('Worker error:', err);

      return jsonResponse(
        {
          error: 'Worker error',
          message: String(err && err.message ? err.message : err),
        },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    try {
      await runAll(env, 'cron');
    } catch (err) {
      console.error('Cron run error:', err);
    }
  },
};
