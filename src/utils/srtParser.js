'use strict';

// Deterministic SRT/VTT parser. Pure function, no I/O, no LLM involvement -
// timestamps and numbering are derived purely from the source file.

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function timeToMs(raw) {
  const match = TIME_RE.exec(String(raw).trim());
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  const msNormalized = ms.padEnd(3, '0').slice(0, 3);
  return (
    parseInt(hh, 10) * 3600000 +
    parseInt(mm, 10) * 60000 +
    parseInt(ss, 10) * 1000 +
    parseInt(msNormalized, 10)
  );
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripVttHeader(text) {
  // Allows this parser to also accept simple WebVTT input, not just SRT.
  // BOM is already stripped by stripBom() before this runs.
  return text.replace(/^WEBVTT[^\n]*\n/i, '');
}

function parseTimingLine(line) {
  const arrowIndex = line.indexOf('-->');
  if (arrowIndex === -1) return null;
  const startRaw = line.slice(0, arrowIndex).trim();
  const afterArrow = line.slice(arrowIndex + 3).trim();
  const endRaw = afterArrow.split(/\s+/)[0]; // drop trailing VTT cue settings
  const startMs = timeToMs(startRaw);
  const endMs = timeToMs(endRaw);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

function parseBlock(blockText) {
  const lines = blockText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return null;

  let timingLineIndex = 0;
  if (!lines[0].includes('-->')) {
    // Leading numeric SRT index or VTT cue identifier - source numbering is
    // never trusted, blocks are renumbered deterministically below instead.
    timingLineIndex = 1;
  }

  const timingLine = lines[timingLineIndex];
  if (!timingLine || !timingLine.includes('-->')) return null;

  const timing = parseTimingLine(timingLine);
  if (!timing) return null;

  const text = lines.slice(timingLineIndex + 1).join('\n');
  return { startMs: timing.startMs, endMs: timing.endMs, text };
}

/**
 * Parses SRT (or simple WebVTT) content into structured blocks:
 * [{ id, startMs, endMs, text }]
 *
 * Blocks are sorted chronologically and renumbered 1..N. Source file
 * numbering is ignored on purpose since it can contain gaps or duplicates -
 * this keeps id assignment fully deterministic and safe to send to the LLM.
 * Malformed cues are skipped rather than throwing, so one bad cue in a
 * subtitle file doesn't fail the whole parse.
 */
function parseSrt(content) {
  if (!content || !content.trim()) return [];

  const normalized = stripVttHeader(normalizeNewlines(stripBom(content))).trim();
  const rawBlocks = normalized.split(/\n\s*\n/);

  const parsed = [];
  for (const rawBlock of rawBlocks) {
    const block = parseBlock(rawBlock);
    if (block) parsed.push(block);
  }

  parsed.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return parsed.map((block, index) => ({
    id: index + 1,
    startMs: block.startMs,
    endMs: block.endMs,
    text: block.text,
  }));
}

module.exports = { parseSrt, timeToMs };
