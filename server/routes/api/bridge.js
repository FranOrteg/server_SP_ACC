// routes/api/bridge.js
const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');

// Copia un item (archivo) desde SharePoint a ACC
router.get('/sp-to-acc', ctrl.spToAcc);

// Copia recursiva SP → ACC
router.post('/sp-tree-to-acc', ctrl.spTreeToAcc);
// (opcional) GET para probar desde navegador
router.get('/sp-tree-to-acc', ctrl.spTreeToAcc);

module.exports = router;
