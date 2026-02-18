const express = require('express');
const path = require('path');
const logger = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { port } = require('./config/env');

const app = express();

app.use(logger('dev'));

// Configurar CORS
app.use(cors({
  origin: [
    'http://localhost:5000',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://skylab.labit.es',
    'https://cloudadmin.labit.es'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
    'Expires'
  ]
}));

app.use(cookieParser());
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
