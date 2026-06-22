'use strict';

// Thin client for the OpenSubtitles REST API v1 (api.opensubtitles.com).
// It prefers English subtitles, but can also return the safest subtitle in any
// available language because the downstream LLM can translate non-English text.
// No scraping, no torrents, no video of any kind.

const AdmZip = require('adm-zip');
const logger = require('../utils/logger');
const tmdbProvider = require('./tmdbProvider');

const BASE_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'HebrewAISubtitles v0.1.0';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const DEFAULT_MAX_SEARCH_STRATEGIES = 4;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_CANDIDATES = 6;

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

function isRateLimitError(err) {
  return err instanceof OpenSubtitlesRateLimitError || err.code === 'OPENSUBTITLES_RATE_LIMIT';
}

function assertNotInRateLimitCooldown() {
  if (Date.now() < rateLimitedUntil) {
    const waitSeconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new OpenSubtitlesRateLimitError(
      `OpenSubtitles rate limit cooldown active. Try again in ${waitSeconds}s.`
    );
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
    if (isRateLimitError(err)) throw err;

    logger.warn(`OpenSubtitles login failed, continuing without it: ${err.message}`);
    cachedToken = null;
    return null;
  }
}

async function authHeaders() {
  const token = await login();
  const headers = baseHeaders();
  delete headers['Content-Type'];

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function languageCodeForOpenSubtitles(language) {
  if (!language) return null;
  const normalized = String(language).trim().toLowerCase();

  if (['en', 'eng', 'english'].includes(normalized)) return 'en';
  if (['he', 'heb', 'hebrew'].includes(normalized)) return 'he';
  if (['ar', 'ara', 'arabic'].includes(normalized)) return 'ar';

  return normalized;
}

function removeTrailingMediaExtension(value) {
  return String(value || '').replace(/\.(srt|vtt|ass|ssa|sub|txt|zip|rar|mkv|mp4|avi|mov|webm)$/i, '');
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
    'x264', 'x265', 'h264', 'h265', '480p', '720p', '1080p', '2160p', 'mp4', 'mkv',
    'subtitle', 'subtitles', 'english', 'arabic', 'hebrew', 'ara', 'eng', 'heb'
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

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);

  if (!Number.isFinite(seasonNum) || !Number.isFinite(episodeNum)) return null;

  return `s${String(seasonNum).padStart(2, '0')}e${String(episodeNum).padStart(2, '0')}`;
}

function seasonEpisodeCodes(season, episode) {
  const compactCode = seasonEpisodeCode(season, episode);
  if (!compactCode) return [];

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);
  const s2 = String(seasonNum).padStart(2, '0');
  const e2 = String(episodeNum).padStart(2, '0');

  return [
    compactCode,
    `s${s2} e${e2}`,
    `${seasonNum}x${e2}`,
    `${seasonNum}x${episodeNum}`,
    `season ${seasonNum} episode ${episodeNum}`,
    `season ${s2} episode ${e2}`,
  ];
}

