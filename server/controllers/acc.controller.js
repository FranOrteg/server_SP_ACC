// controllers/acc.controller.js
const aps = require('../clients/apsClient');
const acc = require('../services/acc.service');


function login(req, res) {
  const raw = (req.query.scopes || '').trim();
  const scopes = raw ? raw.split(/[,\s]+/).filter(Boolean) : undefined;
  const url = aps.getAuthUrl(scopes, req.query.prompt); // <-- pasa prompt
  res.redirect(url);
}

function loginUrl(req, res) {
  const raw = (req.query.scopes || '').trim();
  const scopes = raw ? raw.split(/[,\s]+/).filter(Boolean) : undefined;
  const url = aps.getAuthUrl(scopes, req.query.prompt); // <-- pasa prompt
  res.json({ authorizeUrl: url });
}

async function callback(req, res, next) {
  try {
    if (req.query.error) {       // <-- ver el error real de APS
      console.error('APS OAuth ERROR:', req.query);
      return res.status(400).json(req.query);
    }
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'code ausente' });
    await aps.exchangeCodeForTokens(code);
    res.send('✅ Autodesk ACC conectado. Ya puedes probar /api/acc/hubs');
  } catch (e) { next(e); }
}


async function hubs(req, res, next) {
  try {
    const data = await acc.listHubs();
    res.json(data);
  } catch (e) { next(e); }
}

async function projects(req, res, next) {
  try {
    const { hubId } = req.query;
    if (!hubId) return res.status(400).json({ error: 'hubId requerido' });
    const data = await acc.listProjects(hubId);
    res.json(data);
  } catch (e) { next(e); }
}

async function topFolders(req, res, next) {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId requerido' });
    const data = await acc.listTopFolders(projectId);
    res.json(data);
  } catch (e) { next(e); }
}

module.exports = { 
    login, 
    loginUrl,
    callback, 
    hubs, 
    projects, 
    topFolders 
    
};
