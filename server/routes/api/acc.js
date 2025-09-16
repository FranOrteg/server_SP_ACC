// routes/api/acc.js
const router = require('express').Router();
const ctrl = require('../../controllers/acc.controller');

// OAuth 3LO
router.get('/auth/login', ctrl.login);
router.get('/auth/callback', ctrl.callback);
router.get('/auth/logout', ctrl.logout);
router.get('/auth/whoami', ctrl.whoami);

// Tests
router.get('/hubs', ctrl.hubs);
router.get('/projects', ctrl.projects);
router.get('/top-folders', ctrl.topFolders);
router.get('/list', ctrl.list);

module.exports = router;
