// routes/api/admin.js

const router = require('express').Router();
const ctrl = require('../../controllers/admin.controller');
const aps = require('../../clients/apsUserClient');

// Plantillas
router.get('/templates/:templateId', ctrl.getTemplate);

// Aplicar plantilla a ACC (sobre proyecto existente)
router.post('/apply/acc', ctrl.applyAcc);

// Aplicar plantilla a SharePoint (sobre sitio existente)
router.post('/apply/sp', ctrl.applySp);

// Crear vínculo ACC <-> SP y aplicar plantilla a ambos (si quieres hacerlo de una)
router.post('/twin/apply', ctrl.applyTwin);

// Estado del “twin”
router.get('/twin/:id/status', ctrl.twinStatus);

// Listar vínculos guardados
router.get('/twin', ctrl.listTwins);

// Creación desde cero
router.post('/acc/projects/create', ctrl.createAccProject);
router.post('/sp/sites/create', ctrl.createSpSite);
router.post('/twin/create', ctrl.createTwin);

// Listar cuentas ACC (Construction Admin API)
router.get('/acc/accounts', async (req, res, next) => {
  try {
    const aps = require('../../clients/apsUserClient');
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

// Detalle de cuenta (opcional)
router.get('/acc/accounts/:accountId', async (req, res, next) => {
  try {
    const id = encodeURIComponent(req.params.accountId);
    const data = await aps.apiGet(`/construction/admin/v1/accounts/${id}`); // <-- ANTES: /project/v1/accounts/:id
    res.json(data);
  } catch (e) { next(e); }
});

// routes/api/admin.js
router.get('/acc/accounts/:accountId/projects', async (req, res, next) => {
  try {
    const accountId = encodeURIComponent(req.params.accountId);
    // ACC Admin API: lista de proyectos de una cuenta
    const r = await aps.apiGet(`/construction/admin/v1/accounts/${accountId}/projects`, {
      timeout: 8000
      // si quieres paginar: params: { limit: 50, offset: 0 }
    });
    res.json(r);
  } catch (e) { next(e); }
});


module.exports = router;
