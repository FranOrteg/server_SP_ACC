const sp = require('../services/sharepoint.service');

async function listDrives(req, res, next) {
  try {
    const { siteId } = req.query; // ej: "contoso.sharepoint.com,1234-...,abcd-.../sites/SiteName"
    const drives = await sp.listSiteDrives(siteId);
    res.json(drives);
  } catch (e) { next(e); }
}

async function listFolder(req, res, next) {
  try {
    const { driveId, path = '' } = req.query;
    const items = await sp.listFolderByPath(driveId, path);
    res.json(items);
  } catch (e) { next(e); }
}

module.exports = { listDrives, listFolder };
