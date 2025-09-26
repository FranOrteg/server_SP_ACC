// controllers/admin.controller.js

const templates = require('../services/admin.template.service');
const accAdmin  = require('../services/admin.acc.service');
const spAdmin   = require('../services/admin.sp.service');
const twinSvc   = require('../services/admin.twin.service');

async function getTemplate(req, res, next) {
  try {
    const t = await templates.loadTemplate(req.params.templateId);
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json(t);
  } catch (e) { next(e); }
}

/**
 * Aplica plantilla SOLO en ACC (carpetas/permisos en Docs) sobre un proyecto EXISTENTE.
 * IMPORTANTE: necesitamos saber el accountId (o hubId) para construir el projectId de DM.
 */
async function applyAcc(req, res, next) {
  try {
    const { projectId, templateId, vars = {}, accountId, hubId } = req.body || {};
    if (!projectId || !templateId) {
      return res.status(400).json({ error: 'projectId y templateId son obligatorios' });
    }
    // Necesitamos accountId/hubId para construir el projectId de DM
    const accId = (accountId || hubId || '').toString().replace(/^b\./, '');
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar carpetas en Docs' });
    }

    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);

    // PASO CLAVE: pasamos accountId y projectId (Admin GUID) para que el service
    // construya el projectId de DM como b.{accountId}.{projectId}
    const r = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,              // Admin GUID
      template: tpl,
      resolvedName: name
    });

    res.json({ ok: true, projectId, accountId: accId, name, result: r });
  } catch (e) { next(e); }
}

async function applySp(req, res, next) {
  try {
    const { siteId, siteUrl, templateId, vars = {} } = req.body || {};
    if (!(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'siteId o siteUrl y templateId son obligatorios' });
    }
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);
    const r = await spAdmin.applyTemplateToSite({ siteId, siteUrl, template: tpl, resolvedName: name });
    res.json({ ok: true, siteId: r.siteId, name, result: r });
  } catch (e) { next(e); }
}

async function applyTwin(req, res, next) {
  try {
    const { projectId, accountId, hubId, siteId, siteUrl, templateId, vars = {}, twinId } = req.body || {};
    if (!projectId || !(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'projectId, siteId|siteUrl y templateId son obligatorios' });
    }
    const accId = (accountId || hubId || '').toString().replace(/^b\./, '');
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar en ACC (Docs)' });
    }

    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);

    // ACC: aplicar plantilla de carpetas sobre proyecto existente
    const accRes = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,          // Admin GUID
      template: tpl,
      resolvedName: name
    });

    // SP
    const spRes  = await spAdmin.applyTemplateToSite({ siteId, siteUrl, template: tpl, resolvedName: name });

    const link = await twinSvc.saveLink({
      twinId: twinId || `${projectId}__${spRes.siteId}`,
      projectId,
      siteId: spRes.siteId,
      templateId,
      vars
    });

    res.json({ ok: true, name, link, acc: accRes, sp: spRes });
  } catch (e) { next(e); }
}

async function twinStatus(req, res, next) {
  try {
    const s = await twinSvc.getStatus(req.params.id);
    if (!s) return res.status(404).json({ error: 'twin not found' });
    res.json(s);
  } catch (e) { next(e); }
}

async function listTwins(_req, res, next) {
  try {
    res.json(await twinSvc.listLinks());
  } catch (e) { next(e); }
}

// ------------------------------------------------------------------------------------------- //
// CREAR PROYECTO ACC (con o sin plantilla ACC) y opcionalmente aplicar tu plantilla de carpetas

/**
 * Body soportado:
 * {
 *   "hubId": "b.{accountGuid}"            // opcional si pasas accountId
 *   "accountId": "{accountGuid}"          // opcional si pasas hubId
 *   "templateId": "alias-o-uuid-admin",   // opcional -> clona en Admin
 *   "template": "labit-standard-v1"       // opcional -> tu plantilla de carpetas (clave o JSON)
 *   "vars": { "code":"001", "name":"Demo", "type":"Other", "classification":"production", ... },
 *   "name": "Nombre directo (opcional)",
 *   "code": "001",                        // opcional si viene en vars
 *   "startDate": "YYYY-MM-DD",            // opcional
 *   "endDate": "YYYY-MM-DD"               // opcional
 * }
 */
