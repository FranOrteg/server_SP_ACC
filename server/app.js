const express = require('express');
const path = require('path');
const logger = require('morgan');
const cors = require('cors');
const { port } = require('./config/env');

const app = express();
app.use(logger('dev'));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/sp', require('./routes/api/sp'));
app.use('/api/acc', require('./routes/api/acc'));
app.use('/api/bridge', require('./routes/api/bridge'));

// Error handler
app.use((err, req, res, next) => {
  console.error('❌', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
});

module.exports = app;