function searchableHasSeasonEpisode(searchable, season, episode) {
  return seasonEpisodeCodes(season, episode).some((code) => searchable.includes(code));
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
    showTitle = withoutExt.slice(0, seasonEpisodeMatch.index).replace(/[\s\-]+$/g, '').trim() || null;
    episodeTitle = cleanEpisodeTitle(
      withoutExt.slice(seasonEpisodeMatch.index + seasonEpisodeMatch[0].length)
        .replace(/^[\s\-]+/g, '')
        .trim()
    );
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

function resultFiles(item) {
  const attrs = item.attributes || {};
  return Array.isArray(attrs.files) ? attrs.files.filter(Boolean) : [];
}

function resultSearchableFields(item) {
  const attrs = item.attributes || {};
  const feature = attrs.feature_details || {};
  const files = resultFiles(item);

  return [
    attrs.release,
    attrs.url,
    attrs.comments,
    attrs.language,
    attrs.uploader && attrs.uploader.name,
    feature.title,
    feature.parent_title,
    feature.movie_name,
    ...files.flatMap((file) => [file.file_name, file.filename, file.name, file.url]),
  ].filter(Boolean);
}

function searchableText(item) {
  return normalizeTitleToken(resultSearchableFields(item).join(' '));
}

function isExactStrategy(label) {
  return label === 'exact-imdb' || label === 'episode-imdb' || label === 'video-hash';
}

function isSafeFallbackCandidate(item, context = {}) {
  const label = context.strategyLabel || '';
  if (isExactStrategy(label)) return true;

  const searchable = searchableText(item);
  const showTokens = significantTokens(context.showTitle);
  const episodeTokens = significantTokens(context.episodeTitle);

  if (showTokens.length && !containsAllTokens(searchable, showTokens)) return false;

  const hasEpisodeTitleMatch = episodeTokens.length
    ? containsAllTokens(searchable, episodeTokens)
    : false;

  const hasSeasonEpisodeMatch =
    searchableHasSeasonEpisode(searchable, context.season, context.episode) ||
    searchableHasSeasonEpisode(searchable, context.filenameSeason, context.filenameEpisode);

  if (context.season != null || context.filenameSeason != null || episodeTokens.length) {
    return hasSeasonEpisodeMatch || hasEpisodeTitleMatch;
  }

  return true;
}

function scoreResult(item, context = {}) {
  const attrs = item.attributes || {};
  const searchable = searchableText(item);
  let score = (attrs.from_trusted ? 1000000 : 0) + (attrs.download_count || 0);

  if (context.preferredLanguage) {
    const lang = String(attrs.language || '').toLowerCase();
    if (lang === context.preferredLanguage || lang.startsWith(context.preferredLanguage)) score += 500000;
  }

  if (context.filename) {
    const wanted = normalizeTitleToken(context.filename);
    if (wanted && searchable.includes(wanted)) score += 50000;
  }

  if (
    searchableHasSeasonEpisode(searchable, context.season, context.episode) ||
    searchableHasSeasonEpisode(searchable, context.filenameSeason, context.filenameEpisode)
  ) {
    score += 60000;
  }

  if (context.showTitle && containsAllTokens(searchable, significantTokens(context.showTitle))) score += 30000;
  if (context.episodeTitle && containsAllTokens(searchable, significantTokens(context.episodeTitle))) score += 25000;

  return score;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).trim() !== '').map(String))];
}

function strictIdsFromFileText(value) {
  const text = String(value || '');
  const ids = [];

  for (const match of text.matchAll(/\((\d{5,})\)/g)) ids.push(match[1]);
  for (const match of text.matchAll(/(?:file_id=|subtitle\/|download\/)(\d{5,})/gi)) ids.push(match[1]);

  return ids;
}

function candidateFileIdsForItem(item) {
  const attrs = item.attributes || {};
  const files = resultFiles(item);
  const rawIds = [];

  for (const file of files) {
    rawIds.push(file.file_id, file.fileId, file.fileid);
    rawIds.push(...strictIdsFromFileText(file.file_name));
    rawIds.push(...strictIdsFromFileText(file.filename));
    rawIds.push(...strictIdsFromFileText(file.name));
    rawIds.push(...strictIdsFromFileText(file.url));
  }

  rawIds.push(attrs.file_id, attrs.fileId);
  rawIds.push(...strictIdsFromFileText(attrs.url));

  return unique(rawIds);
}

function releaseNameForItem(item) {
  const attrs = item.attributes || {};
  const files = resultFiles(item);
  const firstFile = files[0] || {};
  return attrs.release || firstFile.file_name || firstFile.filename || firstFile.name || attrs.url || '';
}

function sourceFromSortedResults(sorted, context = {}) {
  const best = sorted[0];
  const bestAttrs = best.attributes || {};
  const candidateFileIds = [];

  for (const item of sorted.slice(0, 4)) {
    candidateFileIds.push(...candidateFileIdsForItem(item));
    if (unique(candidateFileIds).length >= MAX_DOWNLOAD_CANDIDATES) break;
  }

  const ids = unique(candidateFileIds).slice(0, MAX_DOWNLOAD_CANDIDATES);
  if (!ids.length) return null;

  return {
    provider: 'opensubtitles',
    fileId: ids.join('|'),
    candidateFileIds: ids,
    subtitleId: best.id,
    language: bestAttrs.language || context.preferredLanguage || 'unknown',
    releaseName: releaseNameForItem(best),
  };
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
    logger.info(`OpenSubtitles rejected ${rejectedCount} unsafe candidate(s) for ${context.strategyLabel || 'unknown'}.`);
  }

  const sorted = [...safeResults].sort(
    (a, b) => scoreResult(b, context) - scoreResult(a, context) || String(a.id).localeCompare(String(b.id))
  );

  const source = sourceFromSortedResults(sorted, context);
  if (!source) {
    logger.warn(`OpenSubtitles ${context.strategyLabel || 'unknown'} matched result(s), but none exposed a usable file id.`);
    return null;
  }

  if (source.candidateFileIds.length > 1) {
    logger.info(
      `OpenSubtitles prepared ${source.candidateFileIds.length} candidate file id(s) for ${context.strategyLabel || 'unknown'}.`
    );
  }

  return source;
}

