// routes/api/bridge.js

const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');
const { syncSegment } = require('../../controllers/sync.controller');

// --- Copia 1 fichero SP → ACC ---
router.get('/sp-to-acc', ctrl.spToAcc);
router.post('/sp-to-acc', ctrl.spToAcc); 

// --- Copia recursiva SP → ACC ---
router.post('/sp-tree-to-acc', ctrl.spTreeToAcc);
router.get('/sp-tree-to-acc', ctrl.spTreeToAcc); // opcional para test

// --- Sync segmento ---
router.post('/sync-sp-segment', syncSegment);

// --- Crear Proyecto durante la transferencia del Sitio SP ---
router.post('/sp-to-new-acc-project', ctrl.spToNewAccProject);


module.exports = router;
