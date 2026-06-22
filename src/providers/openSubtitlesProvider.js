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

function scoreResult(item) {
  const attrs = item.attributes || {};
  return (attrs.from_trusted ? 1000000 : 0) + (attrs.download_count || 0);
}

// Searches OpenSubtitles for an English subtitle for the given title.
// Returns { provider, fileId, subtitleId, language, releaseName } or null
// if nothing is found.
async function findEnglishSubtitle({ imdbId, season, episode, type }) {
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

  const headers = await authHeaders();
  delete headers['Content-Type']; // GET request, no body to describe

  logger.info(`Searching OpenSubtitles: ${params.toString()}`);
  const res = await fetch(`${BASE_URL}/subtitles?${params.toString()}`, { headers });
  const json = await parseJsonResponse(res, 'OpenSubtitles search');

  const results = Array.isArray(json.data) ? json.data : [];
  if (results.length === 0) {
    return null;
  }

  // Secondary sort by id keeps the pick deterministic across requests when
  // scores tie, so the resulting cache key stays stable.
  const sorted = [...results].sort(
    (a, b) => scoreResult(b) - scoreResult(a) || String(a.id).localeCompare(String(b.id))
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
