const router = require('express').Router();
const ctrl = require('../../controllers/sp.controller');

router.get('/drives', ctrl.listDrives);
router.get('/list', ctrl.listFolder);

module.exports = router;
