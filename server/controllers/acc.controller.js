// controllers/acc.controller.js
const aps = require('../clients/apsClient');
const accSvc = require('../services/acc.service');

function parseScopesParam(q) {
  if (!q) return ['data:read'];
  if (Array.isArray(q)) q = q.join(' ');
  return q.split(/[,\s]+/).filter(Boolean);
}

async function login(req, res) {
  try {
    const scopes = parseScopesParam(req.query.scopes);
    const prompt = (req.query.prompt || 'login').toLowerCase();
    if (!['login', 'none', 'create'].includes(prompt)) {
      return res.status(400).json({ error: "invalid_request", error_description: "'prompt' must be 'login', 'none', or 'create'." });
    }
    const url = aps.buildAuthUrl(scopes, prompt);
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ error: 'server_error', message: e.message });
  }
}

async function callback(req, res) {
  const { code, error, error_description } = req.query;
  try {
    if (error) return res.status(400).json({ error, error_description });
    await aps.exchangeCodeForToken(code);
    res.send('✅ Autodesk login OK. Puedes cerrar esta pestaña.');
  } catch (e) {
    res.status(500).json({ error: 'server_error', message: e.message });
  }
}

async function logout(req, res) {
  aps.clearToken();
  res.json({ ok: true });
}

// Pasarelas simples
async function hubs(req, res, next) {
  try { res.json(await accSvc.listHubs()); } catch (e) { next(e); }
}
async function projects(req, res, next) {
  try {
    const { hubId, all, limit } = req.query;
    res.json(await accSvc.listProjects(hubId, { all: all === 'true', limit: limit ? Number(limit) : 50 }));
  } catch (e) { next(e); }
}
async function topFolders(req, res, next) {
  try {
    const { hubId, projectId } = req.query;
    res.json(await accSvc.listTopFolders(hubId, projectId));
  } catch (e) { next(e); }
}
async function list(req, res, next) {
  try {
    const { projectId, folderId, all, limit } = req.query;
    res.json(await accSvc.listFolderContents(projectId, folderId, { all: all === 'true', limit: limit ? Number(limit) : 200 }));
  } catch (e) { next(e); }
}

module.exports = { login, callback, logout, hubs, projects, topFolders, list };
