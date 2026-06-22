'use strict';

const AdmZip = require('adm-zip');
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
  return compact(String(value || '').replace(/\.(srt|vtt|ass|ssa|sub|txt|zip|rar|mkv|mp4|avi|mov|webm)$/i, ''));
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
    'subtitle', 'subtitles', 'english', 'arabic', 'hebrew'
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
  const s2 = String(s).padStart(2, '0');
  const e2 = String(e).padStart(2, '0');

  return [
    compactCode,
    `s${s2} e${e2}`,
    `${s}x${e2}`,
    `${s}x${e}`,
    `season ${s} episode ${e}`,
    `season ${s2} episode ${e2}`,
  ];
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

function redactUrl(url) {
  return String(url || '').replace(/([?&]api_key=)[^&]+/i, '$1***');
}

function safeSourceIdFromUrl(url) {
  const redacted = redactUrl(url);
  return `url-${shortHash(redacted)}`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getItemUrl(item) {
  return normalizeSubtitleUrl(firstString(item.url, item.subtitle_url, item.download_url, item.file, item.path, item.link));
}

function getItemLanguage(item) {
  return String(item.lang || item.language || item.language_name || '').trim();
}

function getItemId(item) {
  const explicitId = item.file_id || item.file_n_id || item.n_id || item.sd_id || item.id || item.md5;
  if (explicitId) return String(explicitId);

  const url = getItemUrl(item);
  if (url) return safeSourceIdFromUrl(url);

  return `item-${shortHash(item)}`;
}

function unpackFileArrays(item = {}) {
  return [
    item.unpack_files,
    item.unpacked_files,
    item.files,
    item.file_list,
    item.subtitles,
  ].filter(Array.isArray);
}

function unpackFileName(file = {}) {
  return firstString(
    file.name,
    file.file_name,
    file.filename,
    file.release_name,
    file.subtitle_name,
    file.path,
    file.entry,
    file.entry_name
  );
}

function unpackFileUrl(file = {}) {
  return normalizeSubtitleUrl(firstString(file.url, file.subtitle_url, file.download_url, file.file, file.path, file.link));
}

function unpackFileLanguage(file = {}) {
  return String(file.lang || file.language || file.language_name || '').trim();
}

function unpackFiles(item = {}) {
  return unpackFileArrays(item)
    .flat()
    .filter((file) => file && typeof file === 'object')
    .map((file) => ({
      raw: file,
      name: unpackFileName(file),
      url: unpackFileUrl(file),
      language: unpackFileLanguage(file),
    }))
    .filter((file) => file.name || file.url);
}

function itemSearchFields(item) {
  const unpacked = unpackFiles(item).flatMap((file) => [file.name, file.url, file.language]);

  return [
    item.release_name,
    item.name,
    item.filename,
    item.file_name,
    item.subtitle_name,
    item.url,
    item.subtitle_url,
    item.download_url,
    item.path,
    ...unpacked,
  ].filter(Boolean);
}

function searchableText(item) {
  return normalizeTitleToken(itemSearchFields(item).join(' '));
}

function hasEpisodeTitle(searchable, context = {}) {
  const episodeTokens = significantTokens(context.episodeTitle);
  return episodeTokens.length ? containsAllTokens(searchable, episodeTokens) : false;
}

function hasEpisodeCode(searchable, context = {}) {
  return hasSeasonEpisode(searchable, context.season, context.episode) ||
    hasSeasonEpisode(searchable, context.filenameSeason, context.filenameEpisode);
}

function hasShowTitle(searchable, context = {}) {
  const showTokens = significantTokens(context.showTitle);
  return showTokens.length ? containsAllTokens(searchable, showTokens) : true;
}

function isExactEpisodeStrategy(label) {
  return label.startsWith('episode-imdb');
}

function isSeriesLevelStrategy(label) {
  return label === 'imdb-tt' || label === 'imdb-numeric' || label === 'tmdb-tv';
}

function isSafeCandidate(item, context = {}) {
  const label = context.strategyLabel || '';
  const searchable = searchableText(item);

  if (isExactEpisodeStrategy(label)) return true;

  if (!hasShowTitle(searchable, context)) return false;

  if (isSeriesLevelStrategy(label) && (context.season != null || context.filenameSeason != null)) {
    return hasEpisodeCode(searchable, context);
  }

  if (context.season != null || context.filenameSeason != null || context.episodeTitle) {
    return hasEpisodeCode(searchable, context) || hasEpisodeTitle(searchable, context);
  }

  return true;
}

function scoreCandidate(item, context = {}) {
  const searchable = searchableText(item);
  let score = 0;

  const lang = getItemLanguage(item).toLowerCase();
  if (context.preferredLanguage && lang.includes(String(context.preferredLanguage).toLowerCase())) score += 100000;
  if (hasEpisodeCode(searchable, context)) score += 60000;
  if (context.showTitle && containsAllTokens(searchable, significantTokens(context.showTitle))) score += 30000;
  if (hasEpisodeTitle(searchable, context)) score += 25000;
  if (getItemUrl(item) && !/\.(zip|rar)(\?|$)/i.test(getItemUrl(item))) score += 5000;

  return score;
}

function findBestUnpackedFile(item, context = {}) {
  const candidates = unpackFiles(item)
    .map((file) => {
      const searchable = normalizeTitleToken([file.name, file.url].filter(Boolean).join(' '));
      let score = 0;

      if (/\.srt(\?|$)/i.test(file.name || file.url || '')) score += 100;
      if (/\.vtt(\?|$)/i.test(file.name || file.url || '')) score += 75;
      if (hasEpisodeCode(searchable, context)) score += 100000;
      if (hasEpisodeTitle(searchable, context)) score += 25000;
      if (context.showTitle && containsAllTokens(searchable, significantTokens(context.showTitle))) score += 10000;

      return { ...file, searchable, score };
    })
    .filter((file) => file.score > 0 || !context.season);

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score || String(a.name || '').localeCompare(String(b.name || '')));
  const best = candidates[0];

  if ((context.season != null || context.filenameSeason != null) && !hasEpisodeCode(best.searchable, context)) {
    return null;
  }

  return best;
}

