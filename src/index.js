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
    logger.warn('OPENAI_API_KEY is not set - translation jobs will fail until it is configured.');
  }

  if (!process.env.OPENSUBTITLES_API_KEY) {
    logger.warn('OPENSUBTITLES_API_KEY is not set - subtitle search will fail until it is configured.');
  }

  if (!process.env.PUBLIC_BASE_URL) {
    logger.warn('PUBLIC_BASE_URL is not set - generated subtitle URLs may be wrong in production.');
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

const addonInterface = builder.getInterface();

app.disable('x-powered-by');

app.get('/', (req, res) => {
  res
    .type('text/plain')
    .send(`${manifest.name} v${manifest.version} is running. Use /manifest.json to install in Stremio.`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: manifest.name,
    version: manifest.version,
    uptime: process.uptime(),
    publicBaseUrl: PUBLIC_BASE_URL
  });
});

/**
 * Explicit Stremio manifest route.
 * Do not rely only on getRouter for this, because if SDK routing changes
 * or is mounted incorrectly, Stremio will fail with "Not Found".
 */
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

/**
 * Serve generated subtitle files:
 * /subtitles/xxx.vtt
 * /placeholders/processing.vtt
 */
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Mount Stremio SDK routes.
 * This should expose:
 * /manifest.json
 * /subtitles/:type/:id/:extra?.json
 */
app.use(getRouter(addonInterface));

app.use((req, res) => {
  logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    hint: 'Try /health or /manifest.json'
  });
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled server error: ${err.stack || err.message}`);
  res.status(500).json({
    error: 'Internal Server Error'
  });
});

app.listen(PORT, () => {
  logger.info(`${manifest.name} v${manifest.version} listening on port ${PORT}`);
  logger.info(`Health: ${PUBLIC_BASE_URL}/health`);
  logger.info(`Manifest: ${PUBLIC_BASE_URL}/manifest.json`);
});
