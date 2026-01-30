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

// --- STREAMING: Migración con progreso en tiempo real (SSE) ---
router.post('/sp-to-new-acc-project/stream', ctrl.spToNewAccProjectStream);
router.post('/sp-to-new-acc-project/cancel/:sessionId', ctrl.cancelMigrationSession);
router.get('/sp-to-new-acc-project/sessions', ctrl.listMigrationSessions);
router.get('/sp-to-new-acc-project/session/:sessionId', ctrl.getMigrationSession);


module.exports = router;
