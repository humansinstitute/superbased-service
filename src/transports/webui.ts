import { nip19 } from 'nostr-tools';
import { getConfig } from '../config';

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderConnectionUiHtml(): string {
  const config = getConfig();
  const serverNpub = nip19.npubEncode(config.serverPublicKey);
  const defaultRelay = config.nostrRelays[0] || '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SuperBased Connection UI</title>
  <style>
    :root { --bg:#f6fbff; --ink:#0b1a2b; --card:#fff; --border:#d6e1ef; --accent:#0057ff; --ok:#0f7a3d; --sans:"Avenir Next","Segoe UI",sans-serif; --mono:"SFMono-Regular",Menlo,Consolas,monospace; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:var(--sans); color:var(--ink); background:linear-gradient(160deg,var(--bg),#fff); padding:24px; }
    .shell { max-width:920px; margin:0 auto; display:grid; gap:16px; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
    h1,h2 { margin:0 0 8px; }
    p { margin:6px 0; }
    label { display:block; margin:10px 0 6px; font-size:.9rem; }
    input,textarea { width:100%; border:1px solid var(--border); border-radius:10px; padding:10px; font-family:var(--mono); font-size:.86rem; }
    textarea { min-height:110px; }
    button { border:0; border-radius:10px; padding:10px 14px; font-weight:700; color:#fff; background:var(--accent); cursor:pointer; margin-top:10px; }
    .ok { color:var(--ok); font-size:.9rem; }
    .meta { font-family:var(--mono); font-size:.85rem; word-break:break-all; }
    .qr-wrap { margin-top:12px; display:grid; gap:8px; }
    #qr { width:220px; height:220px; border:1px solid var(--border); border-radius:10px; background:#fff; }
  </style>
</head>
<body>
  <main class="shell">
    <section class="card">
      <h1>SuperBased Connection Key</h1>
      <p>Create a connection key (base64 JSON) for quick copy/paste into apps.</p>
      <p class="meta">Server npub: ${escapeHtml(serverNpub)}</p>
      <p class="meta">Default HTTP: <span id="origin"></span></p>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Generate Key</h2>
        <label for="http">HTTP endpoint</label>
        <input id="http" type="text" />
        <label for="relay">Relay URL (optional)</label>
        <input id="relay" type="text" value="${escapeHtml(defaultRelay)}" />
        <label for="ttl">TTL seconds</label>
        <input id="ttl" type="number" min="60" max="31536000" value="2592000" />
        <label for="scopes">Scopes CSV (optional)</label>
        <input id="scopes" type="text" value="records:rw,schemas:r" />
        <button id="generate-token" type="button">Generate Connection Key</button>
        <div id="status"></div>
      </article>

      <article class="card">
        <h2>Decode Key</h2>
        <label for="decode_input">Paste base64 key</label>
        <textarea id="decode_input" placeholder="Paste key here..."></textarea>
        <button id="decode-token" type="button">Decode</button>
        <label for="decoded">Decoded JSON</label>
        <textarea id="decoded" readonly></textarea>
      </article>
    </section>

    <section class="card">
      <h2>Output</h2>
      <label for="token">Base64 connection key</label>
      <textarea id="token" readonly></textarea>
      <div class="qr-wrap">
        <label for="qr">QR code</label>
        <canvas id="qr" width="220" height="220"></canvas>
      </div>
      <p>Connection keys are metadata only. API auth remains NIP-98 per request.</p>
    </section>
  </main>

  <script>
    const qs = (id) => document.getElementById(id);
    const httpEl = qs('http');
    const relayEl = qs('relay');
    const ttlEl = qs('ttl');
    const scopesEl = qs('scopes');
    const tokenEl = qs('token');
    const statusEl = qs('status');
    const qrEl = qs('qr');
    let qrApi = null;

    const origin = window.location.origin;
    qs('origin').textContent = origin;
    httpEl.value = origin;

    function decodeBase64Json(v) {
      const json = decodeURIComponent(escape(atob(v.trim())));
      return JSON.parse(json);
    }

    async function getQrApi() {
      if (qrApi) return qrApi;
      try {
        const mod = await import('/ui/assets/qrcode.bundle.mjs');
        qrApi = mod && (mod.default || mod);
      } catch {
        qrApi = null;
      }
      return qrApi;
    }

    async function renderQr(value) {
      const text = (value || '').trim();
      const ctx = qrEl.getContext('2d');
      ctx.clearRect(0, 0, qrEl.width, qrEl.height);
      if (!text) return;

      const qr = await getQrApi();
      if (!qr || typeof qr.toCanvas !== 'function') {
        statusEl.className = '';
        statusEl.textContent = 'QR unavailable (network/CSP). Connection key is still valid.';
        return;
      }

      await qr.toCanvas(qrEl, text, {
        width: 220,
        margin: 1,
        color: { dark: '#0b1a2b', light: '#ffffff' },
      });
    }

    qs('generate-token').addEventListener('click', async () => {
      statusEl.textContent = '';
      tokenEl.value = '';
      const body = {
        http: httpEl.value.trim() || origin,
        relay: relayEl.value.trim() || undefined,
        ttl_seconds: Number(ttlEl.value || 2592000),
        scopes: scopesEl.value.trim() ? scopesEl.value.split(',').map(x => x.trim()).filter(Boolean) : undefined,
      };

      try {
        const res = await fetch(origin + '/connect/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        tokenEl.value = data.token || '';
        await renderQr(tokenEl.value);
        statusEl.className = 'ok';
        statusEl.textContent = 'Connection key generated.';
      } catch (err) {
        statusEl.className = '';
        statusEl.textContent = String(err);
      }
    });

    qs('decode-token').addEventListener('click', () => {
      try {
        const v = qs('decode_input').value;
        const parsed = decodeBase64Json(v);
        qs('decoded').value = JSON.stringify(parsed, null, 2);
      } catch (err) {
        qs('decoded').value = 'Invalid key: ' + String(err);
      }
    });
  </script>
</body>
</html>`;
}

export function renderUiLoginHtml(): string {
  const config = getConfig();
  const admin = config.adminNpubs[0] || '(ADMIN_NPUBS not configured)';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SuperBased Admin Login</title>
  <style>
    :root { --bg:#f6fbff; --ink:#0b1a2b; --card:#fff; --border:#d6e1ef; --accent:#0057ff; --sans:"Avenir Next","Segoe UI",sans-serif; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:var(--sans); color:var(--ink); background:linear-gradient(160deg,var(--bg),#fff); padding:24px; }
    main { max-width:760px; margin:0 auto; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; }
    button { border:0; border-radius:10px; padding:10px 14px; font-weight:700; color:#fff; background:var(--accent); cursor:pointer; }
    code { word-break:break-all; }
    #status { margin-top:12px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Admin Report Login</h1>
      <p>This page requires NIP-07 and an admin npub in <code>ADMIN_NPUBS</code>.</p>
      <p>Allowed admin: <code>${escapeHtml(admin)}</code></p>
      <button id="loginBtn" type="button">Login with NIP-07</button>
      <div id="status"></div>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    function setStatus(msg) { statusEl.textContent = msg; }

    async function login() {
      if (!window.nostr || typeof window.nostr.signEvent !== 'function') {
        setStatus('NIP-07 extension not found.');
        return;
      }
      try {
        const url = window.location.origin + '/ui/auth/login';
        const event = await window.nostr.signEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', url], ['method', 'POST']],
          content: '',
        });

        const auth = 'Nostr ' + btoa(JSON.stringify(event));
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth },
          credentials: 'include',
        });
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        window.location.href = '/ui';
      } catch (err) {
        setStatus(String(err));
      }
    }

    document.getElementById('loginBtn').addEventListener('click', login);
  </script>
</body>
</html>`;
}

export function renderUsageReportUiHtml(): string {
  const config = getConfig();
  const relayJson = JSON.stringify(config.nostrRelays);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SuperBased Retained Usage Report</title>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dexie@4/dist/dexie.min.js"></script>
  <style>
    :root { --bg:#f6fbff; --ink:#0b1a2b; --card:#fff; --border:#d6e1ef; --accent:#0057ff; --muted:#5a6f88; --sans:"Avenir Next","Segoe UI",sans-serif; --mono:"SFMono-Regular",Menlo,Consolas,monospace; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:var(--sans); color:var(--ink); background:linear-gradient(160deg,var(--bg),#fff); padding:18px; }
    .shell { max-width:1200px; margin:0 auto; display:grid; gap:12px; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; }
    .row { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    h1, h2 { margin:0; }
    button { border:0; border-radius:10px; padding:9px 12px; font-weight:700; color:#fff; background:var(--accent); cursor:pointer; }
    button:disabled { opacity:0.55; cursor:not-allowed; }
    select { border:1px solid var(--border); border-radius:10px; padding:8px 10px; font-family:var(--sans); min-width:240px; background:#fff; }
    table { width:100%; border-collapse:collapse; font-size:0.9rem; }
    th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--border); vertical-align:top; }
    th { color:var(--muted); font-weight:700; }
    .mono { font-family:var(--mono); }
    .user-cell { display:flex; gap:8px; align-items:flex-start; }
    .avatar { width:30px; height:30px; border-radius:999px; object-fit:cover; border:1px solid var(--border); background:#e9f1fc; }
    .meta-line { color:var(--muted); font-size:0.8rem; }
    .error-line { margin:8px 0 0; color:#b42318; font-size:0.84rem; }
    .status-box { margin-top:8px; font-size:0.82rem; color:var(--muted); }
    .table-wrap { overflow:auto; }
    .table-browser-table td { max-width:210px; }
    .table-browser-table summary { cursor:pointer; color:#0f3f9f; }
    .table-browser-controls { gap:10px; }
    .table-browser-pagination { margin-top:10px; }
    .sr-only {
      position:absolute;
      width:1px;
      height:1px;
      padding:0;
      margin:-1px;
      overflow:hidden;
      clip:rect(0,0,0,0);
      white-space:nowrap;
      border:0;
    }
    pre { margin:4px 0 0; white-space:pre-wrap; word-break:break-word; font-size:0.75rem; max-width:420px; }
  </style>
</head>
<body x-data="usageReportApp()" x-init="init()">
  <main class="shell">
    <section class="card row">
      <div>
        <h1>Retained Storage by Pubkey</h1>
        <div x-text="metaText"></div>
      </div>
      <div class="row">
        <button type="button" @click="refresh()">Refresh</button>
        <button type="button" @click="goConnect()">Connection Tools</button>
        <button type="button" @click="logout()">Logout</button>
      </div>
    </section>
    <section class="card">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>User</th>
            <th>Pubkey</th>
            <th>Retained</th>
            <th>Rows</th>
            <th>Live</th>
            <th>Encrypted</th>
            <th>Delegate</th>
          </tr>
        </thead>
        <tbody>
          <template x-for="(r, idx) in rows" :key="r.user_pubkey">
            <tr>
              <td class="mono" x-text="idx + 1"></td>
              <td>
                <div class="user-cell">
                  <img class="avatar" :src="profileFor(r.user_pubkey).picture || ''" alt="" x-show="profileFor(r.user_pubkey).picture" />
                  <div>
                    <div x-text="profileName(r.user_pubkey)"></div>
                    <div class="meta-line" x-text="profileFor(r.user_pubkey).nip05 || ''"></div>
                    <details>
                      <summary>kind0</summary>
                      <pre x-text="profileJson(r.user_pubkey)"></pre>
                    </details>
                  </div>
                </div>
              </td>
              <td class="mono" x-text="r.user_pubkey"></td>
              <td class="mono" x-text="fmtBytes(r.retained_bytes)"></td>
              <td class="mono" x-text="num(r.retained_rows)"></td>
              <td class="mono" x-text="num(r.live_records)"></td>
              <td class="mono" x-text="fmtBytes(r.encrypted_data_bytes)"></td>
              <td class="mono" x-text="fmtBytes(r.delegate_payload_bytes)"></td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <section class="card" aria-label="Postgres table browser" data-testid="pg-table-browser">
      <div class="row">
        <div>
          <h2>Postgres Table Browser</h2>
          <div class="meta-line" x-text="tableMetaText"></div>
        </div>
        <div class="row table-browser-controls">
          <label for="tableSelect" class="sr-only">Choose table</label>
          <select
            id="tableSelect"
            x-model="selectedTable"
            @change="selectTable(selectedTable)"
            aria-label="Choose table"
            data-testid="table-select"
            :disabled="tableNames.length === 0 || tableLoading"
          >
            <template x-for="name in tableNames" :key="name">
              <option :value="name" x-text="name"></option>
            </template>
          </select>
          <button
            type="button"
            @click="reloadTableNames()"
            aria-label="Refresh table list"
            data-testid="table-refresh"
            :disabled="tableLoading"
          >Refresh Tables</button>
        </div>
      </div>

      <div class="status-box" role="status" aria-live="polite" data-testid="table-status" x-text="tableStatusText"></div>
      <p class="error-line" role="alert" aria-live="assertive" x-show="tableError" x-text="tableError"></p>

      <div class="table-wrap" x-show="!tableLoading && tableRows.length > 0">
        <table class="table-browser-table" aria-label="Table rows" data-testid="table-data">
          <thead>
            <tr>
              <th>#</th>
              <template x-for="column in visibleTableColumns()" :key="'header-' + column">
                <th class="mono" x-text="column"></th>
              </template>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <template x-for="(row, idx) in tableRows" :key="(row.id || row.record_id || row.group_id || row.endpoint || idx) + '-' + idx">
              <tr>
                <td class="mono" x-text="tableOffset + idx + 1"></td>
                <template x-for="column in visibleTableColumns()" :key="'cell-' + idx + '-' + column">
                  <td class="mono" x-text="shortValue(row[column])"></td>
                </template>
                <td>
                  <details>
                    <summary>JSON</summary>
                    <pre x-text="JSON.stringify(row, null, 2)"></pre>
                  </details>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <p class="meta-line" x-show="!tableLoading && !tableError && tableRows.length === 0">No rows found.</p>

      <div class="row table-browser-pagination" x-show="tableTotal > 0">
        <button
          type="button"
          @click="prevTablePage()"
          aria-label="Previous table page"
          data-testid="table-prev"
          :disabled="tableOffset <= 0 || tableLoading"
        >Previous</button>
        <span class="mono" x-text="tableRangeText()"></span>
        <button
          type="button"
          @click="nextTablePage()"
          aria-label="Next table page"
          data-testid="table-next"
          :disabled="(tableOffset + tableLimit) >= tableTotal || tableLoading"
        >Next</button>
      </div>
    </section>
  </main>
  <script>
    const RELAYS = ${relayJson};
    const PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const PROFILE_FETCH_COOLDOWN_MS = 15 * 60 * 1000;
    const PROFILE_FETCH_WORKERS = 4;

    function usageReportApp() {
      return {
        rows: [],
        profiles: {},
        metaText: 'Loading...',
        db: null,
        inflight: new Map(),
        tableNames: [],
        selectedTable: '',
        tableColumns: [],
        tableRows: [],
        tableTotal: 0,
        tableOffset: 0,
        tableLimit: 25,
        tableLoading: false,
        tableError: '',
        tableMetaText: 'Loading tables...',
        tableStatusText: 'Loading...',

        async init() {
          this.db = new Dexie('superbased_admin_ui');
          this.db.version(1).stores({
            kind0_profiles: 'pubkey, fetched_at',
          });
          await this.refresh();
          await this.reloadTableNames();
        },

        fmtBytes(v) {
          const n = Number(v || 0);
          if (!Number.isFinite(n) || n <= 0) return '0 B';
          const units = ['B', 'KB', 'MB', 'GB', 'TB'];
          let x = n;
          let i = 0;
          while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
          return x.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
        },

        num(v) {
          return Number(v || 0).toLocaleString();
        },

        profileFor(pubkey) {
          return this.profiles[pubkey] || {};
        },

        profileName(pubkey) {
          const p = this.profileFor(pubkey);
          return p.display_name || p.name || p.nip05 || pubkey.slice(0, 12) + '...';
        },

        profileJson(pubkey) {
          const p = this.profileFor(pubkey);
          if (!p || !p.raw_kind0) return '{}';
          return JSON.stringify(p.raw_kind0, null, 2);
        },

        async refresh() {
          const data = await this.loadReport();
          this.rows = data.rows || [];
          this.metaText = 'Snapshot hour: ' + (data.captured_hour || '-') + ' | Users: ' + this.rows.length;
          await this.hydrateProfiles();
        },

        async fetchUiJson(path) {
          const res = await fetch(path, { credentials: 'include' });
          if (res.status === 401) {
            window.location.href = '/ui';
            return null;
          }
          const raw = await res.text();
          let data = {};
          try { data = JSON.parse(raw); } catch {}
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          return data;
        },

        async loadReport() {
          const data = await this.fetchUiJson('/ui/report');
          return data || { rows: [] };
        },

        visibleTableColumns() {
          return (this.tableColumns || []).slice(0, 6);
        },

        shortValue(value) {
          if (value === null || value === undefined) return '';
          const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
          if (text.length <= 120) return text;
          return text.slice(0, 117) + '...';
        },

        tablePageCount() {
          return Math.max(1, Math.ceil(this.tableTotal / this.tableLimit));
        },

        tablePageNumber() {
          return Math.floor(this.tableOffset / this.tableLimit) + 1;
        },

        tableRangeText() {
          if (this.tableTotal <= 0) return '0 rows';
          const start = this.tableOffset + 1;
          const end = Math.min(this.tableOffset + this.tableRows.length, this.tableTotal);
          return 'Rows ' + start + '-' + end + ' of ' + this.tableTotal + ' | page ' + this.tablePageNumber() + '/' + this.tablePageCount();
        },

        async reloadTableNames() {
          this.tableLoading = true;
          this.tableError = '';
          this.tableStatusText = 'Loading table list...';
          try {
            const data = await this.fetchUiJson('/ui/tables');
            const tableNames = Array.isArray(data?.tables) ? data.tables : [];
            this.tableNames = tableNames;

            if (tableNames.length === 0) {
              this.selectedTable = '';
              this.tableColumns = [];
              this.tableRows = [];
              this.tableTotal = 0;
              this.tableOffset = 0;
              this.tableMetaText = 'No superbased_* tables found.';
              this.tableStatusText = this.tableMetaText;
              return;
            }

            if (!tableNames.includes(this.selectedTable)) {
              this.selectedTable = tableNames[0];
              this.tableOffset = 0;
            }

            await this.loadSelectedTable();
          } catch (err) {
            this.tableError = String(err);
            this.tableStatusText = 'Failed to load table list.';
          } finally {
            this.tableLoading = false;
          }
        },

        async selectTable(name) {
          this.selectedTable = name || '';
          this.tableOffset = 0;
          await this.loadSelectedTable();
        },

        async loadSelectedTable() {
          if (!this.selectedTable) return;
          this.tableLoading = true;
          this.tableError = '';
          this.tableStatusText = 'Loading ' + this.selectedTable + '...';
          try {
            const path = '/ui/tables/' + encodeURIComponent(this.selectedTable)
              + '?limit=' + this.tableLimit
              + '&offset=' + this.tableOffset;
            const data = await this.fetchUiJson(path);
            this.tableColumns = Array.isArray(data?.columns) ? data.columns : [];
            this.tableRows = Array.isArray(data?.rows) ? data.rows : [];
            this.tableTotal = Number(data?.total || 0);
            this.tableMetaText = this.selectedTable + ' | total rows: ' + this.tableTotal;
            this.tableStatusText = this.tableRangeText();
          } catch (err) {
            this.tableRows = [];
            this.tableColumns = [];
            this.tableTotal = 0;
            this.tableError = String(err);
            this.tableStatusText = 'Failed to load table rows.';
          } finally {
            this.tableLoading = false;
          }
        },

        async prevTablePage() {
          if (this.tableLoading || this.tableOffset <= 0) return;
          this.tableOffset = Math.max(0, this.tableOffset - this.tableLimit);
          await this.loadSelectedTable();
        },

        async nextTablePage() {
          if (this.tableLoading) return;
          const nextOffset = this.tableOffset + this.tableLimit;
          if (nextOffset >= this.tableTotal) return;
          this.tableOffset = nextOffset;
          await this.loadSelectedTable();
        },

        async hydrateProfiles() {
          const pubkeys = Array.from(new Set(this.rows.map((r) => r.user_pubkey).filter(Boolean)));
          if (pubkeys.length === 0) return;

          const now = Date.now();
          const cachedRows = await this.db.kind0_profiles.where('pubkey').anyOf(pubkeys).toArray();
          const cachedByPubkey = new Map(cachedRows.map((r) => [r.pubkey, r]));
          const toRefresh = [];

          for (const pubkey of pubkeys) {
            const cached = cachedByPubkey.get(pubkey);
            if (cached) {
              this.profiles[pubkey] = cached;
            }

            const fetchedAt = Number(cached?.fetched_at || 0);
            const lastAttemptAt = Number(cached?.last_attempt_at || fetchedAt || now);
            const cacheFresh = fetchedAt > 0 && (now - fetchedAt) < PROFILE_CACHE_TTL_MS;
            const cooldownActive = (now - lastAttemptAt) < PROFILE_FETCH_COOLDOWN_MS;

            if (!cacheFresh && !cooldownActive) {
              toRefresh.push(pubkey);
            }
          }

          if (toRefresh.length === 0) return;

          let idx = 0;
          const worker = async () => {
            while (idx < toRefresh.length) {
              const myIdx = idx++;
              const pubkey = toRefresh[myIdx];
              await this.refreshSingleProfile(pubkey, now);
            }
          };

          const workers = Array.from({ length: Math.min(PROFILE_FETCH_WORKERS, toRefresh.length) }, () => worker());
          await Promise.all(workers);
        },

        async refreshSingleProfile(pubkey, nowTs) {
          const now = nowTs || Date.now();
          if (this.inflight.has(pubkey)) return this.inflight.get(pubkey);

          const run = (async () => {
            await this.db.kind0_profiles.put({
              pubkey,
              ...this.profileFor(pubkey),
              last_attempt_at: now,
            });

            const fresh = await this.fetchKind0(pubkey);
            if (!fresh) return;

            const record = {
              pubkey,
              name: fresh.name || '',
              display_name: fresh.display_name || '',
              about: fresh.about || '',
              picture: fresh.picture || '',
              nip05: fresh.nip05 || '',
              banner: fresh.banner || '',
              website: fresh.website || '',
              lud16: fresh.lud16 || '',
              raw_kind0: fresh,
              fetched_at: now,
              last_attempt_at: now,
            };
            this.profiles[pubkey] = record;
            await this.db.kind0_profiles.put(record);
          })();

          this.inflight.set(pubkey, run);
          try {
            await run;
          } finally {
            this.inflight.delete(pubkey);
          }
        },

        async fetchKind0(pubkey) {
          const attempts = RELAYS.map((relayUrl) => this.fetchKind0FromRelay(relayUrl, pubkey));
          const results = await Promise.all(attempts);
          for (const profile of results) {
            if (profile) return profile;
          }
          return null;
        },

        async fetchKind0FromRelay(relayUrl, pubkey) {
          return await new Promise((resolve) => {
            let settled = false;
            let ws;
            try {
              ws = new WebSocket(relayUrl);
            } catch {
              resolve(null);
              return;
            }
            const sub = 'k0-' + Math.random().toString(36).slice(2);
            const timeout = setTimeout(() => done(null), 3000);

            function done(value) {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              resolve(value);
            }

            ws.onopen = () => {
              ws.send(JSON.stringify(['REQ', sub, { kinds: [0], authors: [pubkey], limit: 1 }]));
            };
            ws.onmessage = (ev) => {
              try {
                const msg = JSON.parse(ev.data);
                if (!Array.isArray(msg)) return;
                if (msg[0] === 'EVENT' && msg[2] && typeof msg[2].content === 'string') {
                  const content = JSON.parse(msg[2].content || '{}');
                  done(content);
                } else if (msg[0] === 'EOSE') {
                  done(null);
                }
              } catch {}
            };
            ws.onerror = () => done(null);
          });
        },

        async logout() {
          await fetch('/ui/auth/logout', { method: 'POST', credentials: 'include' });
          window.location.href = '/ui';
        },

        goConnect() {
          window.location.href = '/ui/connect';
        },
      };
    }
  </script>
</body>
</html>`;
}
