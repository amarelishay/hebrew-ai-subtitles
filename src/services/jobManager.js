'use strict';

// Tracks and runs background translation jobs. The LLM never touches
// timestamps or block ids here - this module only merges translated text
// back into the original, already-parsed blocks.

const logger = require('../utils/logger');
const cacheManager = require('./cacheManager');
const translationService = require('./translationService');
const { buildVtt } = require('../utils/vttBuilder');

// In-memory guard against starting two jobs for the same key at once.
// Sufficient for a single-process MVP deployment.
const inFlight = new Set();

function isProcessing(subtitleKey) {
  return inFlight.has(subtitleKey);
}

// Starts a translation job in the background and returns immediately.
// Callers should already have decided no usable cache/job exists for this key.
async function startJob(subtitleKey, { blocks, meta }) {
  if (inFlight.has(subtitleKey)) {
    logger.info(`Job already in-flight for ${subtitleKey}, skipping duplicate start.`);
    return;
  }

  inFlight.add(subtitleKey);
  await cacheManager.setJobStatus(subtitleKey, 'processing', { meta, error: null });
  logger.info(`Job started for ${subtitleKey} (${blocks.length} blocks)`);

  runJob(subtitleKey, blocks, meta)
    .catch((err) => {
      logger.error(`Unhandled job error for ${subtitleKey}: ${err.message}`);
    })
    .finally(() => {
      inFlight.delete(subtitleKey);
    });
}

async function runJob(subtitleKey, blocks, meta) {
  try {
    const translatedById = await translationService.translateSubtitleBlocks(blocks, { subtitleKey });

    // Merge translated text back into the original blocks. Timestamps and
    // ids are taken from the source parse only - never from the LLM.
    const mergedBlocks = blocks.map((block) => ({
      id: block.id,
      startMs: block.startMs,
      endMs: block.endMs,
      text: translatedById.get(block.id),
    }));

    const vtt = buildVtt(mergedBlocks);
    await cacheManager.saveVtt(subtitleKey, vtt);
    await cacheManager.setJobStatus(subtitleKey, 'ready', { meta, error: null });
    logger.info(`Job ready for ${subtitleKey}`);
  } catch (err) {
    logger.error(`Job failed for ${subtitleKey}: ${err.message}`);
    await cacheManager.setJobStatus(subtitleKey, 'failed', { meta, error: err.message });
  }
}

module.exports = { startJob, isProcessing };
