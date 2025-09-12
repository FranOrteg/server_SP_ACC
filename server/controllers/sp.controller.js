// controllers/sp.controller.js

const sp = require('../services/sharepoint.service');

async function root(req, res, next) {
  try {
    const site = await sp.getRootSite();
    res.json({ id: site.id, webUrl: site.webUrl, displayName: site.displayName });
  } catch (e) { next(e); }
}

async function findSites(req, res, next) {
  try {
    const { q, hostname } = req.query;
    // si no te pasan hostname, usa el del root para filtrar por tu tenant
    const host = hostname || new URL((await sp.getRootSite()).webUrl).hostname;
    const results = await sp.findSites(q, host);
    res.json(results);
  } catch (e) { next(e); }
}

async function listDrivesByUrl(req, res, next) {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url requerida' });
    const { site, drives } = await sp.listDrivesByUrl(url);
    res.json({ site: { id: site.id, webUrl: site.webUrl, displayName: site.displayName }, drives });
  } catch (e) { next(e); }
}

async function resolveSite(req, res, next) {
  try {
    const { url, hostname, path } = req.query;
    // Soporta ambas formas: ?url=...  o  ?hostname=...&path=...
    const site = await sp.resolveSiteIdFlexible({ url, hostname, path });
    res.json({ id: site.id, webUrl: site.webUrl, displayName: site.displayName });
  } catch (e) { next(e); }
}

async function listDrives(req, res, next) {
  try {
    const { siteId } = req.query;
    if (!siteId) return res.status(400).json({ error: 'siteId requerido' });
    const drives = await sp.listSiteDrives(siteId);
    res.json(drives);
  } catch (e) { next(e); }
}

async function listDrivesByPath(req, res, next) {
  try {
    const { url, hostname, path } = req.query;

    if (url) {
      const site = await sp.resolveSiteIdFlexible({ url });
      const drives = await sp.listSiteDrives(site.id);
      return res.json(drives);
    }

    if (!hostname || !path) return res.status(400).json({ error: 'hostname y path son obligatorios (o usa url=...)' });
    const drives = await sp.listDrivesBySitePath(hostname, path);
    res.json(drives);
  } catch (e) { next(e); }
}

async function listFolder(req, res, next) {
  try {
    const { driveId, path = '' } = req.query;
    if (!driveId) return res.status(400).json({ error: 'driveId requerido' });
    const items = await sp.listFolderByPath(driveId, path);
    res.json(items);
  } catch (e) { next(e); }
}

async function itemByPath(req, res, next) {
  try {
    const { driveId, path = '' } = req.query;
    if (!driveId) return res.status(400).json({ error: 'driveId requerido' });
    const item = await sp.getItemByPath(driveId, path);
    res.json(item);
  } catch (e) { next(e); }
}


module.exports = { 
    resolveSite, 
    listDrives, 
    listDrivesByPath, 
    listFolder, 
    root,
    findSites,
    listDrivesByUrl,
    itemByPath
};
