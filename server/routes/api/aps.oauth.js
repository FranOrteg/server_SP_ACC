// routes/api/aps.oauth.js

const router = require('express').Router();
const qs = require('querystring');
const crypto = require('crypto');
const userAps = require('../../clients/apsUserClient');

/** Comprueba env mínimos */
function ensureEnv(res) {
  const { APS_CLIENT_ID_3LO, APS_CALLBACK_URL } = process.env;
  if (!APS_CLIENT_ID_3LO || !APS_CALLBACK_URL) {
    res.status(500).json({ error: 'Faltan APS_CLIENT_ID_3LO o APS_CALLBACK_URL en .env' });
    return false;
  }
  return true;
}

// GET /api/oauth/login?s=data:read,data:write,account:read,account:write
router.get('/login', (req, res) => {
  if (!ensureEnv(res)) return;

  const { APS_CLIENT_ID_3LO, APS_CALLBACK_URL } = process.env;
  const raw = (req.query.s || process.env.APS_SCOPES_3LO || 'data:read').trim();
  const scope = raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');

  // CSRF state cookie
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('aps_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const url = 'https://developer.api.autodesk.com/authentication/v2/authorize?' + qs.stringify({
    response_type: 'code',
    client_id: APS_CLIENT_ID_3LO,
    redirect_uri: APS_CALLBACK_URL,
    scope,
    state
  });

  console.log('[APS 3LO] authorize URL =>', url);
  res.redirect(url);
});

// GET /api/oauth/callback
router.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`<pre>OAuth error: ${req.query.error}\n${req.query.error_description || ''}</pre>`);
    }

    // Valida state
    const sent = req.cookies?.aps_oauth_state;
    const got = (req.query.state || '').toString();
    if (!sent || !got || sent !== got) {
      return res.status(400).send('<pre>Invalid OAuth state</pre>');
    }

    await userAps.exchangeCodeForToken(req.query.code);

    // (Opcional) log scopes
    try {
      const [, payload] = userAps.peekToken().access_token.split('.');
      const p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      console.log('[APS 3LO] token scopes =>', p.scope);
    } catch { }

    // Popup UX: notifica y cierra
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;">
  <div>
    <h3>Autodesk conectado ✅</h3>
    <p>Esta ventana se cerrará automáticamente.</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'aps-auth', ok: true }, '*');
      }
    } catch (e) {}
    setTimeout(function(){ window.close(); }, 400);
  </script>
</body></html>`);
  } catch (e) { next(e); }
});

// POST/GET /api/oauth/logout
router.post('/logout', (_req, res) => { userAps.clearUserToken(); res.json({ ok: true }); });
router.get('/logout', (_req, res) => { userAps.clearUserToken(); res.json({ ok: true }); });

// GET /api/oauth/me
router.get('/me', (_req, res) => {
  const tok = userAps.peekToken();
  if (!tok?.access_token) return res.status(401).json({ error: 'no_user_token' });
  try {
    const [, payload] = tok.access_token.split('.');
    const p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    res.json({ scopes: p.scope || [], userId: p.userid || p.sub || null, expiresAt: tok.expires_at });
  } catch {
    res.json({ raw: !!tok.access_token, expiresAt: tok.expires_at });
  }
});

module.exports = router;