function bestSubtitleFromResults(results, context = {}) {
  const safe = results.filter((item) => isSafeCandidate(item, context) && getItemUrl(item));
  if (!safe.length) {
    logger.warn(`SubDL ${context.strategyLabel || 'unknown'} returned ${results.length} result(s), but none matched safely.`);
    return null;
  }

  const best = [...safe].sort((a, b) => scoreCandidate(b, context) - scoreCandidate(a, context))[0];
  const parentUrl = getItemUrl(best);
  const unpacked = findBestUnpackedFile(best, context);
  const selectedUrl = unpacked && unpacked.url ? unpacked.url : parentUrl;
  const selectedName = unpacked && unpacked.name ? unpacked.name : null;
  const selectedLanguage = unpacked && unpacked.language ? unpacked.language : getItemLanguage(best);
  const id = unpacked && (unpacked.name || unpacked.url)
    ? `${getItemId(best)}:${shortHash(unpacked.name || unpacked.url)}`
    : getItemId(best);

  return {
    provider: 'subdl',
    fileId: id,
    subtitleId: id,
    language: selectedLanguage || 'unknown',
    releaseName: selectedName || best.release_name || best.name || best.filename || best.file_name || redactUrl(parentUrl),
    url: selectedUrl,
    archiveUrl: parentUrl,
    archiveEntryName: selectedName,
    season: context.season,
    episode: context.episode,
    filenameSeason: context.filenameSeason,
    filenameEpisode: context.filenameEpisode,
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
        logger.info(
          `SubDL selected subtitle via ${strategy.label}: id=${result.fileId} ` +
          `release=${result.releaseName || 'unknown'} language=${result.language}`
        );
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

function bufferToUtf8(buffer) {
  return Buffer.from(buffer).toString('utf8');
}

function chooseSubtitleEntry(entries, sourceSubtitle = {}) {
  const subtitleEntries = entries.filter((entry) => !entry.isDirectory && /\.(srt|vtt)$/i.test(entry.entryName));

  if (!subtitleEntries.length) {
    throw new Error('SubDL ZIP did not contain an SRT/VTT file');
  }

  if (sourceSubtitle.archiveEntryName) {
    const wanted = normalizeTitleToken(sourceSubtitle.archiveEntryName);
    const exact = subtitleEntries.find((entry) => normalizeTitleToken(entry.entryName).includes(wanted));
    if (exact) {
      logger.info(`Selected requested subtitle file from SubDL ZIP: ${exact.entryName}`);
      return exact;
    }
  }

  const targetSeason = sourceSubtitle.filenameSeason || sourceSubtitle.season;
  const targetEpisode = sourceSubtitle.filenameEpisode || sourceSubtitle.episode;

  const scored = subtitleEntries.map((entry) => {
    const searchable = normalizeTitleToken(entry.entryName);
    let score = /\.srt$/i.test(entry.entryName) ? 100 : 50;

    if (hasSeasonEpisode(searchable, targetSeason, targetEpisode)) score += 10000;
    if (sourceSubtitle.releaseName && normalizeTitleToken(sourceSubtitle.releaseName) && searchable.includes(normalizeTitleToken(stripExtension(sourceSubtitle.releaseName)))) {
      score += 500;
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score || a.entry.entryName.localeCompare(b.entry.entryName));

  const best = scored[0];
  const bestSearchable = normalizeTitleToken(best.entry.entryName);
  const hasTargetEpisode = hasSeasonEpisode(bestSearchable, targetSeason, targetEpisode);

  if (targetSeason != null && targetEpisode != null && subtitleEntries.length > 1 && !hasTargetEpisode) {
    throw new Error(`SubDL ZIP contained ${subtitleEntries.length} subtitle files but none matched requested episode ${seasonEpisodeCode(targetSeason, targetEpisode)}`);
  }

  logger.info(`Selected subtitle file from SubDL ZIP: ${best.entry.entryName}`);
  return best.entry;
}

function extractSubtitleFromZip(buffer, sourceSubtitle = {}) {
  const zip = new AdmZip(buffer);
  const entry = chooseSubtitleEntry(zip.getEntries(), sourceSubtitle);
  return bufferToUtf8(entry.getData());
}

async function downloadSubtitleContent(sourceSubtitle) {
  const url = sourceSubtitle && (sourceSubtitle.url || sourceSubtitle.archiveUrl);
  if (!url) throw new Error('SubDL source subtitle is missing url');

  logger.info(`Downloading SubDL subtitle: ${redactUrl(url)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SubDL subtitle download failed: HTTP ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (/\.(zip)(\?|$)/i.test(url)) {
    return extractSubtitleFromZip(buffer, sourceSubtitle);
  }

  return bufferToUtf8(buffer);
}

module.exports = {
  findSubtitle,
  findEnglishSubtitle,
  downloadSubtitleContent,
};
