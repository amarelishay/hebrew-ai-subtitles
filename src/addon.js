'use strict';

// Stremio addon definition + the subtitle resolver: parses the incoming
// request, computes a stable cache key, checks cache/job state, and either
// serves a ready VTT, a placeholder, or kicks off a background translation.

const { addonBuilder } = require('stremio-addon-sdk');
const logger = require('./utils/logger');
const cacheManager = require('./services/cacheManager');
const jobManager = require('./services/jobManager');
const openSubtitlesProvider = require('./providers/openSubtitlesProvider');
const { parseSrt } = require('./utils/srtParser');
const { buildSubtitleKey } = require('./utils/hash');

const manifest = {
  id: 'community.hebrew-ai-subtitles',
  version: '0.1.0',
  name: 'Hebrew AI Subtitles',
  description: 'Personal addon that translates subtitles to Hebrew on demand using OpenAI.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
};

const builder = new addonBuilder(manifest);

// Stremio video ids look like "tt1234567" (movie) or "tt1234567:1:2"
// (series: imdbId:season:episode).
function parseStremioId(id) {
  const [imdbId, season, episode] = String(id).split(':');
  return {
    imdbId,
    season: season !== undefined ? parseInt(season, 10) : null,
    episode: episode !== undefined ? parseInt(episode, 10) : null,
  };
}

builder.defineSubtitlesHandler(async (args) => {
  const { type, id } = args;
  logger.info(`Subtitle request received: type=${type} id=${id}`);

  try {
    const { imdbId, season, episode } = parseStremioId(id);
    if (!imdbId || !imdbId.startsWith('tt')) {
      logger.warn(`Ignoring request with no usable imdbId: id=${id}`);
      return { subtitles: [] };
    }

    const subtitles = await resolveSubtitles({ type, imdbId, season, episode });
    return { subtitles };
  } catch (err) {
    logger.error(`Failed to resolve subtitles for id=${id}: ${err.message}`);
    return { subtitles: [] };
  }
});

async function resolveSubtitles({ type, imdbId, season, episode }) {
  const provider = 'opensubtitles';

  let sourceSubtitle;
  try {
    sourceSubtitle = await openSubtitlesProvider.findEnglishSubtitle({ imdbId, season, episode, type });
  } catch (err) {
    logger.error(`OpenSubtitles search failed for ${imdbId}: ${err.message}`);
    return [];
  }

  if (!sourceSubtitle) {
    logger.warn(`No English subtitle source found for imdb=${imdbId} season=${season} episode=${episode}`);
    return [];
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
    // jobs.json says "processing" but nothing is running in this process -
    // most likely the server restarted mid-job. Fall through and restart
    // rather than showing "processing" forever.
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
