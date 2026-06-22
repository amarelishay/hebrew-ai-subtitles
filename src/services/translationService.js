'use strict';

// Talks to OpenAI to translate subtitle text to Hebrew. Only ever sends and
// receives { id, text } pairs - never timestamps, never SRT/VTT formatting.
// The model's output is treated as untrusted text and is strictly validated
// before it is allowed anywhere near a cache file.

const OpenAI = require('openai');
const logger = require('../utils/logger');

const SYSTEM_PROMPT =
  'You are a professional subtitle translator. Translate subtitle text to ' +
  'natural Hebrew. Return valid JSON only. Preserve the id values exactly. ' +
  'Do not include timestamps, numbering, markdown, explanations, or extra fields.';

// Chunk target sits inside the required 30-80 range. The final chunk of a
// file may be smaller than 30 - that's just a remainder, not a violation.
const CHUNK_SIZE = 60;
const MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries per chunk

let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return client;
}

function chunkBlocks(blocks, size = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size));
  }
  return chunks;
}

function buildUserPrompt(payload) {
  return [
    'Target language: Hebrew (he).',
    'Translate the "text" field of every item below into natural, fluent Hebrew.',
    'Preserve names, jokes, context, and tone as much as possible.',
    'Do not summarize. Do not censor. Do not add explanations.',
    'Preserve the "id" values exactly as given. Do not add, remove, or reorder ids.',
    'Do not return timestamps, numbering, or SRT/VTT formatting.',
    'Return a JSON array only, with this exact shape: [{ "id": number, "text": string }].',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonArraySubstring(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

// Strips code fences if present, parses JSON, and falls back to extracting
// the first [...] substring if the model wrapped the array in prose.
function parseModelResponse(raw) {
  const cleaned = stripCodeFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const extracted = extractJsonArraySubstring(cleaned);
    if (!extracted) {
      throw new Error(`Model response was not valid JSON: ${err.message}`);
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (err2) {
      throw new Error(`Model response was not valid JSON after extraction: ${err2.message}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Model response JSON is not an array');
  }
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Model response contains a non-object item');
    }
    if (typeof item.id !== 'number') {
      throw new Error('Model response item is missing a numeric id');
    }
    if (typeof item.text !== 'string') {
      throw new Error('Model response item is missing a string text field');
    }
  }
  return parsed;
}

// Validates that the model preserved the id set exactly and didn't blank
// out text that originally had content.
function validateChunkResult(inputChunk, outputItems) {
  const inputIds = new Set(inputChunk.map((b) => b.id));
  const outputIds = new Set(outputItems.map((i) => i.id));

  for (const id of inputIds) {
    if (!outputIds.has(id)) {
      throw new Error(`Missing id ${id} in translation output`);
    }
  }
  for (const id of outputIds) {
    if (!inputIds.has(id)) {
      throw new Error(`Unexpected extra id ${id} in translation output`);
    }
  }

  const inputById = new Map(inputChunk.map((b) => [b.id, b]));
  for (const item of outputItems) {
    const original = inputById.get(item.id);
    const originalEmpty = !original.text || original.text.trim().length === 0;
    const translatedEmpty = !item.text || item.text.trim().length === 0;
    if (translatedEmpty && !originalEmpty) {
      throw new Error(`Translated text for id ${item.id} is empty but the original was not`);
    }
  }
}

async function callModel(payload) {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const completion = await getClient().chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(payload) },
    ],
  });

  const raw = completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content
    : null;

  if (!raw) {
    throw new Error('Empty response from OpenAI');
  }
  return raw;
}

async function translateChunkWithRetry(chunk, chunkIndex, totalChunks, subtitleKey) {
  const payload = chunk.map((b) => ({ id: b.id, text: b.text }));

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const raw = await callModel(payload);
      const items = parseModelResponse(raw);
      validateChunkResult(chunk, items);
      logger.info(
        `Chunk ${chunkIndex}/${totalChunks} translated for ${subtitleKey || 'unknown'} (attempt ${attempt})`
      );
      return items;
    } catch (err) {
      lastError = err;
      logger.warn(
        `Validation failed for chunk ${chunkIndex}/${totalChunks} of ${subtitleKey || 'unknown'} ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`
      );
    }
  }

  throw new Error(
    `Chunk ${chunkIndex}/${totalChunks} failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`
  );
}

// blocks: [{ id, startMs, endMs, text }] -> Map<id, translatedText>
// Only { id, text } ever leaves this process toward OpenAI; timestamps stay local.
async function translateSubtitleBlocks(blocks, { subtitleKey } = {}) {
  const chunks = chunkBlocks(blocks);
  logger.info(
    `Translating ${blocks.length} block(s) in ${chunks.length} chunk(s) for ${subtitleKey || 'unknown'}`
  );

  const resultMap = new Map();
  for (let i = 0; i < chunks.length; i += 1) {
    const items = await translateChunkWithRetry(chunks[i], i + 1, chunks.length, subtitleKey);
    for (const item of items) {
      resultMap.set(item.id, item.text);
    }
  }

  return resultMap;
}

module.exports = { translateSubtitleBlocks };