async function searchOpenSubtitles(params, context = {}) {
  assertNotInRateLimitCooldown();
  const headers = await authHeaders();

  logger.info(`Searching OpenSubtitles: ${params.toString()}`);
  const res = await fetch(`${BASE_URL}/subtitles?${params.toString()}`, { headers });
  const json = await parseJsonResponse(res, 'OpenSubtitles search');

  const results = Array.isArray(json.data) ? json.data : [];
  logger.info(`OpenSubtitles returned ${results.length} result(s).`);
  return bestSubtitleFromResults(results, context);
}

function setLanguageParam(params, language) {
  const code = languageCodeForOpenSubtitles(language);
  if (code) params.set('languages', code);
  return params;
}

function exactParams({ imdbId, season, episode, type, language }) {
  const numericImdbId = String(imdbId).replace(/^tt/i, '');
  const params = new URLSearchParams();
  setLanguageParam(params, language);

  if (type === 'series' && season != null && episode != null) {
    params.set('parent_imdb_id', numericImdbId);
    params.set('season_number', String(season));
    params.set('episode_number', String(episode));
  } else {
    params.set('imdb_id', numericImdbId);
  }

  return params;
}

function imdbIdParams(imdbId, language) {
  if (!imdbId) return null;
  const numericImdbId = String(imdbId).replace(/^tt/i, '');
  const params = new URLSearchParams({ imdb_id: numericImdbId });
  return setLanguageParam(params, language);
}

function movieHashParams(extra = {}, language) {
  if (!extra.videoHash) return null;
  const params = new URLSearchParams({ moviehash: String(extra.videoHash) });
  setLanguageParam(params, language);
  if (extra.videoSize) params.set('moviebytesize', String(extra.videoSize));
  return params;
}

