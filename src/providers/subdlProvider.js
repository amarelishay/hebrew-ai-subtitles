'use strict';

const logger = require('../utils/logger');
const tmdbProvider = require('./tmdbProvider');
const { shortHash } = require('../utils/hash');

const BASE_URL = 'https://api.subdl.com/api/v1/subtitles';
const FILE_BASE_URL = 'https://dl.subdl.com';
const DEFAULT_MAX_SEARCH_STRATEGIES = 8;

function getApiKey() {
  return process.env.SUBDL_API_KEY || '';
}

function getMaxSearchStrategies() {
  const configured = parseInt(process.env.SUBDL_MAX_SEARCH_STRATEGIES || '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_MAX_SEARCH_STRATEGIES;
}

function compact(value) {
  return String(value || '').replace(/[_\.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripExtension(value) {
  return compact(String(value || '').replace(/\.(srt|vtt|ass|ssa|sub|txt|mkv|mp4|avi|mov|webm)$/i, ''));
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

  return normalizeTitleToken(value).split(' ').filter((token) => token.length >= 2 && !stopWords.has(token));
}

function containsAllTokens(searchable, tokens) {
  return !tokens.length || tokens.every((token) => searchable.includes(token));
}

function seasonEpisodeCode(season, episode) {
  if (season == null || episode == null) return null;
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return `s${String(s).padStart(2, '0')}e${String(e).padStart(2, '0')}`;
}

function seasonEpisodeCodes(season, episode) {
  const compactCode = seasonEpisodeCode(season, episode);
  if (!compactCode) return [];
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  return [compactCode, `${s}x${String(e).padStart(2, '0')}`, `${s}x${e}`];
}

function hasSeasonEpisode(searchable, season, episode) {
  return seasonEpisodeCodes(season, episode).some((code) => searchable.includes(code));
}

function cleanEpisodeTitle(value) {
  if (!value) return null;
  const cleaned = stripExtension(value)
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
  const match = withoutExt.match(/\bS\s*(\d{1,2})\s*E\s*(\d{1,3})\b/i) || withoutExt.match(/\b(\d{1,2})x(\d{1,3})\b/i);

  if (!match) return { filename: withoutExt };

  const showTitle = withoutExt.slice(0, match.index).replace(/[\s\-]+$/g, '').trim() || null;
  const episodeTitle = cleanEpisodeTitle(withoutExt.slice(match.index + match[0].length).replace(/^[\s\-]+/g, '').trim());

  return {
    filename: withoutExt,
    showTitle,
    episodeTitle,
    filenameSeason: parseInt(match[1], 10),
    filenameEpisode: parseInt(match[2], 10),
  };
}

function normalizeSubtitleUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${FILE_BASE_URL}${url}`;
  return `${FILE_BASE_URL}/${url}`;
}

function getItemUrl(item) {
  return normalizeSubtitleUrl(item.url || item.subtitle_url || item.download_url || item.file || item.path);
}

function getItemLanguage(item) {
  return String(item.lang || item.language || item.language_name || '').trim();
}

function getItemId(item) {
  return String(item.file_id || item.file_n_id || item.n_id || item.sd_id || item.id || item.md5 || getItemUrl(item) || shortHash(item));
}

function searchableText(item) {
  return normalizeTitleToken([
    item.release_name,
    item.name,
    item.filename,
    item.file_name,
    item.subtitle_name,
    item.url,
    item.subtitle_url,
    item.download_url,
  ].filter(Boolean).join(' '));
}

function isSafeCandidate(item, context = {}) {
  const label = context.strategyLabel || '';
  if (label.includes('imdb') || label.includes('tmdb')) return true;

  const searchable = searchableText(item);
  const showTokens = significantTokens(context.showTitle);
  const episodeTokens = significantTokens(context.episodeTitle);

  if (showTokens.length && !containsAllTokens(searchable, showTokens)) return false;

  const hasEpisodeTitle = episodeTokens.length ? containsAllTokens(searchable, episodeTokens) : false;
  const hasEpisodeCode = hasSeasonEpisode(searchable, context.season, context.episode) || hasSeasonEpisode(searchable, context.filenameSeason, context.filenameEpisode);

  if (episodeTokens.length || context.season != null || context.filenameSeason != null) {
    return hasEpisodeTitle || hasEpisodeCode;
  }

  return true;
}

function scoreCandidate(item, context = {}) {
  const searchable = searchableText(item);
  let score = 0;

  const lang = getItemLanguage(item).toLowerCase();
  if (context.preferredLanguage && lang.includes(String(context.preferredLanguage).toLowerCase())) score += 100000;
  if (hasSeasonEpisode(searchable, context.season, context.episode)) score += 40000;
  if (hasSeasonEpisode(searchable, context.filenameSeason, context.filenameEpisode)) score += 40000;
  if (context.showTitle && containsAllTokens(searchable, significantTokens(context.showTitle))) score += 30000;
  if (context.episodeTitle && containsAllTokens(searchable, significantTokens(context.episodeTitle))) score += 25000;

  return score;
}

function bestSubtitleFromResults(results, context = {}) {
  const safe = results.filter((item) => isSafeCandidate(item, context) && getItemUrl(item));
  if (!safe.length) {
    logger.warn(`SubDL ${context.strategyLabel || 'unknown'} returned ${results.length} result(s), but none matched safely.`);
    return null;
  }

  const best = [...safe].sort((a, b) => scoreCandidate(b, context) - scoreCandidate(a, context))[0];
  const url = getItemUrl(best);
  const id = getItemId(best);

  return {
    provider: 'subdl',
    fileId: id,
    subtitleId: id,
    language: getItemLanguage(best) || 'unknown',
    releaseName: best.release_name || best.name || best.filename || best.file_name || url,
    url,
  };
}

function baseParams({ language, type }) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const params = new URLSearchParams({
    api_key: apiKey,
    type: type === 'series' ? 'tv' : 'movie',
    subs_per_page: '30',
    unpack: '1',
  });

  if (language) params.set('languages', language.toUpperCase());
  return params;
}

function addUniqueStrategy(strategies, label, params) {
  if (!params) return;
  const key = params.toString();
  if (!key || strategies.some((s) => s.key === key)) return;
  strategies.push({ label, params, key });
}

function imdbVariants(imdbId) {
  if (!imdbId) return [];
  const raw = String(imdbId).trim();
  if (!raw) return [];
  const numeric = raw.replace(/^tt/i, '');
  return [...new Set([`tt${numeric}`, numeric].filter(Boolean))];
}

function addImdbStrategy(strategies, label, imdbId, options) {
  for (const variant of imdbVariants(imdbId)) {
    const params = baseParams(options);
    if (!params) continue;
    params.set('imdb_id', variant);
    addUniqueStrategy(strategies, `${label}-${variant.startsWith('tt') ? 'tt' : 'numeric'}`, params);
  }
}

function addTmdbStrategy(strategies, label, tmdbId, options) {
  if (!tmdbId) return;
  const params = baseParams(options);
  if (!params) return;
  params.set('tmdb_id', String(tmdbId));
  addUniqueStrategy(strategies, label, params);
}

function addFileNameStrategy(strategies, filename, options) {
  if (!filename) return;
  const params = baseParams(options);
  if (!params) return;
  params.set('file_name', filename);
  addUniqueStrategy(strategies, 'filename', params);
}

function addFilmNameStrategy(strategies, label, filmName, options, { season, episode } = {}) {
  if (!filmName) return;
  const params = baseParams(options);
  if (!params) return;
  params.set('film_name', filmName);
  if (season != null) params.set('season_number', String(season));
  if (episode != null) params.set('episode_number', String(episode));
  addUniqueStrategy(strategies, label, params);
}

async function buildStrategies({ imdbId, season, episode, type, extra = {}, language }) {
  const filenameParts = extractFilenameParts(extra.filename);
  const metadata = type === 'series' ? await tmdbProvider.getEpisodeMetadata({ imdbId, season, episode }) : null;
  const options = { language, type };
  const strategies = [];

  addImdbStrategy(strategies, 'episode-imdb', metadata && metadata.episodeImdbId, options);
  addImdbStrategy(strategies, 'imdb', imdbId, options);
  addTmdbStrategy(strategies, 'tmdb-tv', metadata && metadata.tmdbTvId, options);
  addFileNameStrategy(strategies, extra.filename, options);

  const showTitle = (metadata && (metadata.showTitle || metadata.originalShowTitle)) || filenameParts.showTitle;
  const episodeTitle = (metadata && metadata.episodeTitle) || filenameParts.episodeTitle;
  const seCode = seasonEpisodeCode(filenameParts.filenameSeason || season, filenameParts.filenameEpisode || episode);

  if (showTitle && seCode) addFilmNameStrategy(strategies, 'show-season-episode', `${showTitle} ${seCode.toUpperCase()}`, options);
  if (showTitle && episodeTitle) addFilmNameStrategy(strategies, 'show-episode-title', `${showTitle} ${episodeTitle}`, options);
  if (episodeTitle) addFilmNameStrategy(strategies, 'episode-title', episodeTitle, options, { season, episode });

  return {
    strategies: strategies.slice(0, getMaxSearchStrategies()),
    context: {
      filename: filenameParts.filename,
      showTitle,
      episodeTitle,
      filenameSeason: filenameParts.filenameSeason,
      filenameEpisode: filenameParts.filenameEpisode,
      season,
      episode,
      preferredLanguage: language,
    },
  };
}

async function searchSubDL(params, context = {}) {
  logger.info(`Searching SubDL: ${params.toString().replace(/api_key=[^&]+/, 'api_key=***')}`);

  const res = await fetch(`${BASE_URL}?${params.toString()}`);
  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`SubDL invalid JSON response: ${err.message}`);
  }

  if (!res.ok || json.status === false || json.success === false) {
    const message = json.message || json.error || `HTTP ${res.status}`;
    throw new Error(`SubDL search failed: ${message}`);
  }

  const results = Array.isArray(json.subtitles) ? json.subtitles : [];
  logger.info(`SubDL returned ${results.length} result(s).`);
  return bestSubtitleFromResults(results, context);
}

async function findSubtitle({ imdbId, season, episode, type, extra = {}, language = 'EN' }) {
  if (!getApiKey()) {
    logger.warn('SUBDL_API_KEY is not set - skipping SubDL provider.');
    return null;
  }

  const { strategies, context } = await buildStrategies({ imdbId, season, episode, type, extra, language });
  logger.info(`SubDL search plan (${language || 'any'}): ${strategies.map((s) => s.label).join(' -> ') || 'none'}`);

  for (const strategy of strategies) {
    try {
      logger.info(`SubDL strategy: ${strategy.label}`);
      const result = await searchSubDL(strategy.params, { ...context, strategyLabel: strategy.label });
      if (result) {
        logger.info(`SubDL selected subtitle via ${strategy.label}: id=${result.fileId} release=${result.releaseName || 'unknown'} language=${result.language}`);
        return result;
      }
    } catch (err) {
      logger.warn(`SubDL strategy failed: ${strategy.label}: ${err.message}`);
    }
  }

  return null;
}

async function findEnglishSubtitle(args) {
  return findSubtitle({ ...args, language: 'EN' });
}

async function downloadSubtitleContent(sourceSubtitle) {
  const url = sourceSubtitle && sourceSubtitle.url;
  if (!url) throw new Error('SubDL source subtitle is missing url');

  if (/\.(zip)(\?|$)/i.test(url)) {
    throw new Error('SubDL archive subtitle source is not supported yet');
  }

  logger.info(`Downloading SubDL subtitle: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SubDL subtitle download failed: HTTP ${res.status}`);
  return res.text();
}

module.exports = {
  findSubtitle,
  findEnglishSubtitle,
  downloadSubtitleContent,
};
