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

  assert.strictEqual(typeof context.pickLastTask, 'function', 'pickLastTask exported');
  assert.strictEqual(context.pickLastTask([]), null, 'empty list has no last task');
  assert.strictEqual(context.pickLastTask(null), null, 'non-array list has no last task');
  assert.strictEqual(context.pickLastTask([{ id: 'a' }, { id: 'b', lastActiveAt: NaN }]), null, 'tasks without a valid date are ignored');
  assert.strictEqual(context.pickLastTask([{ id: 'a', lastActiveAt: '5' }, { id: 'b', lastActiveAt: null }]), null, 'non-numeric dates are ignored');

  const older = { id: 'old', lastActiveAt: 1 };
  const newer = { id: 'new', lastActiveAt: 2 };
  assert.strictEqual(context.pickLastTask([older, newer]), newer, 'newest activity selected');
  assert.strictEqual(context.pickLastTask([newer, older]), newer, 'selection does not depend on order');

  const legacyUsed = { id: 'used', lastUsedAt: 5 };
  const legacyCreated = { id: 'created', createdAt: 6 };
  assert.strictEqual(context.pickLastTask([legacyUsed, legacyCreated]), legacyCreated, 'legacy used and created dates are compared');
  assert.strictEqual(context.pickLastTask([{ id: 'created', createdAt: 10 }, { id: 'active', createdAt: 1, lastActiveAt: 11 }]).id, 'active', 'lastActiveAt wins');
  assert.strictEqual(context.taskActivityAt({ createdAt: 1, lastUsedAt: 2, lastActiveAt: 3 }), 3, 'taskActivityAt picks the latest date');
  assert.ok(Number.isNaN(context.taskActivityAt({})), 'taskActivityAt ignores missing dates');

  console.log('storage prefs tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