function queryParams(query, { language, season, episode } = {}) {
  if (!query || !query.trim()) return null;
  const params = new URLSearchParams({ query: query.trim() });
  setLanguageParam(params, language);
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

function addTitleFallbacks(strategies, filenameParts, metadata, season, episode, language) {
  const showTitle = (metadata && (metadata.showTitle || metadata.originalShowTitle)) || filenameParts.showTitle;
  const episodeTitle = (metadata && metadata.episodeTitle) || filenameParts.episodeTitle;
  const effectiveSeason = filenameParts.filenameSeason || season;
  const effectiveEpisode = filenameParts.filenameEpisode || episode;
  const seCompact = seasonEpisodeCode(effectiveSeason, effectiveEpisode);

  if (showTitle && seCompact) {
    addUniqueStrategy(strategies, 'show-plus-season-episode-query', queryParams(`${showTitle} ${seCompact.toUpperCase()}`, { language }));
  }

  if (showTitle && episodeTitle) {
    addUniqueStrategy(strategies, 'show-plus-episode-title-query', queryParams(`${showTitle} ${episodeTitle}`, { language }));
  }

  if (metadata && metadata.originalShowTitle && metadata.episodeTitle && metadata.originalShowTitle !== metadata.showTitle) {
    addUniqueStrategy(strategies, 'original-show-plus-episode-title-query', queryParams(`${metadata.originalShowTitle} ${metadata.episodeTitle}`, { language }));
  }

  if (episodeTitle) {
    addUniqueStrategy(strategies, 'episode-title-query', queryParams(episodeTitle, { language }));
  }
}

async function buildSearchStrategies({ imdbId, season, episode, type, extra = {}, language = 'en' }) {
  const filenameParts = extractFilenameParts(extra.filename);
  const metadata = type === 'series'
    ? await tmdbProvider.getEpisodeMetadata({ imdbId, season, episode })
    : null;

  const strategies = [];
  addUniqueStrategy(strategies, 'video-hash', movieHashParams(extra, language));

  if (metadata && metadata.episodeImdbId) {
    addUniqueStrategy(strategies, 'episode-imdb', imdbIdParams(metadata.episodeImdbId, language));
  }

  addUniqueStrategy(strategies, 'exact-imdb', exactParams({ imdbId, season, episode, type, language }));
  addTitleFallbacks(strategies, filenameParts, metadata, season, episode, language);

  if (!metadata && filenameParts.filename && type !== 'series') {
    addUniqueStrategy(strategies, 'filename-query', queryParams(filenameParts.filename, { language }));
  }

  if (isAggressiveFallbackEnabled() && type === 'series' && season != null && episode != null) {
    for (const offset of [-1, 1]) {
      const altSeason = season + offset;
      if (altSeason > 0) {
        addUniqueStrategy(strategies, `nearby-season-${altSeason}`, exactParams({ imdbId, season: altSeason, episode, type, language }));
      }
    }
  }

  return { strategies: strategies.slice(0, getMaxSearchStrategies()), filenameParts, metadata };
}

async function findSourceSubtitle({ imdbId, season, episode, type, extra = {}, language = 'en' }) {
  const languageCode = languageCodeForOpenSubtitles(language);
  const languageLabel = languageCode || 'any';
  const { strategies, filenameParts, metadata } = await buildSearchStrategies({ imdbId, season, episode, type, extra, language: languageCode });

  const context = {
    filename: filenameParts.filename,
    showTitle: (metadata && (metadata.showTitle || metadata.originalShowTitle)) || filenameParts.showTitle,
    episodeTitle: (metadata && metadata.episodeTitle) || filenameParts.episodeTitle,
    filenameSeason: filenameParts.filenameSeason,
    filenameEpisode: filenameParts.filenameEpisode,
    season,
    episode,
    preferredLanguage: languageCode,
  };

  logger.info(`OpenSubtitles search plan (${languageLabel}): ${strategies.map((s) => s.label).join(' -> ') || 'none'}`);

  for (const strategy of strategies) {
    logger.info(`OpenSubtitles strategy (${languageLabel}): ${strategy.label}`);
    const result = await searchOpenSubtitles(strategy.params, { ...context, strategyLabel: strategy.label });
    if (result) {
      logger.info(
        `OpenSubtitles selected subtitle via ${strategy.label}: ` +
        `file_id=${result.fileId} lang=${result.language || 'unknown'} release=${result.releaseName || 'unknown'}`
      );
      return result;
    }
  }

  return null;
}

async function findEnglishSubtitle(args) {
  return findSourceSubtitle({ ...args, language: 'en' });
}

function subtitleTextFromBuffer(buffer, url = '') {
  const looksLikeZip = /\.(zip)(\?|$)/i.test(url) || buffer.slice(0, 2).toString('utf8') === 'PK';

  if (!looksLikeZip) return buffer.toString('utf8');

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries()
    .filter((entry) => !entry.isDirectory && /\.(srt|vtt)$/i.test(entry.entryName));

  if (!entries.length) throw new Error('OpenSubtitles ZIP did not contain an SRT/VTT file');

  entries.sort((a, b) => {
    const aScore = /\.srt$/i.test(a.entryName) ? 0 : 1;
    const bScore = /\.srt$/i.test(b.entryName) ? 0 : 1;
    return aScore - bScore || a.entryName.localeCompare(b.entryName);
  });

  logger.info(`Selected subtitle file from OpenSubtitles ZIP: ${entries[0].entryName}`);
  return entries[0].getData().toString('utf8');
}

async function downloadByFileId(fileId) {
  assertNotInRateLimitCooldown();
  const headers = await authHeaders();

  logger.info(`Requesting OpenSubtitles download link for file_id=${fileId}`);
  const res = await fetch(`${BASE_URL}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: Number.isFinite(Number(fileId)) ? Number(fileId) : fileId }),
  });

  const json = await parseJsonResponse(res, 'OpenSubtitles download');
  if (!json.link) throw new Error('OpenSubtitles download response is missing a link');

  const fileRes = await fetch(json.link);
  if (!fileRes.ok) throw new Error(`Failed to fetch subtitle file content: HTTP ${fileRes.status}`);

  const arrayBuffer = await fileRes.arrayBuffer();
  return subtitleTextFromBuffer(Buffer.from(arrayBuffer), json.link);
}

async function downloadSubtitleContent(sourceSubtitleOrFileId) {
  const rawCandidates = Array.isArray(sourceSubtitleOrFileId && sourceSubtitleOrFileId.candidateFileIds)
    ? sourceSubtitleOrFileId.candidateFileIds
    : [sourceSubtitleOrFileId && sourceSubtitleOrFileId.fileId ? sourceSubtitleOrFileId.fileId : sourceSubtitleOrFileId];

  const ids = unique(rawCandidates.flatMap((value) => String(value).split('|'))).slice(0, MAX_DOWNLOAD_CANDIDATES);
  let lastError = null;

  logger.info(`OpenSubtitles will try ${ids.length} download candidate(s).`);

  for (const fileId of ids) {
    try {
      return await downloadByFileId(fileId);
    } catch (err) {
      lastError = err;
      logger.warn(`OpenSubtitles file_id=${fileId} could not be downloaded: ${err.message}`);

      if (isRateLimitError(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error('OpenSubtitles source has no usable file_id candidates');
}

module.exports = {
  findSourceSubtitle,
  findEnglishSubtitle,
  downloadSubtitleContent,
  OpenSubtitlesRateLimitError,
};
