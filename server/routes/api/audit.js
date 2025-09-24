// routes/api/audit.js

const router = require('express').Router();
const ctrl = require('../../controllers/audit.controller');

router.get('/sp-to-acc', ctrl.audit);
router.get('/report/:reportId', ctrl.report);
router.get('/report/:reportId/csv', ctrl.reportCsv);
router.get('/reports', ctrl.listReports);
router.get('/report/:reportId/re-audit', ctrl.reAudit);


router.post('/sp-to-acc/repair', ctrl.repair);

module.exports = router;
