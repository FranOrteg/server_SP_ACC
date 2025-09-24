// routes/api/bridge.js
const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');
const { syncSegment } = require('../../controllers/sync.controller');

// Copia un item (archivo) desde SharePoint a ACC
router.get('/sp-to-acc', ctrl.spToAcc);

// Copia recursiva SP → ACC
router.post('/sp-tree-to-acc', ctrl.spTreeToAcc);

// (opcional) GET para probar desde navegador
router.get('/sp-tree-to-acc', ctrl.spTreeToAcc);

// Sincronización de un segmento (carpeta) SP ↔ ACC
router.post('/sync-sp-segment', syncSegment);


module.exports = router;
