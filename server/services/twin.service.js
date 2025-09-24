// services/twin.service.js

const { put, get, all } = require('./twin.store');
const tpl = require('./template.service');
const acc = require('./acc.service');
const sp = require('./sharepoint.service');
const { resolveAccFolderPath } = require('./acc.path');
const { listAccSubtreeFlat } = require('./acc.inventory');

async function applyTwin({ twinId, projectId, siteUrl, templateId, vars, applyTemplateAcc = true, applyTemplateSp = false }) {
  // Validaciones mínimas
  if (!twinId) throw new Error('twinId es obligatorio');
  if (!projectId) throw new Error('projectId es obligatorio');
  if (!siteUrl) throw new Error('siteUrl es obligatorio');

  // Resolver SP siteId (y verificar acceso)
  const site = await sp.resolveSiteIdFlexible({ url: siteUrl });
  const siteId = site?.id;
  if (!siteId) throw new Error('No pude resolver siteId desde siteUrl');

  // Verificar proyecto ACC accesible
  const pinfo = await acc.getProjectInfo(projectId); // ya tenemos /api/acc/project-info → internaliza en acc.service si hace falta
  if (!pinfo) throw new Error('No pude leer project info en ACC');

  // Aplicar plantilla (opcional)
  let usedTemplate = null;
  if (templateId) {
    usedTemplate = tpl.loadTemplate(templateId);
    if (!usedTemplate) throw new Error(`templateId ${templateId} no encontrado`);

    // Aplica en ACC (ya tienes endpoint /admin/apply/acc; aquí llamamos al servicio interno)
    if (applyTemplateAcc) {
      await require('./admin.apply').applyAccTemplate({
        projectId,
        template: usedTemplate,
        vars
      });
    }

    // SP está como opcional (requiere crear carpetas en doclib por Graph); lo activamos si lo quieres.
    if (applyTemplateSp) {
      await require('./admin.apply').applySpTemplate({
        siteId,
        template: usedTemplate,
        vars
      });
    }
  }

  const now = new Date().toISOString();
  const twin = {
    twinId,
    templateId: templateId || null,
    vars: vars || {},
    acc: { projectId },
    sp: { siteId, siteUrl },
    createdAt: now,
    updatedAt: now
  };
  put(twin);
  return twin;
}

async function twinStatus(twinId) {
  const twin = get(twinId);
  if (!twin) return { exists: false };

  // ACC quick checks
  let accOk = false, accDetails = {};
  try {
    const pinfo = await acc.getProjectInfo(twin.acc.projectId);
    accOk = !!pinfo;
    // opcionalmente mirar que existan carpetas de template
    accDetails = { projectId: twin.acc.projectId, name: pinfo?.data?.attributes?.name || null };
  } catch (e) {
    accDetails = { error: e?.response?.status || e.message };
  }

  // SP quick checks
  let spOk = false, spDetails = {};
  try {
    const site = await sp.resolveSiteIdFlexible({ url: twin.sp.siteUrl });
    spOk = !!site?.id;
    spDetails = { siteId: site?.id, webUrl: site?.webUrl, displayName: site?.displayName };
  } catch (e) {
    spDetails = { error: e?.response?.status || e.message };
  }

  // Color semáforo
  const status =
    accOk && spOk ? 'green'
    : (accOk || spOk) ? 'amber'
    : 'red';

  return {
    exists: true,
    twinId,
    status,
    acc: { ok: accOk, ...accDetails },
    sp: { ok: spOk, ...spDetails },
    templateId: twin.templateId || null,
    vars: twin.vars || {}
  };
}

function listTwins() {
  return all();
}

module.exports = { applyTwin, twinStatus, listTwins };
