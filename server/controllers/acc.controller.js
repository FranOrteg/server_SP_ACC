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

async function projectTree(req, res, next) {
  try {
    const { projectId, includeItems, maxDepth } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId es obligatorio' });

    const tree = await accSvc.listProjectTree(projectId, {
      includeItems: includeItems === 'true',
      maxDepth: maxDepth ? Number(maxDepth) : Infinity
    });
    res.json(tree);
  } catch (e) { next(e); }
}

async function folderByPath(req, res, next) {
  try {
    const { projectId, path, create } = req.query;
    if (!projectId || !path) return res.status(400).json({ error: 'projectId y path son obligatorios' });

    if (create === 'true') {
      const id = await accSvc.ensureFolderByPath(projectId, path);
      return res.json({ ok: true, folderId: id, created: true });
    } else {
      // Solo resolver sin crear
      const id = await accSvc.ensureFolderByPath(projectId, path); // reutilizo y si falta crea, pero podemos hacer read-only si quieres
      return res.json({ ok: true, folderId: id });
    }
  } catch (e) { next(e); }
}

// controllers/acc.controller.js
async function projectInfo(req, res, next) {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId es obligatorio' });
    const info = await accSvc.getTopFoldersByProjectId(projectId);
    res.json({ hubId: info.hubId, region: info.hubRegion, topFolders: info.topFolders?.map(f => f.attributes?.displayName) });
  } catch (e) { next(e); }
}


module.exports = {
  mode,
  appWhoAmI,
  clear,
  hubs,
  projects,
  topFolders,
  list,
  projectTree,
  folderByPath,
  projectInfo
};
