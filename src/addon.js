'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const logger = require('./utils/logger');
const cacheManager = require('./services/cacheManager');
const jobManager = require('./services/jobManager');
const openSubtitlesProvider = require('./providers/openSubtitlesProvider');
const { parseSrt } = require('./utils/srtParser');
const { buildSubtitleKey } = require('./utils/hash');

const manifest = {
  id: 'community.hebrew-ai-subtitles',
  version: '0.1.3',
  name: 'Hebrew AI Subtitles',
  description: 'Personal addon that translates subtitles to Hebrew on demand using OpenAI.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

function getBaseUrl() {
  const port = process.env.PORT || 7000;
  const base = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
  return base.replace(/\/+$/, '');
}

function encodeGeneratePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeGeneratePayload(encodedPayload) {
  const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  return JSON.parse(json);
}

function buildGenerateUrl({ type, id, extra = {} }) {
  const payload = encodeGeneratePayload({ type, id, extra });
  return `${getBaseUrl()}/generate/${payload}.vtt`;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractImdbId(value) {
  if (!value) return null;
  const match = String(value).match(/tt\d{5,}/i);
  return match ? match[0].toLowerCase() : null;
}

function parseStremioRequest({ id, extra = {} }) {
  const rawId = String(id || '');
  const parts = rawId.split(':');

  const imdbId =
    extractImdbId(parts[0]) ||
    extractImdbId(rawId) ||
    extractImdbId(extra.imdbId) ||
    extractImdbId(extra.imdb_id) ||
    extractImdbId(extra.imdb);

  const season = parseNumber(extra.season || extra.season_number || parts[1]);
  const episode = parseNumber(extra.episode || extra.episode_number || parts[2]);

  return { rawId, imdbId, season, episode };
}

function generatedSubtitleOption({ type, id, extra }) {
  const safeId = encodeURIComponent(String(id || 'unknown')).slice(0, 180);
  const url = buildGenerateUrl({ type, id, extra });

  logger.info(`Generated subtitle option advertised: id=${id} url=${url}`);

  return {
    id: `he-ai-generate-${safeId}`,
    name: 'Hebrew AI Subtitles - Generate Hebrew',
    url,
    // Stremio subtitle language codes are more reliable with ISO-639-2 style.
    // Using "heb" improves compatibility versus "he" on several clients.
    lang: 'heb',
  };
}

builder.defineSubtitlesHandler(async (args) => {
  const { type, id, extra = {} } = args;
  logger.info(`Subtitle discovery request received: type=${type} id=${id} extra=${JSON.stringify(extra)}`);
  return { subtitles: [generatedSubtitleOption({ type, id, extra })] };
});

function fileResult(filePath) {
  return { kind: 'file', path: filePath };
}

function placeholderResult(kind) {
  return { kind: 'placeholder', placeholder: kind };
}

async function getGeneratedSubtitleFile({ type, id, extra = {} }) {
  logger.info(`Generated VTT requested: type=${type} id=${id} extra=${JSON.stringify(extra)}`);

  const parsed = parseStremioRequest({ id, extra });

  if (!parsed.imdbId) {
    logger.warn(`No usable IMDb id found for Stremio id=${parsed.rawId}.`);
    return placeholderResult('unsupported-id');
  }

  return resolveGeneratedSubtitle({
    type,
    imdbId: parsed.imdbId,
    season: parsed.season,
    episode: parsed.episode,
  });
}

async function resolveGeneratedSubtitle({ type, imdbId, season, episode }) {
  const provider = 'opensubtitles';

  let sourceSubtitle;
  try {
    sourceSubtitle = await openSubtitlesProvider.findEnglishSubtitle({ imdbId, season, episode, type });
  } catch (err) {
    logger.error(`OpenSubtitles search failed for ${imdbId}: ${err.message}`);
    return placeholderResult('failed');
  }

  if (!sourceSubtitle) {
    logger.warn(`No English subtitle source found for imdb=${imdbId} season=${season} episode=${episode}`);
    return placeholderResult('no-source');
  }

  const subtitleKey = buildSubtitleKey({
    imdbId,
    season,
    episode,
    lang: 'he',
    provider,
    sourceId: sourceSubtitle.fileId,
  });

  const job = await cacheManager.getJob(subtitleKey);
  const status = job && job.status;

  if (status === 'ready' && cacheManager.vttExists(subtitleKey)) {
    logger.info(`Cache hit for ${subtitleKey}`);
    return fileResult(cacheManager.vttFilePath(subtitleKey));
  }

  if (jobManager.isProcessing(subtitleKey)) {
    logger.info(`Translation already in progress for ${subtitleKey}`);
    return placeholderResult('processing');
  }

  if (status === 'processing') {
    logger.warn(`Found stale processing status for ${subtitleKey}, restarting job.`);
  } else if (status === 'failed') {
    logger.info(`Previous translation failed for ${subtitleKey}, serving failure placeholder`);
    return placeholderResult('failed');
  }

  logger.info(`Cache miss for ${subtitleKey}, preparing source subtitle from OpenSubtitles`);
  try {
    const rawSubtitle = await openSubtitlesProvider.downloadSubtitleContent(sourceSubtitle.fileId);
    const blocks = parseSrt(rawSubtitle);

    if (blocks.length === 0) {
      throw new Error('Parsed source subtitle has no usable blocks');
    }

    await jobManager.startJob(subtitleKey, {
      blocks,
      meta: { imdbId, season, episode, provider, sourceId: sourceSubtitle.fileId },
    });

    return placeholderResult('processing');
  } catch (err) {
    logger.error(`Failed to prepare source subtitle for ${subtitleKey}: ${err.message}`);
    await cacheManager.setJobStatus(subtitleKey, 'failed', { error: err.message });
    return placeholderResult('failed');
  }
}

module.exports = {
  builder,
  manifest,
  decodeGeneratePayload,
  getGeneratedSubtitleFile,
};
