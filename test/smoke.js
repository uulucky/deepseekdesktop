'use strict';
// Legacy entry point now runs the isolated integration suite. No implicit localhost:3080.
if (process.argv.length > 2) throw new Error('External URLs and paid prompts are no longer accepted; use npm run test:integration');
require('./integration');
