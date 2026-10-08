const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

(async () => {
  const store = {};
  const browser = {
    storage: {
      local: {
        async get(keys) {
          const result = {};
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
          }
          return result;
        },
        async set(patch) {
          Object.assign(store, patch);
        }
      }
    }
  };

  const context = vm.createContext({ browser, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8'), context);

  assert.strictEqual(context.DOMAIN_FILTER_DEFAULT, 'domain', 'domain filter default constant exported');
  assert.strictEqual(await context.prefsStorage.getDomainFilter(), 'domain', 'defaults to current domain');

  assert.strictEqual(await context.prefsStorage.setDomainFilter('all'), 'all', 'set returns normalized value');
  assert.strictEqual(store.maclick_domain_filter, 'all', 'value persisted');
  assert.strictEqual(await context.prefsStorage.getDomainFilter(), 'all', 'value read back');

  assert.strictEqual(await context.prefsStorage.setDomainFilter('bogus'), 'domain', 'invalid value normalized');
  assert.strictEqual(store.maclick_domain_filter, 'domain', 'invalid value persisted as default');
  assert.strictEqual(await context.prefsStorage.getDomainFilter(), 'domain', 'invalid value falls back to default');

  console.log('storage prefs tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
