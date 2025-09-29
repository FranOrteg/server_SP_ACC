// helpers/logger.js

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CUR = LEVELS[envLevel] ?? LEVELS.info;

function fmt(ns, lvl, args) {
  const ts = new Date().toISOString();
  return [`[${ts}] [${ns}] [${lvl.toUpperCase()}]`, ...args];
}

function mk(ns) {
  return {
    debug: (...a) => { if (CUR <= LEVELS.debug) console.debug(...fmt(ns, 'debug', a)); },
    info:  (...a) => { if (CUR <= LEVELS.info ) console.log  (...fmt(ns, 'info' , a)); },
    warn:  (...a) => { if (CUR <= LEVELS.warn ) console.warn (...fmt(ns, 'warn' , a)); },
    error: (...a) => { if (CUR <= LEVELS.error) console.error(...fmt(ns, 'error', a)); },
  };
}

module.exports = { mk };
