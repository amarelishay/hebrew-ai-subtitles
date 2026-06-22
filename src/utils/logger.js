'use strict';

// Minimal structured console logger. Kept dependency-free on purpose.

function timestamp() {
  return new Date().toISOString();
}

function log(level, args) {
  const line = `[${timestamp()}] [${level}]`;
  if (level === 'ERROR') {
    console.error(line, ...args);
  } else if (level === 'WARN') {
    console.warn(line, ...args);
  } else {
    console.log(line, ...args);
  }
}

const logger = {
  info: (...args) => log('INFO', args),
  warn: (...args) => log('WARN', args),
  error: (...args) => log('ERROR', args),
  debug: (...args) => {
    if (process.env.DEBUG) log('DEBUG', args);
  },
};

module.exports = logger;
