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

module.exports = { getTemplate, applyAcc, applySp, applyTwin, twinStatus, listTwins };
