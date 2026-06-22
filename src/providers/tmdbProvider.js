'use strict';

// TMDB metadata helper.
// Used only to resolve better metadata for subtitle search: TMDB tv id,
// episode title, and per-episode IMDb id when available.

const logger = require('../utils/logger');

const BASE_URL = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map();

function getApiKey() {
  return process.env.TMDB_API_KEY || process.env.THEMOVIEDB_API_KEY || '';
}

function isEnabled() {
  return Boolean(getApiKey());
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, createdAt: Date.now() });
}

async function tmdbGet(path, params = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', params.language || 'en-US');

  for (const [key, value] of Object.entries(params)) {
    if (value != null && key !== 'language') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url);
  const text = await res.text();

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`TMDB invalid JSON response for ${path}: ${err.message}`);
  }

  if (!res.ok) {
    const message = json.status_message || `HTTP ${res.status}`;
    throw new Error(`TMDB request failed for ${path}: ${message}`);
  }

  return json;
}

async function findTvByImdbId(imdbId) {
  if (!imdbId || !isEnabled()) return null;

  const key = `find-tv:${imdbId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const numericOrTt = String(imdbId).startsWith('tt') ? imdbId : `tt${imdbId}`;
  const json = await tmdbGet(`/find/${encodeURIComponent(numericOrTt)}`, {
    external_source: 'imdb_id',
  });

  const tv = json && Array.isArray(json.tv_results) && json.tv_results.length
    ? json.tv_results[0]
    : null;

  const result = tv ? {
    tmdbTvId: tv.id,
    showTitle: tv.name || tv.original_name || null,
    originalShowTitle: tv.original_name || null,
  } : null;

  cacheSet(key, result);
  return result;
}

async function getEpisodeMetadata({ imdbId, season, episode }) {
  if (!isEnabled() || !imdbId || season == null || episode == null) return null;

  const key = `episode:${imdbId}:${season}:${episode}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  try {
    const tv = await findTvByImdbId(imdbId);
    if (!tv || !tv.tmdbTvId) {
      logger.info(`TMDB could not resolve tv id for imdb=${imdbId}`);
      cacheSet(key, null);
      return null;
    }

    const episodeJson = await tmdbGet(
      `/tv/${encodeURIComponent(tv.tmdbTvId)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode)}`,
      { append_to_response: 'external_ids' }
    );

    const result = {
      tmdbTvId: tv.tmdbTvId,
      showTitle: tv.showTitle,
      originalShowTitle: tv.originalShowTitle,
      episodeTitle: episodeJson.name || null,
      overview: episodeJson.overview || null,
      airDate: episodeJson.air_date || null,
      episodeImdbId: episodeJson.external_ids && episodeJson.external_ids.imdb_id
        ? episodeJson.external_ids.imdb_id
        : null,
    };

    logger.info(`TMDB episode metadata: ${JSON.stringify({
      imdbId,
      season,
      episode,
      tmdbTvId: result.tmdbTvId,
      showTitle: result.showTitle,
      episodeTitle: result.episodeTitle,
      episodeImdbId: result.episodeImdbId,
    })}`);

    cacheSet(key, result);
    return result;
  } catch (err) {
    logger.warn(`TMDB metadata lookup failed for imdb=${imdbId} season=${season} episode=${episode}: ${err.message}`);
    cacheSet(key, null);
    return null;
  }
}

module.exports = { getEpisodeMetadata, isEnabled };
