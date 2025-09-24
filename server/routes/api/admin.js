// routes/api/admin.js

const router = require('express').Router();
const ctrl = require('../../controllers/admin.controller');

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

module.exports = router;
