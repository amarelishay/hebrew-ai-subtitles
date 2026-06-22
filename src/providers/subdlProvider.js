'use strict';

const logger = require('../utils/logger');

async function findEnglishSubtitle() {
  logger.warn('SUBDL_API_KEY is not set or SubDL provider is not implemented yet.');
  return null;
}

async function downloadSubtitleContent() {
  throw new Error('SubDL provider is not implemented yet.');
}

module.exports = { findEnglishSubtitle, downloadSubtitleContent };
