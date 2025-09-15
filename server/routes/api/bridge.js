const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');

router.post('/sp-to-acc', ctrl.spToAcc);

module.exports = router;
