'use strict';

const crypto = require('crypto');

// Deterministic short hash used to fold a variable-length source id into a
// fixed, filesystem-safe token.
function shortHash(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function sanitizeForFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
}

// Builds a stable cache key for a translated subtitle. Same inputs must
// always produce the same key so cache hits work across server restarts.
// Shape: <imdbId>-<season/episode|movie>-<lang>-<provider>-<hash of sourceId>
function buildSubtitleKey({ imdbId, season, episode, lang, provider, sourceId }) {
  const imdbPart = sanitizeForFilename(imdbId || 'unknown');

  let episodePart = 'movie';
  if (season !== undefined && season !== null && episode !== undefined && episode !== null) {
    const seasonNum = String(season).padStart(2, '0');
    const episodeNum = String(episode).padStart(2, '0');
    episodePart = `s${seasonNum}e${episodeNum}`;
  }

  const langPart = sanitizeForFilename(lang || 'he');
  const providerPart = sanitizeForFilename(provider || 'unknown');
  const sourcePart = shortHash(sourceId !== undefined && sourceId !== null ? sourceId : '');

  return [imdbPart, episodePart, langPart, providerPart, sourcePart].join('-');
}

module.exports = { shortHash, buildSubtitleKey };
