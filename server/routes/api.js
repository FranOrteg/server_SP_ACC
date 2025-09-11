const router = require('express').Router();

// Auth (Access Token)
router.use('/health', require('./api/health'));

module.exports = router;