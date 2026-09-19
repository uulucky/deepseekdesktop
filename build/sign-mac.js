'use strict';
// electron-builder 25 does not implement the newer identity:"-" shortcut itself.
// Use its locked osx-sign dependency explicitly; no Developer ID/private key is used.
const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');
module.exports = async function sign(options) {
  await signAsync({
    app: options.app, platform: 'darwin', identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      hardenedRuntime: true, timestamp: 'none',
      entitlements: path.join(__dirname, 'entitlements.mac.plist'),
    }),
  });
  console.log('Ad-hoc signature verified (not Developer ID, not Apple notarized)');
};
