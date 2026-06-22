'use strict';

// File-system cache for the MVP: translated VTT files live under
// public/subtitles/, job status/metadata lives in data/jobs.json.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SUBTITLES_DIR = path.join(ROOT_DIR, 'public', 'subtitles');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SUBTITLES_DIR, { recursive: true });
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, '{}\n', 'utf8');
  }
}

ensureDirs();

function readJobsStore() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    logger.error(`Failed to read jobs store, treating as empty: ${err.message}`);
    return {};
  }
}

function writeJobsStore(jobs) {
  // Write-then-rename so a crash mid-write can never leave jobs.json truncated.
  const tmpFile = `${JOBS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(jobs, null, 2), 'utf8');
  fs.renameSync(tmpFile, JOBS_FILE);
}

// Funnels every mutation through one promise chain so concurrent
// setJobStatus() calls in the same process can't race on jobs.json.
let writeQueue = Promise.resolve();
function withJobsStore(mutate) {
  writeQueue = writeQueue.then(() => {
    const jobs = readJobsStore();
    const result = mutate(jobs);
    writeJobsStore(jobs);
    return result;
  });
  return writeQueue;
}

async function getJob(subtitleKey) {
  const jobs = readJobsStore();
  return jobs[subtitleKey] || null;
}

// status: 'processing' | 'ready' | 'failed'
async function setJobStatus(subtitleKey, status, extra = {}) {
  return withJobsStore((jobs) => {
    const now = new Date().toISOString();
    const existing = jobs[subtitleKey];
    jobs[subtitleKey] = {
      ...existing,
      ...extra,
      status,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };
    return jobs[subtitleKey];
  });
}

function vttFilePath(subtitleKey) {
  return path.join(SUBTITLES_DIR, `${subtitleKey}.vtt`);
}

function vttExists(subtitleKey) {
  return fs.existsSync(vttFilePath(subtitleKey));
}

async function saveVtt(subtitleKey, vttContent) {
  ensureDirs();
  fs.writeFileSync(vttFilePath(subtitleKey), vttContent, 'utf8');
  logger.info(`Saved translated VTT for ${subtitleKey}`);
}

function getBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 7000}`;
  return base.replace(/\/+$/, '');
}

function buildPublicUrl(subtitleKey) {
  return `${getBaseUrl()}/subtitles/${subtitleKey}.vtt`;
}

// kind: 'processing' | 'failed'
function placeholderUrl(kind) {
  return `${getBaseUrl()}/placeholders/${kind}.vtt`;
}

module.exports = {
  ensureDirs,
  getJob,
  setJobStatus,
  vttFilePath,
  vttExists,
  saveVtt,
  buildPublicUrl,
  placeholderUrl,
};
