(function () {
  const STORAGE_KEY = 'maclick_tasks';

  async function readTasks() {
    const result = await browser.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] || [];
  }

  async function writeTasks(tasks) {
    await browser.storage.local.set({ [STORAGE_KEY]: tasks });
  }

  globalThis.TASK_DEFAULT_TIMEOUT = 300;

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
})();
