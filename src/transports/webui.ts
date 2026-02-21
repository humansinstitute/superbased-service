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

  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
  <script>
    const qs = (id) => document.getElementById(id);
    const httpEl = qs('http');
    const relayEl = qs('relay');
    const ttlEl = qs('ttl');
    const scopesEl = qs('scopes');
    const tokenEl = qs('token');
    const statusEl = qs('status');
    const qrEl = qs('qr');

    const origin = window.location.origin;
    qs('origin').textContent = origin;
    httpEl.value = origin;

    function decodeBase64Json(v) {
      const json = decodeURIComponent(escape(atob(v.trim())));
      return JSON.parse(json);
    }

    async function renderQr(value) {
      const text = (value || '').trim();
      const ctx = qrEl.getContext('2d');
      ctx.clearRect(0, 0, qrEl.width, qrEl.height);
      if (!text || typeof QRCode === 'undefined') return;
      await QRCode.toCanvas(qrEl, text, {
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
        const data = await res.json();
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
