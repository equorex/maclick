(function () {
  const STORAGE_KEY = 'maclick_tasks';
  const DOMAIN_FILTER_KEY = 'maclick_domain_filter';
  const DOMAIN_FILTER_VALUES = ['domain', 'all'];
  const DOMAIN_FILTER_DEFAULT = 'domain';

  async function readTasks() {
    const result = await browser.storage.local.get([STORAGE_KEY]);
    const tasks = result[STORAGE_KEY];
    return Array.isArray(tasks) ? tasks : [];
  }

  async function writeTasks(tasks) {
    await browser.storage.local.set({ [STORAGE_KEY]: tasks });
  }

  globalThis.TASK_DEFAULT_TIMEOUT = 300;

  globalThis.taskActivityAt = function (task) {
    if (!task) return NaN;

    let best = NaN;
    for (const value of [task.lastActiveAt, task.lastUsedAt, task.createdAt]) {
      if (Number.isFinite(value) && (!Number.isFinite(best) || value > best)) best = value;
    }
    return best;
  };

  globalThis.pickLastTask = function (tasks) {
    if (!Array.isArray(tasks)) return null;

    let best = null;
    let bestAt = NaN;
    for (const task of tasks) {
      const activityAt = taskActivityAt(task);
      if (!Number.isFinite(activityAt)) continue;
      if (!best || activityAt > bestAt) {
        best = task;
        bestAt = activityAt;
      }
    }
    return best;
  };

  globalThis.taskStorage = {
    async getAll() {
      return readTasks();
    },

    async add(task) {
      const tasks = await readTasks();
      tasks.push(task);
      await writeTasks(tasks);
      return task;
    },

    async update(id, patch) {
      const tasks = await readTasks();
      const index = tasks.findIndex(task => task.id === id);

      if (index < 0) return null;

      tasks[index] = { ...tasks[index], ...patch };
      await writeTasks(tasks);
      return tasks[index];
    },

    async remove(id) {
      const tasks = await readTasks();
      const filtered = tasks.filter(task => task.id !== id);
      await writeTasks(filtered);
      return filtered;
    }
  };

  globalThis.prefsStorage = {
    async getDomainFilter() {
      const result = await browser.storage.local.get([DOMAIN_FILTER_KEY]);
      const value = result[DOMAIN_FILTER_KEY];
      return DOMAIN_FILTER_VALUES.includes(value) ? value : DOMAIN_FILTER_DEFAULT;
    },

    async setDomainFilter(value) {
      const normalized = DOMAIN_FILTER_VALUES.includes(value) ? value : DOMAIN_FILTER_DEFAULT;
      await browser.storage.local.set({ [DOMAIN_FILTER_KEY]: normalized });
      return normalized;
    }
  };

  globalThis.DOMAIN_FILTER_DEFAULT = DOMAIN_FILTER_DEFAULT;
})();
