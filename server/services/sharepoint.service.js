// services/sharepoint.service.js
const { graphGet, graphGetStream, graphPost } = require('../clients/graphClient');
const { pipeline } = require('node:stream/promises');
const fs = require('fs');
const path = require('path');

/* ----------------------------- helpers sitio ----------------------------- */

async function getRootSite() {
  const { data } = await graphGet('/sites/root?$select=id,webUrl,displayName');
  return data;
}

async function findSites(q, preferHostname) {
  if (!q || q.length < 2) throw new Error('q debe tener al menos 2 caracteres');
  const { data } = await graphGet(`/sites?search=${encodeURIComponent(q)}&$select=id,webUrl,displayName`);
  let list = data.value || [];
  if (preferHostname) {
    list = list.filter(s => {
      try { return new URL(s.webUrl).hostname.includes(preferHostname); }
      catch { return false; }
    });
  }
  return list;
}

async function listDrivesByUrl(siteUrl) {
  const site = await resolveSiteIdFlexible({ url: siteUrl });
  const { data } = await graphGet(`/sites/${site.id}/drives`);
  return { site, drives: data.value || [] };
}

function ensureLeadingSlash(p) {
  if (!p) return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

function parseSiteUrl(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return { hostname: u.hostname, path: u.pathname || '/' };
  } catch {
    return null;
  }
}

async function resolveSiteIdByPath(hostname, serverRelativePath) {
  const spath = ensureLeadingSlash(serverRelativePath); // -> '/sites/Proyectos'
  const url = `/sites/${hostname}:` + encodeURI(spath); // conserva '/'
  const { data } = await graphGet(`${url}?$select=id,webUrl,displayName`);
  return data; // { id, webUrl, displayName }
}

async function searchSite(hostnameOrNull, serverRelativePathOrName) {
  const needle = (serverRelativePathOrName || '').split('/').filter(Boolean).pop();
  const { data } = await graphGet(`/sites?search=${encodeURIComponent(needle)}&$select=id,webUrl,displayName`);
  let candidates = data.value || [];
  if (hostnameOrNull) {
    candidates = candidates.filter(s => {
      try { return new URL(s.webUrl).hostname.includes(hostnameOrNull); }
      catch { return false; }
    });
  }
  if (!candidates.length) return null;

  const wanted = ensureLeadingSlash(serverRelativePathOrName || '');
  const match = candidates.find(s => {
    try { return new URL(s.webUrl).pathname.toLowerCase().endsWith(wanted.toLowerCase()); }
    catch { return false; }
  });
  return match || candidates[0];
}

async function resolveSiteIdFlexible({ url, hostname, path }) {
  let host = hostname, spath = path;

  if (url) {
    const u = parseSiteUrl(url);
    if (!u) throw new Error('URL de sitio inválida');
    host = u.hostname;
    spath = u.path;
  }
  if (!host || !spath) throw new Error('Faltan hostname y/o path (o bien pasa url=...)');

  try {
    return await resolveSiteIdByPath(host, spath);
  } catch (e) {
    const status = e?.response?.status;
    const msgRaw = e?.response?.data?.error?.message || e.message || '';
    const invalidHost = /invalid hostname/i.test(msgRaw);

    let found = await searchSite(host, spath);
    if (!found && (status === 400 || status === 404 || invalidHost)) {
      found = await searchSite(null, spath);
    }
    if (found) return found;

    const attempted = `/sites/${host}:${encodeURI(ensureLeadingSlash(spath))}?$select=id,webUrl,displayName`;
    const err = new Error(`Graph ${status || ''} - ${msgRaw || 'Error resolviendo siteId'} (intentado: ${attempted})`);
    err.status = status || 500;
    throw err;
  }
}

/* ------------------------------ listados SP ------------------------------ */

async function resolveSiteId(hostname, sitePath) {
  const site = await resolveSiteIdFlexible({ hostname, path: sitePath });
  return site.id;
}

async function listDrivesBySitePath(hostname, sitePath) {
  const site = await resolveSiteIdFlexible({ hostname, path: sitePath });
  const { data } = await graphGet(`/sites/${site.id}/drives`);
  return data.value || [];
}

async function listSiteDrives(siteId) {
  const { data } = await graphGet(`/sites/${siteId}/drives`);
  return data.value || [];
}

function normalizeFolderPath(p) {
  if (!p) return '';
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

async function listFolderByPath(driveId, folderPath = '') {
  const seg = normalizeFolderPath(folderPath);
  const suffix = seg ? `/root:/${encodeURI(seg)}:/children` : `/root/children`;
  const { data } = await graphGet(`/drives/${driveId}${suffix}`);
  return data.value || [];
}

async function listChildrenByItem(driveId, itemId) {
  const base = `/drives/${driveId}/items/${itemId}/children`;
  const select = '$select=id,name,folder,file,size,parentReference,lastModifiedDateTime,webUrl';
  let url = `${base}?${select}`;
  const all = [];
  for (;;) {
    const { data } = await graphGet(url);
    if (Array.isArray(data.value)) all.push(...data.value);
    const next = data['@odata.nextLink'];
    if (!next) break;
    url = next.replace('https://graph.microsoft.com/v1.0', '');
  }
  return all;
}

async function getItemByPath(driveId, folderPath = '') {
  const seg = normalizeFolderPath(folderPath);
  const suffix = seg ? `/root:/${encodeURI(seg)}` : `/root`;
  const { data } = await graphGet(`/drives/${driveId}${suffix}`);
  return data;
}

async function getItemMeta(driveId, itemId) {
  const { data } = await graphGet(`/drives/${driveId}/items/${itemId}?$select=id,name,size,webUrl,folder,file,parentReference,lastModifiedDateTime`);
  return data;
}

/* --------------------------- descarga / upload SP -------------------------- */

async function downloadItemToTmp(driveId, itemId) {
  const res = await graphGetStream(`/drives/${driveId}/items/${itemId}/content`);
  const tmpFile = path.join('/tmp', `${itemId}-${Date.now()}`);
  await pipeline(res.data, fs.createWriteStream(tmpFile));
  return tmpFile;
}

async function createUploadSession(driveId, parentItemIdOrRoot, fileName) {
  const url = parentItemIdOrRoot === 'root'
    ? `/drives/${driveId}/root:/${encodeURIComponent(fileName)}:/createUploadSession`
    : `/drives/${driveId}/items/${parentItemIdOrRoot}:/${encodeURIComponent(fileName)}:/createUploadSession`;
  const { data } = await graphPost(url, { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
  return data.uploadUrl;
}

module.exports = {
  // resolución flexible
  resolveSiteIdFlexible,
  resolveSiteId,
  listDrivesBySitePath,
  getItemByPath,
  getItemMeta,

  // descubrimiento
  getRootSite,
  findSites,
  listDrivesByUrl,

  // listados
  listSiteDrives,
  listFolderByPath,
  listChildrenByItem,

  // IO
  downloadItemToTmp,
  createUploadSession
};
