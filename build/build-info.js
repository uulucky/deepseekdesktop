'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const pins = require('./runtime-pins.json');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const commit = process.env.GITHUB_SHA || execFileSync('git',['rev-parse','HEAD'],{ cwd: root, encoding: 'utf8' }).trim();
const info = {
  product: 'DeepSeek Desktop', version: pkg.version, sourceCommit: commit,
  sourceRepository: 'https://github.com/uulucky/deepseekdesktop',
  workflow: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  builtAt: new Date().toISOString(), node: pins.nodeVersion, harness: pins.kernelVersion,
  electron: pkg.devDependencies.electron, authenticode: 'unsigned',
  locks: { application: hash('package-lock.json'), harness: hash('build/kernel/package-lock.json') },
};
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/build-info.json'),JSON.stringify(info,null,2)+'\n');
const packages = [];
for (const [scope,file] of [['application','package-lock.json'],['harness','build/kernel/package-lock.json']]) {
  const lock = JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  for (const [location,value] of Object.entries(lock.packages)) {
    if (!location || value.dev) continue;
    const name = location.split('node_modules/').at(-1);
    packages.push({ type: 'library', name, version: value.version,
      'bom-ref': scope+':'+location, purl: 'pkg:npm/'+name.replace('@','%40')+'@'+value.version,
      properties: [{name:'npm:integrity',value:value.integrity || ''},{name:'npm:license',value:typeof value.license === 'string' ? value.license : 'See upstream notices'}] });
  }
}
packages.push({type:'application', name:'Electron',version:info.electron},{type:'application', name:'Node.js',version:info.node.slice(1)});
fs.writeFileSync(path.join(root,'dist/sbom.cdx.json'),JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.6',version:1,metadata:{component:{type:'application',name:pkg.name,version:pkg.version}},components:packages},null,2)+'\n');
console.log('Build metadata and production dependency inventory generated:', commit);
