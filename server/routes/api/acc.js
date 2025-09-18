// routes/api/acc.js
const router = require('express').Router();
const ctrl = require('../../controllers/acc.controller');

// 2LO helpers
router.get('/auth/mode', ctrl.mode);
router.get('/auth/app-whoami', ctrl.appWhoAmI);
router.post('/auth/clear', ctrl.clear);

// ACC APIs
router.get('/hubs', ctrl.hubs);
router.get('/projects', ctrl.projects);
router.get('/top-folders', ctrl.topFolders);
router.get('/list', ctrl.list);
router.get('/tree', ctrl.projectTree);
router.get('/folder-by-path', ctrl.folderByPath);

module.exports = router;
