const router = require('express').Router();
const ctrl = require('../../controllers/acc.controller');

// Middleware temporal: MOCK de credenciales 3-legged en req.user.credentials
router.use((req,res,next)=>{ req.user = req.user || {}; req.user.credentials = req.app.get('apsCredentials') || null; next(); });

router.get('/hubs', ctrl.listHubs);
router.get('/projects', ctrl.listProjects);
router.get('/list', ctrl.listFolder);

module.exports = router;
