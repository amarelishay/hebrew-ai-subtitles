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
}

const app = express();
const PORT = process.env.PORT || 7000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

cacheManager.ensureDirs();
warnIfMissingEnv();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Serves public/subtitles/*.vtt and public/placeholders/*.vtt directly.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mounts manifest.json + the subtitles resource route defined in addon.js.
app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  logger.info(`${manifest.name} v${manifest.version} listening on port ${PORT}`);
  logger.info(`Manifest: ${PUBLIC_BASE_URL}/manifest.json`);
});
