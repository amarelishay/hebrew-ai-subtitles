'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');

const logger = require('./utils/logger');
const cacheManager = require('./services/cacheManager');
const { buildPlaceholderVtt } = require('./utils/vttBuilder');
const { builder, manifest, decodeGeneratePayload, getGeneratedSubtitleFile } = require('./addon');

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

function placeholderFile(kind) {
  return path.join(__dirname, '..', 'public', 'placeholders', `${kind}.vtt`);
}

function sendVttFile(res, filePath) {
  res.type('text/vtt');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return res.sendFile(filePath);
}

function sendVttContent(res, content) {
  res.type('text/vtt');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return res.send(content);
}

function buildStatusMessage(job) {
  const progress = (job && job.progress) || {};
  const meta = (job && job.meta) || {};
  const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
  const totalChunks = progress.totalChunks || '?';
  const translatedChunks = progress.translatedChunks || 0;
  const totalBlocks = progress.totalBlocks || '?';
  const translatedBlocks = progress.translatedBlocks || 0;
  const provider = meta.provider || 'unknown';
  const sourceLanguage = meta.sourceLanguage || 'unknown';
  const releaseName = meta.releaseName ? `\nמקור: ${meta.releaseName}` : '';

  return [
    '⏳ התרגום לעברית בעבודה',
    `התקדמות: ${percent}%`,
    `חלקים: ${translatedChunks}/${totalChunks}`,
    `שורות: ${translatedBlocks}/${totalBlocks}`,
    `ספק: ${provider} | שפת מקור: ${sourceLanguage}`,
    'אפשר לבחור שוב את הכתובית בעוד כמה שניות כדי לרענן סטטוס.',
    releaseName,
  ].filter(Boolean).join('\n');
}

async function dynamicPlaceholderVtt(kind, subtitleKey) {
  if (kind !== 'processing' || !subtitleKey) {
    return null;
  }

  const job = await cacheManager.getJob(subtitleKey);
  if (!job) {
    return buildPlaceholderVtt('⏳ התרגום לעברית מתחיל...\nאפשר לנסות שוב בעוד כמה שניות.', 30);
  }

  if (job.status === 'ready' && cacheManager.vttExists(subtitleKey)) {
    return null;
  }

  if (job.status === 'failed') {
    const error = job.error ? `\nשגיאה: ${job.error}` : '';
    return buildPlaceholderVtt(`⚠️ התרגום נכשל.${error}`, 30);
  }

  return buildPlaceholderVtt(buildStatusMessage(job), 30);
}

function shouldLogHttpRequest(req) {
  const url = req.originalUrl || req.url || '';
  return (
    url === '/' ||
    url === '/manifest.json' ||
    url === '/health' ||
    url.startsWith('/generate/') ||
    url.includes('/subtitles/')
  );
}

//
// Request diagnostics
//
app.use((req, res, next) => {
  if (shouldLogHttpRequest(req)) {
    const ua = req.get('user-agent') || 'unknown';
    logger.info(`HTTP ${req.method} ${req.originalUrl} ua=${ua}`);
  }

  next();
});

//
// CORS + no-cache hints
//
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

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
// The Stremio subtitles handler only advertises this URL.
// The actual work starts here, only when the VTT URL is requested.
//
app.get('/generate/:payload.vtt', async (req, res) => {
  try {
    const requestPayload = decodeGeneratePayload(req.params.payload);
    const result = await getGeneratedSubtitleFile(requestPayload);

    if (result.kind === 'file') {
      return sendVttFile(res, result.path);
    }

    if (result.kind === 'placeholder') {
      const dynamicVtt = await dynamicPlaceholderVtt(result.placeholder, result.subtitleKey);
      if (dynamicVtt) {
        return sendVttContent(res, dynamicVtt);
      }
      return sendVttFile(res, placeholderFile(result.placeholder));
    }

    logger.error(`Unknown generated subtitle result kind: ${JSON.stringify(result)}`);
    return sendVttFile(res, placeholderFile('failed'));
  } catch (err) {
    logger.error(`Failed to serve generated VTT: ${err.message}`);
    return sendVttFile(res, placeholderFile('failed'));
  }
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
  logger.info('HTTP request diagnostics enabled for manifest, subtitles, and generate routes.');
  logger.info(`Manifest: ${PUBLIC_BASE_URL}/manifest.json`);
  logger.info(`Health: ${PUBLIC_BASE_URL}/health`);
});
