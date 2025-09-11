// routes/api.js
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

module.exports = router;
