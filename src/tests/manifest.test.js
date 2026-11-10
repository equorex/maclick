const fs = require('fs');
const path = require('path');
const assert = require('assert');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

assert.strictEqual(manifest.manifest_version, 3, 'manifest v3');
assert.ok(Array.isArray(manifest.host_permissions), 'host_permissions declared');
assert.ok(manifest.host_permissions.includes('<all_urls>'), 'requests access to all sites');
assert.ok(Array.isArray(manifest.permissions), 'permissions declared');
assert.ok(manifest.permissions.includes('activeTab'), 'activeTab kept as fallback');
assert.ok(manifest.permissions.includes('scripting'), 'scripting permission present');

assert.ok(Array.isArray(manifest.background.scripts), 'background scripts declared');
assert.ok(manifest.background.scripts.includes('js/executor.js'), 'executor available to background');
assert.ok(
  manifest.background.scripts.indexOf('js/storage.js') < manifest.background.scripts.indexOf('js/executor.js'),
  'storage loads before executor'
);
assert.ok(
  manifest.background.scripts.indexOf('js/executor.js') < manifest.background.scripts.indexOf('js/background.js'),
  'executor loads before background'
);

console.log('manifest tests passed');
