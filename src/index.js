'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');

const logger = require('./utils/logger');
const cacheManager = require('./services/cacheManager');
const { builder, manifest } = require('./addon');

function warnIfMissingEnv() {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY is not set.');
  }

  if (!process.env.OPENSUBTITLES_API_KEY) {
    logger.warn('OPENSUBTITLES_API_KEY is not set.');
  }
}

const app = express();
const PORT = process.env.PORT || 7000;

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');

cacheManager.ensureDirs();
warnIfMissingEnv();

//
// CORS
//
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

//
// Health Check
//
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: manifest.name,
    version: manifest.version,
    uptime: process.uptime()
  });
});

//
// Root
//
app.get('/', (req, res) => {
  res.send(
    `${manifest.name} v${manifest.version} is running. Use /manifest.json to install in Stremio.`
  );
});

//
// Explicit manifest route
//
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

//
// Static files
//
app.use(express.static(path.join(__dirname, '..', 'public')));

//
// Stremio routes
//
app.use(getRouter(builder.getInterface()));

//
// 404
//
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl
  });
});

//
// Error handler
//
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);

  res.status(500).json({
    error: 'Internal Server Error'
  });
});

app.listen(PORT, () => {
  logger.info(`${manifest.name} v${manifest.version} listening on port ${PORT}`);
  logger.info(`Manifest: ${PUBLIC_BASE_URL}/manifest.json`);
  logger.info(`Health: ${PUBLIC_BASE_URL}/health`);
});
