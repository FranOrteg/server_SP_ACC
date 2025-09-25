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

async function applyAcc(req, res, next) {
  try {
    const { projectId, templateId, vars = {} } = req.body || {};
    if (!projectId || !templateId) return res.status(400).json({ error: 'projectId y templateId son obligatorios' });
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);
    const r = await accAdmin.applyTemplateToProject({ projectId, template: tpl, resolvedName: name });
    res.json({ ok: true, projectId, name, result: r });
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
    const { projectId, siteId, siteUrl, templateId, vars = {}, twinId } = req.body || {};
    if (!projectId || !(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'projectId, siteId|siteUrl y templateId son obligatorios' });
    }
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);
    const accRes = await accAdmin.applyTemplateToProject({ projectId, template: tpl, resolvedName: name });
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

// --- NUEVO: crear proyecto ACC desde cero y aplicar plantilla ---
async function createAccProject(req, res, next) {
  try {
    const { hubId, templateId, vars = {}, code, name } = req.body || {};
    if (!hubId || !templateId) return res.status(400).json({ error: 'hubId y templateId son obligatorios' });
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const resolvedName = name || templates.expandName(tpl, vars);
    const created = await accAdmin.createProject({ hubId, name: resolvedName, code: code || vars.code });

    await accAdmin.applyTemplateToProject({ projectId: created.projectId, template: tpl, resolvedName });
    res.json({ ok: true, hubId, projectId: created.projectId, name: resolvedName });
  } catch (e) { next(e); }
}

// --- NUEVO: crear sitio SP desde cero y aplicar plantilla ---
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

// --- NUEVO: crear TWIN (ACC + SP), aplicar y guardar vínculo ---
async function createTwin(req, res, next) {
  try {
    const { hubId, sp = {}, templateId, vars = {}, twinId, code, name } = req.body || {};
    if (!hubId || !templateId || !sp?.url) return res.status(400).json({ error: 'hubId, templateId y sp.url son obligatorios' });

    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const resolvedName = name || templates.expandName(tpl, vars);

    // 1) ACC
    const accCreated = await accAdmin.createProject({ hubId, name: resolvedName, code: code || vars.code });
    await accAdmin.applyTemplateToProject({ projectId: accCreated.projectId, template: tpl, resolvedName });

    // 2) SP
    const spCreated = await spAdmin.createSite({ type: sp.type || 'CommunicationSite', title: resolvedName, url: sp.url, description: sp.description });
    await spAdmin.applyTemplateToSite({ siteId: spCreated.siteId, siteUrl: spCreated.siteUrl, template: tpl, resolvedName });

    // 3) Guardar twin
    const link = await twinSvc.saveLink({
      twinId: twinId || `${accCreated.projectId}__${spCreated.siteId}`,
      projectId: accCreated.projectId,
      siteId: spCreated.siteId,
      templateId,
      vars
    });

    res.json({ ok: true, name: resolvedName, link, acc: { projectId: accCreated.projectId }, sp: spCreated });
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
  createTwin,
  getTemplate: require('./admin.controller').getTemplate,
  applyAcc:    require('./admin.controller').applyAcc,
  applySp:     require('./admin.controller').applySp,
  applyTwin:   require('./admin.controller').applyTwin,
  twinStatus:  require('./admin.controller').twinStatus,
  listTwins:   require('./admin.controller').listTwins,
};
