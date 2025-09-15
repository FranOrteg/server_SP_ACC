// routes/api/bridge.js
const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');

// Copia un item (archivo) desde SharePoint a ACC
// GET /api/bridge/sp-to-acc?driveId=...&itemId=...&projectId=...&folderId=...&fileName=opcional
router.get('/sp-to-acc', ctrl.spToAcc);

module.exports = router;
