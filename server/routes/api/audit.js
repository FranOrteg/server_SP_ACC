// routes/api/audit.js
const router = require('express').Router();
const ctrl = require('../../controllers/audit.controller');

router.get('/sp-to-acc', ctrl.audit);
router.get('/report/:reportId', ctrl.report);
router.get('/report/:reportId/csv', ctrl.reportCsv);
router.post('/sp-to-acc/repair', ctrl.repair);

module.exports = router;
