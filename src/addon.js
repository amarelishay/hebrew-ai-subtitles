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
  version: '0.1.1',
  name: 'Hebrew AI Subtitles',
  description: 'Personal addon that translates subtitles to Hebrew on demand using OpenAI.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

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

function placeholder(kind, id) {
  return [{ id, url: cacheManager.placeholderUrl(kind), lang: 'he' }];
}

builder.defineSubtitlesHandler(async (args) => {
  const { type, id, extra = {} } = args;
  logger.info(`Subtitle request received: type=${type} id=${id} extra=${JSON.stringify(extra)}`);

  try {
    const parsed = parseStremioRequest({ id, extra });

    if (!parsed.imdbId) {
      logger.warn(`No usable IMDb id found for Stremio id=${parsed.rawId}.`);
      return { subtitles: placeholder('unsupported-id', `unsupported-id-${encodeURIComponent(parsed.rawId || 'unknown')}`) };
    }

    const subtitles = await resolveSubtitles({
      type,
      imdbId: parsed.imdbId,
      season: parsed.season,
      episode: parsed.episode,
    });

    return { subtitles };
  } catch (err) {
    logger.error(`Failed to resolve subtitles for id=${id}: ${err.message}`);
    return { subtitles: placeholder('failed', `resolver-failed-${Date.now()}`) };
  }
});

async function resolveSubtitles({ type, imdbId, season, episode }) {
  const provider = 'opensubtitles';

  let sourceSubtitle;
  try {
    sourceSubtitle = await openSubtitlesProvider.findEnglishSubtitle({ imdbId, season, episode, type });
  } catch (err) {
    logger.error(`OpenSubtitles search failed for ${imdbId}: ${err.message}`);
    return placeholder('failed', `search-failed-${imdbId}-${season || 'movie'}-${episode || ''}`);
  }

  if (!sourceSubtitle) {
    logger.warn(`No English subtitle source found for imdb=${imdbId} season=${season} episode=${episode}`);
    return placeholder('no-source', `no-source-${imdbId}-${season || 'movie'}-${episode || ''}`);
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
    return [{ id: subtitleKey, url: cacheManager.buildPublicUrl(subtitleKey), lang: 'he' }];
  }

  if (jobManager.isProcessing(subtitleKey)) {
    logger.info(`Translation already in progress for ${subtitleKey}`);
    return [{ id: `${subtitleKey}-processing`, url: cacheManager.placeholderUrl('processing'), lang: 'he' }];
  }

  if (status === 'processing') {
    logger.warn(`Found stale processing status for ${subtitleKey}, restarting job.`);
  } else if (status === 'failed') {
    logger.info(`Previous translation failed for ${subtitleKey}, serving failure placeholder`);
    return [{ id: `${subtitleKey}-failed`, url: cacheManager.placeholderUrl('failed'), lang: 'he' }];
  }

  logger.info(`Cache miss for ${subtitleKey}, fetching source subtitle from OpenSubtitles`);
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

    return [{ id: `${subtitleKey}-processing`, url: cacheManager.placeholderUrl('processing'), lang: 'he' }];
  } catch (err) {
    logger.error(`Failed to fetch/parse source subtitle for ${subtitleKey}: ${err.message}`);
    await cacheManager.setJobStatus(subtitleKey, 'failed', { error: err.message });
    return [{ id: `${subtitleKey}-failed`, url: cacheManager.placeholderUrl('failed'), lang: 'he' }];
  }
}

module.exports = { builder, manifest };
