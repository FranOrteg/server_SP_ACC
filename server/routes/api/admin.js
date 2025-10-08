// routes/api/admin.js
const router = require('express').Router();
const ctrl = require('../../controllers/admin.controller');
const aps = require('../../clients/apsUserClient'); // Autodesk user client (3LO)
const { spoAdminGet } = require('../../clients/spoClient');

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------
router.get('/templates/:templateId', ctrl.getTemplate);

// -----------------------------------------------------------------------------
// ACC (Autodesk Construction Cloud)
// -----------------------------------------------------------------------------

// Listar cuentas (Construction Admin: a partir de hubs)
router.get('/acc/accounts', async (req, res, next) => {
  try {
    const hubs = await aps.apiGet('/project/v1/hubs', { timeout: 5000 });
    const list = (hubs?.data || []).map(h => ({
      hubId: h.id,                                  // p.ej. b.1bb8...
      accountId: (h.id || '').replace(/^b\./, ''),  // ACC GUID “puro”
      name: h.attributes?.name,
      region: h.attributes?.extension?.data?.region || null,
      type: h.attributes?.extension?.type
    }));
    res.json({ count: list.length, hubs: list });
  } catch (e) { next(e); }
});

// Detalle de cuenta
router.get('/acc/accounts/:accountId', async (req, res, next) => {
  try {
    const id = encodeURIComponent(req.params.accountId);
    // Nota: Admin API actual
    const data = await aps.apiGet(`/construction/admin/v1/accounts/${id}`);
    res.json(data);
  } catch (e) { next(e); }
});

// Usuarios del HUB
router.get('/acc/accounts/:accountId/users', ctrl.listAccAccountUsers);

// Proyectos de una cuenta
router.get('/acc/accounts/:accountId/projects', async (req, res, next) => {
  try {
    const accountId = encodeURIComponent(req.params.accountId);
    const r = await aps.apiGet(`/construction/admin/v1/accounts/${accountId}/projects`, {
      timeout: 8000
      // params: { limit: 50, offset: 0 } // si quieres paginar
    });
    res.json(r);
  } catch (e) { next(e); }
});

// Crear proyecto ACC desde plantilla/base
router.post('/acc/projects/create', ctrl.createAccProject);

// Aplicar plantilla a ACC (sobre proyecto existente)
router.post('/apply/acc', ctrl.applyAcc);   // ruta existente
router.post('/acc/apply', ctrl.applyAcc);   // alias canónico

// -----------------------------------------------------------------------------
// SharePoint (SP)
// -----------------------------------------------------------------------------

// Diags SP / Graph: usuarios ---
router.get('/sp/diag/user', ctrl.spDiagUser);      
router.get('/sp/diag/users', ctrl.spDiagUsers);

// Buscador de usuarios del tenant para autocompletar 
router.get('/sp/users', ctrl.spListUsers);       

// Crear sitio SP desde cero
router.post('/sp/sites/create', ctrl.createSpSite);

// Aplicar plantilla a SP (sobre sitio existente)
router.post('/apply/sp', ctrl.applySp);         
router.post('/sp/sites/apply', ctrl.applySp);    

// Gestión de miembros del sitio 
router.get('/sp/sites/members', ctrl.getCurrentSiteMembers);
router.post('/sp/sites/members', ctrl.setSiteMembers);       

router.get('/sp/diag/tenant', async (req, res, next) => {
  try {
    const r = await spoAdminGet('/_api/SPO.Tenant');
    res.json(r.data || { ok: true });
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || e?.message;
    res.status(status).json({ status, data });
  }
});


// -----------------------------------------------------------------------------
// Twin (ACC <-> SP)
// -----------------------------------------------------------------------------

// Crear vínculo (sincronización/config inicial)
router.post('/twin/create', ctrl.createTwin);

// Aplicar a ambos lados (si procede)
router.post('/twin/apply', ctrl.applyTwin);

// Estado del vínculo
router.get('/twin/:id/status', ctrl.twinStatus);

// Listar vínculos guardados
router.get('/twin', ctrl.listTwins);

module.exports = router;
