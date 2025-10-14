// services/sharepoint.service.js
const { graphGet, graphGetStream, graphPost } = require('../clients/graphClient');
const { pipeline } = require('node:stream/promises');
const fs = require('fs');
const path = require('path');
const { spoAdminGet } = require('../clients/spoClient');

// util local
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Descarga un driveItem a /tmp usando Graph -> sigue redirect a SharePoint.
 * Reintenta en transitorios: 429/500/502/503/504 o errores de red.
 *
 * @param {string} driveId
 * @param {string} itemId
 * @param {{maxAttempts?:number, baseBackoffMs?:number}} opts
 * @returns {Promise<string>} ruta absoluta del fichero temporal
 */

/* ----------------------------- helpers sitio ----------------------------- */

// --- caché simple de nombres de sitio ---
const _siteNameCache = new Map();

async function getSiteDisplayNameById(siteId) {
  if (!siteId) return null;
  if (_siteNameCache.has(siteId)) return _siteNameCache.get(siteId);
  const { data: site } = await graphGet(`/sites/${siteId}?$select=displayName`);
  const name = site?.displayName || null;
  if (name) _siteNameCache.set(siteId, name);
  return name;
}

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

// === helpers (puedes pegarlos junto a otros helpers) ===
function tryGet(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

function mapToSiteRow(x) {
  const webUrl = tryGet(x, 'Url', 'WebFullUrl', 'Path', 'UrlDecoded', 'UrlPath');
  const displayName = tryGet(x, 'Title', 'DisplayName', 'Name') || '';
  const id = tryGet(x, 'SiteId', 'Id', 'siteId');
  if (!webUrl) return null;
  return { id, webUrl, displayName };
}

function parseSearchRows(resp) {
  // Normaliza raíz: resp.d?.query o resp.PrimaryQueryResult
  const root =
    resp?.d?.query ||
      resp?.query || // por si acaso
      resp?.PrimaryQueryResult
      ? resp
      : null;

  const pqr = root?.PrimaryQueryResult || resp?.PrimaryQueryResult;
  const table = pqr?.RelevantResults?.Table;
  const rows = table?.Rows?.results || table?.Rows || table?.rows || [];
  const out = [];

  for (const row of rows) {
    // Cells puede venir como { Cells: { results: [...] } } o { Cells: [...] }
    const cellsRaw = row?.Cells?.results || row?.Cells || row?.cells || [];
    const obj = {};
    for (const c of cellsRaw) {
      const k = c?.Key ?? c?.key;
      const v = c?.Value ?? c?.value;
      if (k) obj[k] = v;
    }

    // normaliza campos
    const webUrl =
      obj.Path ||
      obj.SPSiteUrl ||
      obj.SPWebUrl ||
      obj.Url ||
      obj.WebFullUrl ||
      obj.UrlPath ||
      null;

    const displayName =
      obj.Title ||
      obj.SiteTitle ||
      obj.Name ||
      '';

    const id = obj.SiteId || obj.SPSiteId || obj.siteid || null;

    if (webUrl) out.push({ id, webUrl, displayName });
  }

  return out;
}
/* -------------------------- listAllSites (SPO) -------------------------- */

async function listAllSites({ preferHostname, limit = 500 } = {}) {
  // 1) Intento: SPO.Tenant/sites con paginación simple por startIndex
  const out = [];
  let usedTenantApi = false;
  try {
    let startIndex = 0;
    while (out.length < limit) {
      const path = `/_api/SPO.Tenant/sites?includePersonalSite=false&startIndex=${startIndex}`;
      const { data } = await spoAdminGet(path, { Accept: 'application/json;odata=nometadata' });
      usedTenantApi = true;
      const rows = data?.value || data?.d?.Sites?.results || data?.d?.results || [];
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const r of rows) {
        const row = mapToSiteRow(r);
        if (!row) continue;
        if (preferHostname) {
          try {
            if (!new URL(row.webUrl).hostname.includes(preferHostname)) continue;
          } catch { continue; }
        }
        out.push(row);
        if (out.length >= limit) break;
      }
      startIndex += rows.length;
    }
  } catch (e) {
    // Cualquier error → caemos a Search API
    // (en tus logs es 500, así que entra aquí)
  }

  if (out.length > 0) {
    // Completar id/webUrl/displayName vía Graph si quieres (opcional)
    const maxConc = 5;
    let i = 0;
    async function worker() {
      while (i < out.length) {
        const my = i++;
        const u = out[my];
        try {
          const s = await resolveSiteIdFlexible({ url: u.webUrl });
          out[my] = {
            id: s?.id || u.id || null,
            webUrl: s?.webUrl || u.webUrl,
            displayName: s?.displayName || u.displayName || null
          };
        } catch {
          // deja el row tal cual si no se puede resolver
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConc, out.length) }, () => worker()));
    return out.slice(0, limit);
  }

  // 2) Fallback: Search API (contentclass:STS_Site)
  // GET /_api/search/query
  const rowlimit = Math.min(500, limit);
  const q = encodeURIComponent("contentclass:STS_Site");
  const select = encodeURIComponent("Title,Path,SiteId");

  try {
    const { data } = await spoAdminGet(
      `/_api/search/query?querytext='${q}'&trimduplicates=false&rowlimit=${rowlimit}&selectproperties='${select}'`,
      { Accept: 'application/json;odata=verbose' }
    );

    const list = parseSearchRows(data?.d?.query || data) || [];
    let filtered = list;
    if (preferHostname) {
      filtered = list.filter(s => {
        try { return new URL(s.webUrl).hostname.includes(preferHostname); }
        catch { return false; }
      });
    }

    if (filtered.length > 0) {
      // (opcional) enriquecer con resolveSiteIdFlexible en lotes como ya tienes
      return filtered.slice(0, limit);
    }
  } catch (e) {
    // 3) Último intento: POST /_api/search/postquery (algunos tenants responden mejor con POST)
    try {
      const body = {
        request: {
          Querytext: "contentclass:STS_Site",
          TrimDuplicates: false,
          RowLimit: rowlimit,
          SelectProperties: { results: ["Title", "Path", "SiteId", "SPSiteUrl", "SPWebUrl", "SiteTitle"] }
        }
      };
      const { spoAdminPost } = require('../clients/spoClient');
      const { data } = await spoAdminPost(
        '/_api/search/postquery',
        body,
        { Accept: 'application/json;odata=verbose' }
      );
      const list = parseSearchRows(data?.d?.postquery || data) || [];

      if (preferHostname) {
        list = list.filter(s => {
          try { return new URL(s.webUrl).hostname.includes(preferHostname); }
          catch { return false; }
        });
      }
      return list.slice(0, limit);
    } catch (e2) {
      const why = usedTenantApi ? 'SPO.Tenant/sites falló y Search también' : 'Search falló';
      const err = new Error(`No se pudo enumerar sitios (${why}).`);
      err.status = 502;
      throw err;
    }
  }
}

