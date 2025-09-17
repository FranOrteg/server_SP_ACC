// controllers/acc.controller.js
const aps = require('../clients/apsClient');
const accSvc = require('../services/acc.service');

// ===== Endpoints de soporte 2LO =====
async function mode(req, res) {
  res.json({ mode: '2LO' });
}

async function appWhoAmI(req, res) {
  try {
    const access = await aps.getAppAccessToken();
    const jwt = aps.decodeJwt(access) || {};
    const scp = jwt.scp || jwt.scope || [];
    res.json({
      tokenType: '2LO',
      tokenScopes: scp,
      exp: jwt.exp,
      aud: jwt.aud,
      iss: jwt.iss
    });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized', message: e.message });
  }
}

async function clear(req, res) {
  aps.clearToken();
  res.json({ ok: true, message: 'Token de aplicación limpio' });
}

// ===== Pasarelas ACC =====
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

module.exports = {
  mode,
  appWhoAmI,
  clear,
  hubs,
  projects,
  topFolders,
  list
};
