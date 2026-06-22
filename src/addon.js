'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const logger = require('./utils/logger');
const cacheManager = require('./services/cacheManager');
const jobManager = require('./services/jobManager');
const openSubtitlesProvider = require('./providers/openSubtitlesProvider');
const subdlProvider = require('./providers/subdlProvider');
const { parseSrt } = require('./utils/srtParser');
const { buildSubtitleKey } = require('./utils/hash');

const manifest = {
  id: 'community.hebrew-ai-subtitles',
  version: '0.1.13',
  name: 'Hebrew AI Subtitles',
  description: 'Personal addon that translates subtitles to Hebrew on demand using OpenAI.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);
const discoveryWarmups = new Set();
const activeResolutions = new Map();

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

function stableOptionId({ type, id, extra = {} }) {
  const raw = JSON.stringify({ type, id, filename: extra.filename, videoHash: extra.videoHash, videoSize: extra.videoSize });
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  return `he-ai-generate-${encoded}`.slice(0, 240);
}

function generatedSubtitleOption({ type, id, extra }) {
  const url = buildGenerateUrl({ type, id, extra });
  logger.info(`Generated subtitle option advertised: id=${id} url=${url}`);

  return {
    id: stableOptionId({ type, id, extra }),
    name: 'Hebrew AI Subtitles - Generate Hebrew',
    url,
    lang: 'heb',
  };
}

function hasConcretePlaybackMetadata(extra = {}) {
  return Boolean(extra.videoHash || extra.videoSize || extra.filename);
}

function discoveryWarmupEnabled() {
  return process.env.ENABLE_DISCOVERY_WARMUP === 'true';
}

function warmupKey({ type, id, extra = {} }) {
  return JSON.stringify({ type, id, filename: extra.filename, videoHash: extra.videoHash, videoSize: extra.videoSize });
}

function startDiscoveryWarmup({ type, id, extra = {} }) {
  if (!discoveryWarmupEnabled()) {
    logger.info('Discovery warm-up skipped: ENABLE_DISCOVERY_WARMUP is not true.');
    return;
  }

  if (!hasConcretePlaybackMetadata(extra)) return;

  const key = warmupKey({ type, id, extra });
  if (discoveryWarmups.has(key)) {
    logger.info(`Discovery warm-up already scheduled: id=${id}`);
    return;
  }

  discoveryWarmups.add(key);
  logger.info(`Discovery warm-up scheduled: type=${type} id=${id} extra=${JSON.stringify(extra)}`);

  setImmediate(async () => {
    try {
      const result = await getGeneratedSubtitleFile({ type, id, extra }, { source: 'discovery-warmup' });
      logger.info(`Discovery warm-up completed: id=${id} result=${result.kind}${result.placeholder ? `:${result.placeholder}` : ''}`);
    } catch (err) {
      logger.error(`Discovery warm-up failed for id=${id}: ${err.message}`);
    } finally {
      discoveryWarmups.delete(key);
    }
  });
}

builder.defineSubtitlesHandler(async (args) => {
  const { type, id, extra = {} } = args;
  logger.info(`Subtitle discovery request received: type=${type} id=${id} extra=${JSON.stringify(extra)}`);
  startDiscoveryWarmup({ type, id, extra });
  return { subtitles: [generatedSubtitleOption({ type, id, extra })] };
});

function fileResult(filePath) {
  return { kind: 'file', path: filePath };
}

function placeholderResult(kind) {
  return { kind: 'placeholder', placeholder: kind };
}

async function getGeneratedSubtitleFile({ type, id, extra = {} }, options = {}) {
  const source = options.source || 'vtt-request';
  logger.info(`Generated subtitle requested (${source}): type=${type} id=${id} extra=${JSON.stringify(extra)}`);

  const parsed = parseStremioRequest({ id, extra });

  if (!parsed.imdbId) {
    logger.warn(`No usable IMDb id found for Stremio id=${parsed.rawId}.`);
    return placeholderResult('unsupported-id');
  }

  return resolveGeneratedSubtitleWithLock({
    type,
    imdbId: parsed.imdbId,
    season: parsed.season,
    episode: parsed.episode,
    extra,
  });
}

function subtitleSourceAttempts() {
  return [
    {
      label: 'OpenSubtitles English',
      finder: (args) => openSubtitlesProvider.findSourceSubtitle({ ...args, language: 'en' }),
    },
    {
      label: 'OpenSubtitles Arabic',
      finder: (args) => openSubtitlesProvider.findSourceSubtitle({ ...args, language: 'ar' }),
    },
    {
      label: 'OpenSubtitles any language',
      finder: (args) => openSubtitlesProvider.findSourceSubtitle({ ...args, language: null }),
    },
    {
      label: 'SubDL English',
      finder: (args) => subdlProvider.findSubtitle({ ...args, language: 'EN' }),
    },
    {
      label: 'SubDL any language',
      finder: (args) => subdlProvider.findSubtitle({ ...args, language: null }),
    },
  ];
}

async function trySubtitleSource({ label, finder, args }) {
  try {
    logger.info(`Trying subtitle source: ${label}`);
    const result = await finder(args);

    if (!result) {
      logger.info(`Subtitle source returned no safe result: ${label}`);
      return null;
    }

    logger.info(
      `Selected subtitle source: provider=${result.provider || 'unknown'} lang=${result.language || 'unknown'} ` +
      `id=${result.fileId || result.subtitleId || 'unknown'} release=${result.releaseName || 'unknown'}`
    );

    return result;
  } catch (err) {
    logger.warn(`Subtitle source failed: ${label}: ${err.message}`);
    return null;
  }
}

async function downloadSourceSubtitle(sourceSubtitle) {
  if (!sourceSubtitle || !sourceSubtitle.provider) {
    throw new Error('Missing source subtitle provider');
  }

  if (sourceSubtitle.provider === 'opensubtitles') {
    return openSubtitlesProvider.downloadSubtitleContent(sourceSubtitle.fileId);
  }

  if (sourceSubtitle.provider === 'subdl') {
    return subdlProvider.downloadSubtitleContent(sourceSubtitle);
  }

  throw new Error(`Unsupported subtitle provider: ${sourceSubtitle.provider}`);
}

function sourceSubtitleCacheKey({ imdbId, season, episode, sourceSubtitle }) {
  const provider = sourceSubtitle.provider || 'unknown';
  const sourceId = `${sourceSubtitle.language || 'unknown'}:${sourceSubtitle.fileId || sourceSubtitle.subtitleId || sourceSubtitle.url || ''}`;

  return buildSubtitleKey({
    imdbId,
    season,
    episode,
    lang: 'he',
    provider,
    sourceId,
  });
}

async function prepareSourceSubtitle({ imdbId, season, episode, extra, sourceSubtitle }) {
  const provider = sourceSubtitle.provider || 'unknown';
  const subtitleKey = sourceSubtitleCacheKey({ imdbId, season, episode, sourceSubtitle });

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
    logger.info(`Retrying previously failed source ${subtitleKey}.`);
  }

  logger.info(
    `Cache miss for ${subtitleKey}, preparing source subtitle from ${provider} ` +
    `(sourceLanguage=${sourceSubtitle.language || 'unknown'})`
  );

  try {
    const rawSubtitle = await downloadSourceSubtitle(sourceSubtitle);
    const blocks = parseSrt(rawSubtitle);

    if (blocks.length === 0) {
      throw new Error('Parsed source subtitle has no usable blocks');
    }

    await jobManager.startJob(subtitleKey, {
      blocks,
      meta: {
        imdbId,
        season,
        episode,
        provider,
        sourceLanguage: sourceSubtitle.language || 'unknown',
        sourceId: sourceSubtitle.fileId || sourceSubtitle.subtitleId || sourceSubtitle.url,
        releaseName: sourceSubtitle.releaseName,
        extra,
      },
    });

    return placeholderResult('processing');
  } catch (err) {
    logger.warn(
      `Source preparation failed for provider=${provider} lang=${sourceSubtitle.language || 'unknown'} ` +
      `id=${sourceSubtitle.fileId || sourceSubtitle.subtitleId || 'unknown'}: ${err.message}`
    );
    await cacheManager.setJobStatus(subtitleKey, 'failed', { error: err.message });
    return null;
  }
}

