'use strict';
const path = require('node:path');
const os = require('node:os');

// Public package identity reserved in Partner Center.
const STORE_FAMILY = '11C53232.deepseek_r49aafgg8wnqa';
const STORE_PRODUCT_ID = '9NMC44LMCNH1';
const STORE_APP_ID = `${STORE_FAMILY}!DeepSeekDesktop`;
const STORE_UPDATES_URL = 'ms-windows-store://downloadsandupdates';

function isStoreBuild() {
  return process.platform === 'win32' && process.windowsStore === true;
}

function storeDataDir() {
  if (!isStoreBuild()) return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Packages', STORE_FAMILY, 'LocalState', 'DeepSeek Desktop');
}

module.exports = { isStoreBuild, storeDataDir, STORE_FAMILY, STORE_PRODUCT_ID, STORE_APP_ID, STORE_UPDATES_URL };
