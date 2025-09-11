const router = require('express').Router();

// Auth (Access Token)
router.use('/auth', require('./api/auth'));

module.exports = router;