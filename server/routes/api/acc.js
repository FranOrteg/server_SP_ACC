// routes/api/acc.js

const router = require('express').Router();
const ctrl = require('../../controllers/acc.controller');

// OAuth
router.get('/auth/login', ctrl.login);
router.get('/auth/callback', ctrl.callback);
router.get('/auth/url', ctrl.loginUrl);

// Data Management
router.get('/hubs', ctrl.hubs);
router.get('/projects', ctrl.projects);
router.get('/top-folders', ctrl.topFolders);
router.get('/list', ctrl.listFolder);

module.exports = router;