async function createAccProject(req, res, next) {
  try {
    const {
      hubId, accountId, templateId, template,
      vars = {}, code, name, startDate, endDate, classification, type
    } = req.body || {};

    // Debe venir hubId o accountId
    if (!(hubId || accountId)) {
      return res.status(400).json({ error: 'hubId o accountId es obligatorio' });
    }

    // Si se envía plantilla de carpetas como string, la cargamos
    let tplObj = template;
    if (tplObj && typeof tplObj === 'string') {
      tplObj = await templates.loadTemplate(tplObj);
      if (!tplObj) return res.status(404).json({ error: `template "${template}" not found` });
    }

    // Si NO hay nombre directo, se expande desde plantilla (si existe) o desde vars
    const nameFromTpl = tplObj ? templates.expandName(tplObj, vars) : null;
    const resolvedName = name || nameFromTpl || (vars.name ? `${vars.name}` : null);
    if (!resolvedName) {
      return res.status(400).json({ error: 'name (o vars.name) es obligatorio cuando no se pasa template de carpetas' });
    }

    // 1) Crear en Admin (si templateId ⇒ clona en ACC)
    const created = await accAdmin.createProject({
      hubId, accountId, templateId,
      vars, name: resolvedName, code,
      startDate, endDate, classification, type
    });
    // created => { accountId, projectId (Admin GUID), name, dm: { hubIdDM, projectIdDM }, raw }

    // 2) Aplicar TU plantilla de carpetas/permisos en Docs (opcional)
    let applied = null;
    if (tplObj) {
      applied = await accAdmin.applyTemplateToProject({
        accountId: created.accountId,
        projectId: created.projectId,           // Admin GUID
        projectIdDM: created.dm?.projectIdDM,   // DM ID directo
        template: tplObj,
        resolvedName
      });
    }

    res.json({
      ok: true,
      project: {
        id: created.projectId,         // Admin GUID
        name: created.name,
        accountId: created.accountId,
        dm: created.dm                 // { hubIdDM, projectIdDM }
      },
      applied // null si no se aplicó plantilla de carpetas
    });

    console.log('[createAccProject] body =>', req.body);
  } catch (e) {
    console.error('createAccProject ERROR:', e?.response?.data || e);
    res.status(400).json({ error: e?.message || 'Bad Request' });
  }
}

// --- Crear sitio SP desde cero y aplicar plantilla ---
async function createSpSite(req, res, next) {
  try {
    const { templateId, vars = {}, type = 'CommunicationSite', title, url, description } = req.body || {};
    if (!templateId || !url) return res.status(400).json({ error: 'templateId y url son obligatorios' });
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const resolvedName = title || templates.expandName(tpl, vars);
    const created = await spAdmin.createSite({ type, title: resolvedName, url, description });

    await spAdmin.applyTemplateToSite({ siteId: created.siteId, siteUrl: created.siteUrl, template: tpl, resolvedName });
    res.json({ ok: true, siteId: created.siteId, siteUrl: created.siteUrl, name: resolvedName });
  } catch (e) { next(e); }
}

// --- Crear TWIN (ACC + SP), aplicar y guardar vínculo ---
async function createTwin(req, res, next) {
  try {
    const { hubId, accountId, sp = {}, templateId, template, vars = {}, twinId, code, name } = req.body || {};
    if (!(hubId || accountId) || !templateId || !sp?.url) {
      return res.status(400).json({ error: 'hubId|accountId, templateId y sp.url son obligatorios' });
    }

    // Plantilla de carpetas (tu JSON) opcional
    let tplObj = template;
    if (tplObj && typeof tplObj === 'string') {
      tplObj = await templates.loadTemplate(tplObj);
      if (!tplObj) return res.status(404).json({ error: `template "${template}" not found` });
    }

    // Plantilla Admin para nombre (si no hay name directo)
    const tplAdmin = await templates.loadTemplate(templateId).catch(() => null);
    const resolvedName = name || (tplAdmin ? templates.expandName(tplAdmin, vars) : (tplObj ? templates.expandName(tplObj, vars) : vars.name)) || null;
    if (!resolvedName) return res.status(400).json({ error: 'name (o vars.name) es obligatorio' });

    // 1) ACC (crea y opcionalmente aplica carpetas)
    const accCreated = await accAdmin.createProject({
      hubId, accountId, templateId, vars, name: resolvedName, code
    });

    if (tplObj) {
      await accAdmin.applyTemplateToProject({
        accountId: accCreated.accountId,
        projectId: accCreated.projectId,           // Admin GUID
        projectIdDM: accCreated.dm?.projectIdDM,   // DM ID
        template: tplObj,
        resolvedName
      });
    }

    // 2) SP
    const spCreated = await spAdmin.createSite({
      type: sp.type || 'CommunicationSite',
      title: resolvedName,
      url: sp.url,
      description: sp.description
    });
    await spAdmin.applyTemplateToSite({ siteId: spCreated.siteId, siteUrl: spCreated.siteUrl, template: tplAdmin || tplObj, resolvedName });

    // 3) Guardar twin
    const link = await twinSvc.saveLink({
      twinId: twinId || `${accCreated.projectId}__${spCreated.siteId}`,
      projectId: accCreated.projectId,
      siteId: spCreated.siteId,
      templateId,
      vars
    });

    res.json({
      ok: true,
      name: resolvedName,
      link,
      acc: { projectId: accCreated.projectId, accountId: accCreated.accountId, dm: accCreated.dm },
      sp: spCreated
    });
  } catch (e) { next(e); }
}

module.exports = { 
  getTemplate, 
  applyAcc, 
  applySp, 
  applyTwin, 
  twinStatus, 
  listTwins,
  createAccProject,
  createSpSite,
  createTwin
};