function resolutionKey({ type, imdbId, season, episode, extra = {} }) {
  return JSON.stringify({
    type,
    imdbId,
    season,
    episode,
    filename: extra.filename,
    videoHash: extra.videoHash,
    videoSize: extra.videoSize,
  });
}

function resolveGeneratedSubtitleWithLock(args) {
  const key = resolutionKey(args);

  if (activeResolutions.has(key)) {
    logger.info(`Joining active subtitle resolution: ${key}`);
    return activeResolutions.get(key);
  }

  const promise = resolveGeneratedSubtitle(args)
    .finally(() => {
      activeResolutions.delete(key);
    });

  activeResolutions.set(key, promise);
  return promise;
}

async function resolveGeneratedSubtitle({ type, imdbId, season, episode, extra = {} }) {
  const args = { imdbId, season, episode, type, extra };
  let sawSource = false;

  for (const attempt of subtitleSourceAttempts()) {
    const sourceSubtitle = await trySubtitleSource({ ...attempt, args });
    if (!sourceSubtitle) continue;

    sawSource = true;
    const prepared = await prepareSourceSubtitle({ imdbId, season, episode, extra, sourceSubtitle });

    if (prepared) {
      return prepared;
    }

    logger.warn('Trying next subtitle source after preparation failure.');
  }

  if (sawSource) {
    logger.error(`Subtitle sources were found but none could be prepared for imdb=${imdbId} season=${season} episode=${episode}`);
    return placeholderResult('failed');
  }

  logger.warn(`No subtitle source found for imdb=${imdbId} season=${season} episode=${episode}`);
  return placeholderResult('no-source');
}

module.exports = {
  builder,
  manifest,
  decodeGeneratePayload,
  getGeneratedSubtitleFile,
};
