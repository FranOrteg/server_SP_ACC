const router = require('express').Router();
const ctrl = require('../../controllers/bridge.controller');

// idem mock credenciales 3-legged
router.use((req,res,next)=>{ req.user = req.user || {}; req.user.credentials = req.app.get('apsCredentials') || null; next(); });

router.post('/sp-to-acc', ctrl.spToAcc);

module.exports = router;