// --- Buscar usuarios del tenant (Microsoft Graph) ---
async function searchSpUsers({ q, limit = 25 }) {
  const needle = String(q || '').trim();
  if (needle.length < 2) return [];

  const top = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

  // 1) Intento con $search (requiere header ConsistencyLevel: eventual)
  try {
    const { data } = await graphGet(
      `/users?$search="${needle}"&$top=${top}`,
      { headers: { ConsistencyLevel: 'eventual' } }
    );
    const rows = Array.isArray(data?.value) ? data.value : [];
    return rows
      .map(u => ({
        name: u.displayName || '',
        email: u.mail || u.userPrincipalName || '',
        company: u.companyName || '',
        status: u.accountEnabled === false ? 'disabled' : 'active',
      }))
      .filter(u => u.email);
  } catch (_) {
    // si falla $search (permisos/tenant), probamos con $filter startswith
  }

  // 2) Fallback con $filter startswith(...)
  const esc = (s) => String(s).replace(/'/g, "''"); // escapar comillas
  const filter =
    `startswith(displayName,'${esc(needle)}')` +
    ` or startswith(mail,'${esc(needle)}')` +
    ` or startswith(userPrincipalName,'${esc(needle)}')`;

  const { data } = await graphGet(`/users?$filter=${encodeURIComponent(filter)}&$top=${top}`);
  const rows = Array.isArray(data?.value) ? data.value : [];
  return rows
    .map(u => ({
      name: u.displayName || '',
      email: u.mail || u.userPrincipalName || '',
      company: u.companyName || '',
      status: u.accountEnabled === false ? 'disabled' : 'active',
    }))
    .filter(u => u.email);
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
  for (; ;) {
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
  const { data } = await graphGet(`/drives/${driveId}/items/${itemId}`);
  return data; // { id, name, size, folder?, file?, root?, ... }
}

// identifica si es el root del drive
function isDriveRoot(item) {
  return Boolean(item?.root) || (String(item?.name).toLowerCase() === 'root');
}

// --- Helpers de nombre de sitio para carpetas en ACC ---
function normalizeNFC(s) { try { return String(s || '').normalize('NFC'); } catch { return s; } }
function safeFolderName(name) {
  const n = normalizeNFC(name || 'root')
    .replace(/[\\/:*?"<>|]/g, '-')   // caracteres ilegales en nombres de carpeta
    .replace(/\s+/g, ' ')
    .trim();
  return n || 'root';
}

function nameFromWebUrl(webUrl) {
  try {
    const u = new URL(webUrl);
    const segs = u.pathname.split('/').filter(Boolean);
    let i = segs.indexOf('sites');
    if (i < 0) i = segs.indexOf('teams');
    if (i >= 0 && segs[i + 1]) return decodeURIComponent(segs[i + 1]); // p.ej. LBKN01
    return decodeURIComponent(segs[segs.length - 1] || 'SharePoint');
  } catch {
    return 'SharePoint';
  }
}

function isGenericDocLibName(n) {
  const s = String(n || '').toLowerCase();
  return s === 'documents' || s === 'documentos' || s === 'shared documents';
}

// --- cachés simples para no repetir llamadas ---
const _siteNameByIdCache = new Map();   // key: siteId  -> displayName
const _siteNameByUrlCache = new Map();   // key: host+rootPath -> displayName

async function getSiteDisplayNameById(siteId) {
  if (!siteId) return null;
  if (_siteNameByIdCache.has(siteId)) return _siteNameByIdCache.get(siteId);
  const { data: site } = await graphGet(`/sites/${siteId}?$select=displayName`);
  const name = site?.displayName || null;
  if (name) _siteNameByIdCache.set(siteId, name);
  return name;
}

// Extrae "/sites/ALGO" o "/teams/ALGO" de cualquier pathname
function extractSiteRootPath(pathname) {
  const p = String(pathname || '/');
  const m = p.match(/\/(sites|teams)\/[^/]+/i);
  return m ? m[0] : '/';
}

// Dada cualquier URL (biblioteca, archivo, etc.), resuelve el sitio y devuelve su displayName
async function getSiteDisplayNameFromAnyUrl(url) {
  const u = parseSiteUrl(url);
  if (!u) return null;
  const root = extractSiteRootPath(u.path);          // → "/sites/KNOWLEDGE"
  const key = `${u.hostname}${root}`.toLowerCase(); // cache key
  if (_siteNameByUrlCache.has(key)) return _siteNameByUrlCache.get(key);

  // Igual que hace tu find-sites, pero yendo directo al root del sitio
  const { data: site } = await graphGet(`/sites/${u.hostname}:${encodeURI(root)}?$select=id,displayName,webUrl`);
  const name = site?.displayName || null;
  if (name) _siteNameByUrlCache.set(key, name);
  return name;
}


/**
 * Devuelve SIEMPRE el displayName del sitio (p.ej. "LBKN01") para crear
 * la carpeta raíz en ACC. Solo usa la URL/drive como último recurso.
 */
async function getSiteNameForItem(driveId, itemId) {
  try {
    const meta = await getItemMeta(driveId, itemId);
    const pr = meta?.parentReference || {};
    const siteIdFromItem = pr.siteId || null;
    const siteUrlFromItem = pr.siteUrl || meta?.webUrl || null;

    // 1) Si el item trae siteId → usar displayName del propio sitio
    let display = await getSiteDisplayNameById(siteIdFromItem);
    if (display) return safeFolderName(display);

    // 2) Mirar el drive (suele traer sharepointIds.siteId)
    const { data: drv } = await graphGet(
      `/drives/${encodeURIComponent(driveId)}?$select=name,webUrl,sharepointIds`
    );
    display = await getSiteDisplayNameById(drv?.sharepointIds?.siteId);
    if (display) return safeFolderName(display);

    // 3) Resolver el sitio a partir de cualquier URL relacionada y tomar su displayName
    const urlToResolve = siteUrlFromItem || drv?.webUrl;
    display = await getSiteDisplayNameFromAnyUrl(urlToResolve);
    if (display) return safeFolderName(display);

    // 4) Fallbacks (solo si todo lo anterior falló)
    const urlName = nameFromWebUrl(urlToResolve);
    if (urlName && !isGenericDocLibName(urlName)) return safeFolderName(urlName);
    return safeFolderName(drv?.name || 'SharePoint');
  } catch {
    return 'SharePoint';
  }
}


/**
 * Devuelve true si el item es el ROOT de la biblioteca (equivalente al /drive/root).
 * Útil para copiar su CONTENIDO directamente dentro de la carpeta del sitio en ACC.
 */
function isDocLibRoot(item) {
  if (!item || !item.folder) return false;
  if (item.root) return true; // algunos items incluyen { root: {} }
  const p = item?.parentReference?.path || '';
  // En Graph, el root de la biblioteca tiene path que termina en '/root:' (o '/root')
  return /\/root:?$/i.test(p);
}


/* --------------------------- descarga / upload SP -------------------------- */

async function downloadItemToTmp(driveId, itemId, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseBackoffMs = opts.baseBackoffMs ?? 1000;

  // un nombre de fichero temporal por ejecución
  const tmpPath = `/tmp/${itemId}-${Date.now()}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let writeStream;
    try {
      // Usamos SIEMPRE graphGetStream, que ya añade el bearer y sigue el 302 de Graph -> SharePoint
      const url = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;

      // graphGetStream puede devolver:
      //  - un objeto axios { data: ReadableStream }
      //  - directamente un ReadableStream
      const resp = await graphGetStream(url);
      const readable = resp?.data && typeof resp.data.pipe === 'function' ? resp.data : resp;

      writeStream = fs.createWriteStream(tmpPath);
      await pipeline(readable, writeStream);

      return tmpPath; // ✅ OK
    } catch (err) {
      // limpiar parcial si algo falló
      try { writeStream?.destroy(); } catch { }
      try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch { }

      const status = err?.response?.status;
      const isRetryable = !status || [429, 500, 502, 503, 504].includes(status);

      if (!isRetryable || attempt === maxAttempts) {
        console.error(`[SP][download] fallo definitivo ${driveId}/${itemId} ->`, status || err.code || err.message);
        throw err;
      }

      // respetar Retry-After si viene (segundos)
      const ra = err?.response?.headers?.['retry-after'];
      const retryAfterMs = ra ? Number(ra) * 1000 : null;

      // backoff exponencial + jitter, cap a 60s
      const backoff = retryAfterMs ?? Math.min(
        60_000,
        baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300)
      );

      console.warn(
        `[SP][download][retry] ${driveId}/${itemId} intento ${attempt}/${maxAttempts} -> ` +
        `${status || err.code || err.message}; esperando ${backoff}ms`
      );
      await sleep(backoff);
    }
  }
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
  listAllSites,

  // listados
  listSiteDrives,
  listFolderByPath,
  listChildrenByItem,
  isDriveRoot,
  getSiteNameForItem,
  isDocLibRoot,
  isGenericDocLibName,

  // IO
  downloadItemToTmp,
  createUploadSession,

  searchSpUsers,
};
