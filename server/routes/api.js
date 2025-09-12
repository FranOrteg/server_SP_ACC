const router = require('express').Router();

// Auth (Access Token)
router.use('/health', require('./api/health'));

/// Sharepoint
router.use('/sp', require('./api/sp')); 

// Autodesk ACC
router.use('/acc', require('./api/acc'));

// Bridge
router.use('/bridge', require('./api/bridge'));

module.exports = router;