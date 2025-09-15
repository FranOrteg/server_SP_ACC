// controllers/acc.controller.js
const aps = require('../clients/apsClient');
const acc = require('../services/acc.service');

function login(req, res) {
  const raw = (req.query.scopes || '').trim();
  const scopes = raw ? raw.split(/[,\s]+/).filter(Boolean) : undefined;
  const url = aps.getAuthUrl(scopes, req.query.prompt); // admite prompt=consent|login|none
  res.redirect(url);
}

function loginUrl(req, res) {
  const raw = (req.query.scopes || '').trim();
  const scopes = raw ? raw.split(/[,\s]+/).filter(Boolean) : undefined;
  const url = aps.getAuthUrl(scopes, req.query.prompt);
  res.json({ authorizeUrl: url });
}

async function callback(req, res, next) {
  try {
    if (req.query.error) {
      console.error('APS OAuth ERROR:', req.query);
      return res.status(400).json(req.query);
    }
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'code ausente' });
    await aps.exchangeCodeForTokens(code);
    res.send('✅ Autodesk ACC conectado. Ya puedes probar /api/acc/hubs');
  } catch (e) { next(e); }
}

function tokenInfo(req, res) {
  const info = aps.getTokenInfo();
  if (!info) return res.status(401).json({ error: 'No token' });
  res.json(info);
}

async function hubs(req, res, next) {
  try { res.json(await acc.listHubs()); }
  catch (e) { next(e); }
}

async function projects(req, res, next) {
  try {
    const { hubId, all, limit } = req.query;
    if (!hubId) return res.status(400).json({ error: 'hubId requerido' });
    res.json(await acc.listProjects(hubId, { all: all === 'true', limit: Number(limit) || 200 }));
  } catch (e) { next(e); }
}

async function topFolders(req, res, next) {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId requerido' });
    res.json(await acc.listTopFolders(projectId));
  } catch (e) { next(e); }
}

async function listFolder(req, res, next) {
  try {
    const { projectId, folderId, all, limit } = req.query;
    if (!projectId || !folderId) return res.status(400).json({ error: 'projectId y folderId requeridos' });
    res.json(await acc.listFolderContents(projectId, folderId, { all: all === 'true', limit: Number(limit) || 200 }));
  } catch (e) { next(e); }
}

module.exports = { login, loginUrl, callback, tokenInfo, hubs, projects, topFolders, listFolder };
