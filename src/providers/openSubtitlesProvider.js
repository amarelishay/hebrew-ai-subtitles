'use strict';

// Thin client for the OpenSubtitles REST API v1 (api.opensubtitles.com).
// Only searches for and downloads subtitle files that OpenSubtitles itself
// serves - no scraping, no torrents, no video of any kind.

const logger = require('../utils/logger');
const tmdbProvider = require('./tmdbProvider');

const BASE_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'HebrewAISubtitles v0.1.0';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // OpenSubtitles JWTs last ~24h
const DEFAULT_MAX_SEARCH_STRATEGIES = 4;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

let cachedToken = null;
let cachedTokenAt = 0;
let rateLimitedUntil = 0;

class OpenSubtitlesRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenSubtitlesRateLimitError';
    this.code = 'OPENSUBTITLES_RATE_LIMIT';
  }
}

function getApiKey() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) {
    throw new Error('OPENSUBTITLES_API_KEY is not set');
  }
  return key;
}

function getMaxSearchStrategies() {
  const configured = parseInt(process.env.OPENSUBTITLES_MAX_SEARCH_STRATEGIES || '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_MAX_SEARCH_STRATEGIES;
}

function isAggressiveFallbackEnabled() {
  return process.env.OPENSUBTITLES_AGGRESSIVE_FALLBACK === 'true';
}

function assertNotInRateLimitCooldown() {
  if (Date.now() < rateLimitedUntil) {
    const waitSeconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new OpenSubtitlesRateLimitError(`OpenSubtitles rate limit cooldown active. Try again in ${waitSeconds}s.`);
  }
}

function markRateLimited() {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
}

function baseHeaders() {
  return {
    'Api-Key': getApiKey(),
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

async function parseJsonResponse(res, context) {
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${context}: invalid JSON response (HTTP ${res.status})`);
  }

  if (res.status === 429) {
    markRateLimited();
    const message = (json && json.message) || 'API rate limit exceeded';
    throw new OpenSubtitlesRateLimitError(`${context}: ${message}`);
  }

  if (!res.ok) {
    const message = (json && json.message) || `HTTP ${res.status}`;
    if (/rate\s*limit/i.test(message)) {
      markRateLimited();
      throw new OpenSubtitlesRateLimitError(`${context}: ${message}`);
    }
    throw new Error(`${context}: ${message}`);
  }

  return json;
}

async function login() {
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) {
    return null;
  }
  if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) {
    return cachedToken;
  }

  try {
    assertNotInRateLimitCooldown();
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({ username, password }),
    });
    const json = await parseJsonResponse(res, 'OpenSubtitles login');
    cachedToken = json.token || null;
    cachedTokenAt = Date.now();
    if (cachedToken) {
      logger.info('Logged in to OpenSubtitles.');
    }
    return cachedToken;
  } catch (err) {
    if (err instanceof OpenSubtitlesRateLimitError || err.code === 'OPENSUBTITLES_RATE_LIMIT') {
      throw err;
    }
    logger.warn(`OpenSubtitles login failed, continuing without it: ${err.message}`);
    cachedToken = null;
    return null;
  }
}

async function authHeaders() {
  const token = await login();
  const headers = baseHeaders();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function removeTrailingMediaExtension(value) {
  return String(value || '').replace(/\.(srt|vtt|ass|ssa|sub|txt|mkv|mp4|avi|mov|webm)$/i, '');
}

function compact(value) {
  return String(value || '')
    .replace(/[_\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExtension(filename) {
  return compact(removeTrailingMediaExtension(filename));
}

function normalizeTitleToken(value) {
  return compact(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function significantTokens(value) {
  const stopWords = new Set([
    'and', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 's', 'e',
    'season', 'episode', 'web', 'dl', 'webrip', 'hdtv', 'bluray', 'aac', 'av1',
    'x264', 'x265', 'h264', 'h265', '480p', '720p', '1080p', '2160p', 'mp4', 'mkv'
  ]);

  return normalizeTitleToken(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

function containsAllTokens(searchable, tokens) {
  if (!tokens.length) return true;
  return tokens.every((token) => searchable.includes(token));
}

function seasonEpisodeCode(season, episode) {
  if (season == null || episode == null) return null;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `s${s}e${e}`;
}

function cleanEpisodeTitle(value) {
  if (!value) return null;

  const cleaned = removeTrailingMediaExtension(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(\d{3,4}p|x26[45]|h\.?26[45]|web[- ]?dl|web[- ]?rip|bluray|brrip|hdtv|aac|av1|edge\d*|proper|repack)\b.*$/i, ' ')
    .replace(/[\s\-_.]+$/g, '')
    .replace(/^[\s\-_.]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || null;
}

function extractFilenameParts(filename) {
  if (!filename) return {};

  const withoutExt = stripExtension(filename);
  const seasonEpisodeMatch = withoutExt.match(/\bS\s*(\d{1,2})\s*E\s*(\d{1,3})\b/i)
    || withoutExt.match(/\b(\d{1,2})x(\d{1,3})\b/i);

  let showTitle = null;
  let episodeTitle = null;

  if (seasonEpisodeMatch) {
    const before = withoutExt.slice(0, seasonEpisodeMatch.index).replace(/[\s\-]+$/g, '').trim();
    const after = withoutExt.slice(seasonEpisodeMatch.index + seasonEpisodeMatch[0].length)
      .replace(/^[\s\-]+/g, '')
      .trim();

    showTitle = before || null;
    episodeTitle = cleanEpisodeTitle(after);
  }

  const parts = {
    filename: withoutExt,
    showTitle,
    episodeTitle,
    filenameSeason: seasonEpisodeMatch ? parseInt(seasonEpisodeMatch[1], 10) : null,
    filenameEpisode: seasonEpisodeMatch ? parseInt(seasonEpisodeMatch[2], 10) : null,
  };

  logger.info(`Filename parsed: ${JSON.stringify(parts)}`);
  return parts;
}

function searchableText(item) {
  const attrs = item.attributes || {};
  const feature = attrs.feature_details || {};
  const file = attrs.files && attrs.files[0];
  return normalizeTitleToken([
    attrs.release,
    attrs.uploader && attrs.uploader.name,
    attrs.comments,
    file && file.file_name,
    feature.title,
    feature.parent_title,
    feature.movie_name,
  ].filter(Boolean).join(' '));
}

function isSafeFallbackCandidate(item, context = {}) {
  const label = context.strategyLabel || '';

  if (label === 'exact-imdb' || label === 'episode-imdb' || label === 'video-hash') return true;

  const searchable = searchableText(item);
  const showTokens = significantTokens(context.showTitle);
  const episodeTokens = significantTokens(context.episodeTitle);
  const seCode = seasonEpisodeCode(context.season, context.episode);
  const filenameSeCode = seasonEpisodeCode(context.filenameSeason, context.filenameEpisode);

  if (showTokens.length && !containsAllTokens(searchable, showTokens)) {
    return false;
  }

  if (episodeTokens.length && !containsAllTokens(searchable, episodeTokens)) {
    return false;
  }

  if (!episodeTokens.length && (seCode || filenameSeCode)) {
    const expectedCode = seCode || filenameSeCode;
    if (!searchable.includes(expectedCode)) return false;
  }

  return true;
}

function scoreResult(item, context = {}) {
  const attrs = item.attributes || {};
  const searchable = searchableText(item);

  let score = (attrs.from_trusted ? 1000000 : 0) + (attrs.download_count || 0);

  if (context.filename) {
    const wanted = normalizeTitleToken(context.filename);
    if (wanted && searchable.includes(wanted)) score += 50000;
  }

  if (context.showTitle) {
    const showTokens = significantTokens(context.showTitle);
    if (containsAllTokens(searchable, showTokens)) score += 30000;
  }

  if (context.episodeTitle) {
    const episodeTokens = significantTokens(context.episodeTitle);
    if (containsAllTokens(searchable, episodeTokens)) score += 25000;
  }

  return score;
}

function bestSubtitleFromResults(results, context = {}) {
  if (!results.length) return null;

  const safeResults = results.filter((item) => isSafeFallbackCandidate(item, context));
  const rejectedCount = results.length - safeResults.length;

  if (!safeResults.length) {
    logger.warn(
      `OpenSubtitles ${context.strategyLabel || 'unknown'} returned ${results.length} result(s), ` +
      'but none matched the requested title safely.'
    );
    return null;
  }

  if (rejectedCount > 0) {
    logger.info(
      `OpenSubtitles rejected ${rejectedCount} unsafe candidate(s) for ${context.strategyLabel || 'unknown'}.`
    );
  }

  const sorted = [...safeResults].sort(
    (a, b) => scoreResult(b, context) - scoreResult(a, context) || String(a.id).localeCompare(String(b.id))
  );
  const best = sorted[0];
  const file = best.attributes && best.attributes.files && best.attributes.files[0];
  if (!file) return null;

  return {
    provider: 'opensubtitles',
    fileId: file.file_id,
    subtitleId: best.id,
    language: (best.attributes && best.attributes.language) || 'en',
    releaseName: (best.attributes && best.attributes.release) || file.file_name || '',
  };
}

async function searchOpenSubtitles(params, context = {}) {
  assertNotInRateLimitCooldown();
  const headers = await authHeaders();
  delete headers['Content-Type'];

  logger.info(`Searching OpenSubtitles: ${params.toString()}`);
  const res = await fetch(`${BASE_URL}/subtitles?${params.toString()}`, { headers });
  const json = await parseJsonResponse(res, 'OpenSubtitles search');

  const results = Array.isArray(json.data) ? json.data : [];
  logger.info(`OpenSubtitles returned ${results.length} result(s).`);
  return bestSubtitleFromResults(results, context);
}

function exactParams({ imdbId, season, episode, type }) {
  const numericImdbId = String(imdbId).replace(/^tt/i, '');
  const params = new URLSearchParams({ languages: 'en' });

  if (type === 'series' && season != null && episode != null) {
    params.set('parent_imdb_id', numericImdbId);
    params.set('season_number', String(season));
    params.set('episode_number', String(episode));
  } else {
    params.set('imdb_id', numericImdbId);
  }

  return params;
}

function imdbIdParams(imdbId) {
  if (!imdbId) return null;
  const numericImdbId = String(imdbId).replace(/^tt/i, '');
  return new URLSearchParams({ languages: 'en', imdb_id: numericImdbId });
}

function movieHashParams(extra = {}) {
  if (!extra.videoHash) return null;

  const params = new URLSearchParams({
    languages: 'en',
    moviehash: String(extra.videoHash),
  });

  if (extra.videoSize) {
    params.set('moviebytesize', String(extra.videoSize));
  }

  return params;
}

function queryParams(query, { season, episode } = {}) {
  if (!query || !query.trim()) return null;

  const params = new URLSearchParams({ languages: 'en', query: query.trim() });
  if (season != null) params.set('season_number', String(season));
  if (episode != null) params.set('episode_number', String(episode));
  return params;
}

function addUniqueStrategy(strategies, label, params) {
  if (!params) return;
  const key = params.toString();
  if (!key || strategies.some((s) => s.key === key)) return;
  strategies.push({ label, params, key });
}

function addTitleFallbacks(strategies, filenameParts, metadata) {
  const showTitle = (metadata && (metadata.showTitle || metadata.originalShowTitle)) || filenameParts.showTitle;
  const episodeTitle = (metadata && metadata.episodeTitle) || filenameParts.episodeTitle;

  if (showTitle && episodeTitle) {
    addUniqueStrategy(strategies, 'show-plus-episode-title-query', queryParams(`${showTitle} ${episodeTitle}`));
  }

  if (metadata && metadata.originalShowTitle && metadata.episodeTitle && metadata.originalShowTitle !== metadata.showTitle) {
    addUniqueStrategy(
      strategies,
      'original-show-plus-episode-title-query',
      queryParams(`${metadata.originalShowTitle} ${metadata.episodeTitle}`)
    );
  }

  if (episodeTitle) {
    addUniqueStrategy(strategies, 'episode-title-query', queryParams(episodeTitle));
  }
}

async function buildSearchStrategies({ imdbId, season, episode, type, extra = {} }) {
  const filenameParts = extractFilenameParts(extra.filename);
  const metadata = type === 'series'
    ? await tmdbProvider.getEpisodeMetadata({ imdbId, season, episode })
    : null;

  const strategies = [];

  addUniqueStrategy(strategies, 'video-hash', movieHashParams(extra));

  if (metadata && metadata.episodeImdbId) {
    addUniqueStrategy(strategies, 'episode-imdb', imdbIdParams(metadata.episodeImdbId));
  }

  addUniqueStrategy(strategies, 'exact-imdb', exactParams({ imdbId, season, episode, type }));
  addTitleFallbacks(strategies, filenameParts, metadata);

  if (!metadata && filenameParts.filename && type !== 'series') {
    addUniqueStrategy(strategies, 'filename-query', queryParams(filenameParts.filename));
  }

  if (isAggressiveFallbackEnabled() && type === 'series' && season != null && episode != null) {
    for (const offset of [-1, 1]) {
      const altSeason = season + offset;
      if (altSeason > 0) {
        addUniqueStrategy(strategies, `nearby-season-${altSeason}`, exactParams({ imdbId, season: altSeason, episode, type }));
      }
    }
  }

  return { strategies: strategies.slice(0, getMaxSearchStrategies()), filenameParts, metadata };
}

async function findEnglishSubtitle({ imdbId, season, episode, type, extra = {} }) {
  const { strategies, filenameParts, metadata } = await buildSearchStrategies({ imdbId, season, episode, type, extra });
  const context = {
    filename: filenameParts.filename,
    showTitle: (metadata && (metadata.showTitle || metadata.originalShowTitle)) || filenameParts.showTitle,
    episodeTitle: (metadata && metadata.episodeTitle) || filenameParts.episodeTitle,
    filenameSeason: filenameParts.filenameSeason,
    filenameEpisode: filenameParts.filenameEpisode,
    season,
    episode,
  };

  logger.info(`OpenSubtitles search plan: ${strategies.map((s) => s.label).join(' -> ') || 'none'}`);

  for (const strategy of strategies) {
    logger.info(`OpenSubtitles strategy: ${strategy.label}`);
    const result = await searchOpenSubtitles(strategy.params, { ...context, strategyLabel: strategy.label });
    if (result) {
      logger.info(
        `OpenSubtitles selected subtitle via ${strategy.label}: file_id=${result.fileId} release=${result.releaseName || 'unknown'}`
      );
      return result;
    }
  }

  return null;
}

async function downloadSubtitleContent(fileId) {
  assertNotInRateLimitCooldown();
  const headers = await authHeaders();

  logger.info(`Requesting OpenSubtitles download link for file_id=${fileId}`);
  const res = await fetch(`${BASE_URL}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
  });
  const json = await parseJsonResponse(res, 'OpenSubtitles download');

  if (!json.link) {
    throw new Error('OpenSubtitles download response is missing a link');
  }

  const fileRes = await fetch(json.link);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch subtitle file content: HTTP ${fileRes.status}`);
  }
  return fileRes.text();
}

module.exports = { findEnglishSubtitle, downloadSubtitleContent, OpenSubtitlesRateLimitError };
