// routes/api/sp.js
const router = require('express').Router();
const ctrl = require('../../controllers/sp.controller');

router.get('/root', ctrl.root);
router.get('/find-sites', ctrl.findSites);

// alias limpio para listar todo (opcional)
router.get('/sites', ctrl.listAllSites);

router.get('/drives-by-url', ctrl.listDrivesByUrl);
router.get('/siteId', ctrl.resolveSite);
router.get('/drives', ctrl.listDrives);
router.get('/drives-by-path', ctrl.listDrivesByPath);
router.get('/list', ctrl.listFolder);
router.get('/item-by-path', ctrl.itemByPath);

module.exports = router;
