'use strict';

// Thin client for the OpenSubtitles REST API v1 (api.opensubtitles.com).
// Only searches for and downloads subtitle files that OpenSubtitles itself
// serves - no scraping, no torrents, no video of any kind.

const logger = require('../utils/logger');

const BASE_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'HebrewAISubtitles v0.1.0';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // OpenSubtitles JWTs last ~24h

let cachedToken = null;
let cachedTokenAt = 0;

function getApiKey() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) {
    throw new Error('OPENSUBTITLES_API_KEY is not set');
  }
  return key;
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
  if (!res.ok) {
    const message = (json && json.message) || `HTTP ${res.status}`;
    throw new Error(`${context}: ${message}`);
  }
  return json;
}

// Logs in only if credentials are configured, caching the JWT for
// TOKEN_TTL_MS. OpenSubtitles rate-limits /login, so on failure we fall
// back to anonymous Api-Key-only access instead of retrying aggressively.
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

function compact(value) {
  return String(value || '')
    .replace(/[_\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExtension(filename) {
  return compact(filename).replace(/\.[a-z0-9]{2,5}$/i, '').trim();
}

function normalizeTitleToken(value) {
  return compact(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFilenameParts(filename) {
  if (!filename) return {};

  const withoutExt = stripExtension(filename);
  const seasonEpisodeMatch = withoutExt.match(/\bS(\d{1,2})E(\d{1,3})\b/i);

  let showTitle = null;
  let episodeTitle = null;

  if (seasonEpisodeMatch) {
    const before = withoutExt.slice(0, seasonEpisodeMatch.index).replace(/[\s\-]+$/g, '').trim();
    const after = withoutExt.slice(seasonEpisodeMatch.index + seasonEpisodeMatch[0].length)
      .replace(/^[\s\-]+/g, '')
      .trim();

    showTitle = before || null;

    // Keep only the human episode title. Release/quality tags usually start
    // at a parenthesis or at common video metadata tokens.
    if (after) {
      episodeTitle = after
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(\d{3,4}p|x26[45]|h\.?26[45]|web[- ]?dl|webrip|bluray|aac|av1|edge\d*)\b.*$/i, ' ')
        .replace(/[\s\-]+$/g, '')
        .trim() || null;
    }
  }

  return {
    filename: withoutExt,
    showTitle,
    episodeTitle,
    filenameSeason: seasonEpisodeMatch ? parseInt(seasonEpisodeMatch[1], 10) : null,
    filenameEpisode: seasonEpisodeMatch ? parseInt(seasonEpisodeMatch[2], 10) : null,
  };
}

function scoreResult(item, context = {}) {
  const attrs = item.attributes || {};
  const release = normalizeTitleToken(attrs.release || attrs.feature_details?.title || '');
  const fileName = normalizeTitleToken((attrs.files && attrs.files[0] && attrs.files[0].file_name) || '');
  const searchable = `${release} ${fileName}`;

  let score = (attrs.from_trusted ? 1000000 : 0) + (attrs.download_count || 0);

  if (context.filename) {
    const wanted = normalizeTitleToken(context.filename);
    if (wanted && searchable.includes(wanted)) score += 50000;
  }

  if (context.episodeTitle) {
    const wantedEpisodeTitle = normalizeTitleToken(context.episodeTitle);
    if (wantedEpisodeTitle && searchable.includes(wantedEpisodeTitle)) score += 25000;
  }

  return score;
}

function bestSubtitleFromResults(results, context = {}) {
  if (!results.length) return null;

  // Secondary sort by id keeps the pick deterministic across requests when
  // scores tie, so the resulting cache key stays stable.
  const sorted = [...results].sort(
    (a, b) => scoreResult(b, context) - scoreResult(a, context) || String(a.id).localeCompare(String(b.id))
  );
  const best = sorted[0];
  const file = best.attributes && best.attributes.files && best.attributes.files[0];
  if (!file) {
    return null;
  }

  return {
    provider: 'opensubtitles',
    fileId: file.file_id,
    subtitleId: best.id,
    language: (best.attributes && best.attributes.language) || 'en',
    releaseName: (best.attributes && best.attributes.release) || file.file_name || '',
  };
}

async function searchOpenSubtitles(params, context = {}) {
  const headers = await authHeaders();
  delete headers['Content-Type']; // GET request, no body to describe

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
    // Stremio passes the show's imdb id for episodes, not a per-episode id.
    params.set('parent_imdb_id', numericImdbId);
    params.set('season_number', String(season));
    params.set('episode_number', String(episode));
  } else {
    params.set('imdb_id', numericImdbId);
  }

  return params;
}

function movieHashParams(extra = {}) {
  if (!extra.videoHash) return null;

  const params = new URLSearchParams({
    languages: 'en',
    moviehash: String(extra.videoHash),
  });

  // OpenSubtitles may use this together with moviehash when available.
  if (extra.videoSize) {
    params.set('moviebytesize', String(extra.videoSize));
  }

  return params;
}

function queryParams(query, { season, episode } = {}) {
  if (!query || !query.trim()) return null;

  const params = new URLSearchParams({
    languages: 'en',
    query: query.trim(),
  });

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

function buildSearchStrategies({ imdbId, season, episode, type, extra = {} }) {
  const filenameParts = extractFilenameParts(extra.filename);
  const strategies = [];

  addUniqueStrategy(strategies, 'exact-imdb', exactParams({ imdbId, season, episode, type }));
  addUniqueStrategy(strategies, 'video-hash', movieHashParams(extra));

  if (type === 'series' && season != null && episode != null) {
    // Some metadata providers and OpenSubtitles disagree on TV season numbering.
    // Try nearby seasons for the same episode as a controlled fallback.
    for (const offset of [-1, 1, -2, 2]) {
      const altSeason = season + offset;
      if (altSeason > 0) {
        addUniqueStrategy(
          strategies,
          `nearby-season-${altSeason}`,
          exactParams({ imdbId, season: altSeason, episode, type })
        );
      }
    }
  }

  if (filenameParts.filename) {
    addUniqueStrategy(strategies, 'filename-query', queryParams(filenameParts.filename, { season, episode }));
  }

  if (filenameParts.episodeTitle) {
    addUniqueStrategy(strategies, 'episode-title-query', queryParams(filenameParts.episodeTitle, { season, episode }));
  }

  if (filenameParts.showTitle && filenameParts.episodeTitle) {
    addUniqueStrategy(
      strategies,
      'show-plus-episode-title-query',
      queryParams(`${filenameParts.showTitle} ${filenameParts.episodeTitle}`)
    );
  }

  return { strategies, filenameParts };
}

// Searches OpenSubtitles for an English subtitle for the given title.
// Returns { provider, fileId, subtitleId, language, releaseName } or null
// if nothing is found.
async function findEnglishSubtitle({ imdbId, season, episode, type, extra = {} }) {
  const { strategies, filenameParts } = buildSearchStrategies({ imdbId, season, episode, type, extra });
  const context = {
    filename: filenameParts.filename,
    episodeTitle: filenameParts.episodeTitle,
  };

  for (const strategy of strategies) {
    logger.info(`OpenSubtitles strategy: ${strategy.label}`);
    const result = await searchOpenSubtitles(strategy.params, context);
    if (result) {
      logger.info(
        `OpenSubtitles selected subtitle via ${strategy.label}: file_id=${result.fileId} release=${result.releaseName || 'unknown'}`
      );
      return result;
    }
  }

  return null;
}

// Resolves a file_id to a temporary download link, then fetches the raw
// subtitle text content from that link.
async function downloadSubtitleContent(fileId) {
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

module.exports = { findEnglishSubtitle, downloadSubtitleContent };
