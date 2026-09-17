'use strict';
/**
 * Tiny persisted key/value store for app state that must survive restarts:
 * window bounds, catalog snapshot, platform session metadata, UI preferences.
 * One JSON file per store, written atomically, read lazily and cached in memory.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DIRS, readJsonSync, writeJsonSync, log } = require('./util');

const cache = new Map();

class Store {
  /** @param {string} name file stem under the config directory */
  constructor(name) {
    this.file = path.join(DIRS.config, `${name}.json`);
    this.data = cache.get(this.file) ?? readJsonSync(this.file, {}) ?? {};
    cache.set(this.file, this.data);
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  all() {
    return { ...this.data };
  }

  set(key, value) {
    this.data[key] = value;
    this.flush();
    return value;
  }

  merge(patch) {
    Object.assign(this.data, patch);
    this.flush();
    return this.data;
  }

  delete(key) {
    delete this.data[key];
    this.flush();
  }

  flush() {
    try {
      writeJsonSync(this.file, this.data);
    } catch (error) {
      log('store', 'flush failed', { file: this.file, error: String(error) });
    }
  }
}

/** True when the given store file exists on disk. */
function storeExists(name) {
  return fs.existsSync(path.join(DIRS.config, `${name}.json`));
}

module.exports = { Store, storeExists };
