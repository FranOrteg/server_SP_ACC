const acc = require('../services/acc.service');

/**
 * Asumimos que guardas el token 3-legged del usuario en req.user.credentials
 * (Lo conectamos más tarde con tu /api/auth)
 */
async function listHubs(req, res, next) {
  try {
    const hubs = await acc.listHubs(req.user.credentials);
    res.json(hubs);
  } catch (e) { next(e); }
}

async function listProjects(req, res, next) {
  try {
    const { hubId } = req.query;
    const projects = await acc.listProjects(req.user.credentials, hubId);
    res.json(projects);
  } catch (e) { next(e); }
}

async function listFolder(req, res, next) {
  try {
    const { projectId, folderId } = req.query;
    const items = await acc.listFolderContents(req.user.credentials, projectId, folderId);
    res.json(items);
  } catch (e) { next(e); }
}

module.exports = { listHubs, listProjects, listFolder };
