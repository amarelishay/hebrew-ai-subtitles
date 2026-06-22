'use strict';

// Deterministic WebVTT writer. Pure function, no I/O, no LLM involvement -
// timestamps come straight from the parsed source blocks and are only
// reformatted (SRT comma -> VTT dot), never recomputed or guessed.

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function msToVttTime(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const msPart = totalMs % 1000;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(msPart)}`;
}

// blocks: [{ id, startMs, endMs, text }] -> WebVTT file content (string).
function buildVtt(blocks) {
  const lines = ['WEBVTT', ''];
  for (const block of blocks) {
    lines.push(String(block.id));
    lines.push(`${msToVttTime(block.startMs)} --> ${msToVttTime(block.endMs)}`);
    lines.push(block.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

// Builds a small single-cue VTT shown while a translation is processing or
// has failed (see public/placeholders for the static versions of these).
function buildPlaceholderVtt(message, durationSeconds = 10) {
  return buildVtt([{ id: 1, startMs: 0, endMs: durationSeconds * 1000, text: message }]);
}

module.exports = { msToVttTime, buildVtt, buildPlaceholderVtt };
