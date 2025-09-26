// routes/api/aps.oauth.js

const router = require('express').Router();
const qs = require('querystring');
const userAps = require('../../clients/apsUserClient');

router.get('/login', (req, res) => {
  const { APS_CLIENT_ID_3LO, APS_CALLBACK_URL } = process.env;
  const raw = (req.query.s || process.env.APS_SCOPES_3LO || 'data:read').trim();
  const scope = raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  const url = 'https://developer.api.autodesk.com/authentication/v2/authorize?' + qs.stringify({
    response_type: 'code',
    client_id: APS_CLIENT_ID_3LO,
    redirect_uri: APS_CALLBACK_URL,
    scope
  });
  console.log('[APS 3LO] authorize URL =>', url);
  res.redirect(url);
});

router.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`<pre>OAuth error: ${req.query.error}\n${req.query.error_description || ''}</pre>`);
    }
    await userAps.exchangeCodeForToken(req.query.code);
    try {
      const [, payload] = userAps.peekToken().access_token.split('.');
      const p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      console.log('[APS 3LO] token scopes =>', p.scope);
    } catch {}
    res.send('<h3>OK: sesión 3LO guardada. Ya puedes cerrar esta ventana.</h3>');
  } catch (e) { next(e); }
});

// NUEVO: logout por POST (ya existía) y también por GET (para navegador)
router.post('/logout', (_req, res) => {
  userAps.clearUserToken();
  res.json({ ok: true });
});
router.get('/logout', (_req, res) => {
  userAps.clearUserToken();
  res.json({ ok: true });
});

// NUEVO: introspección rápida del token
router.get('/me', (_req, res) => {
  const tok = userAps.peekToken();
  if (!tok?.access_token) return res.status(401).json({ error: 'no_user_token' });
  try {
    const [, payload] = tok.access_token.split('.');
    const p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    res.json({
      scopes: p.scope || [],
      userId: p.userid || p.sub || null,
      expiresAt: tok.expires_at
    });
  } catch {
    res.json({ raw: !!tok.access_token, expiresAt: tok.expires_at });
  }
});

module.exports = router;
