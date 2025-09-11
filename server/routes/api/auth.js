const router = require('express').Router();

router.get('/', (req, res) => {
  res.send( 'Auth route is working!');
});

module.exports = router;