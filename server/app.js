const express = require('express');
const path = require('path');
const logger = require('morgan');
const cors = require('cors');
const { port } = require('./config/env');

const app = express();
app.use(logger('dev'));
app.use(cors({
  origin: 'http://localhost:5000',
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// Rutas
app.use('/api', require('./routes/api'));

// Error handler
app.use((err, req, res, next) => {
  console.error('❌', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
});

module.exports = app;
