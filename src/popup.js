let isRecording = false;
let currentEditingTaskId = null;
let editingSteps = [];
let statusTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  const recordBtn = document.getElementById('record-btn');
  const createForm = document.getElementById('create-task-form');
  const cancelCreateBtn = document.getElementById('cancel-create-btn');

  if (recordBtn) recordBtn.addEventListener('click', toggleRecord);
  if (createForm) createForm.addEventListener('submit', handleEditTask);
  if (cancelCreateBtn) cancelCreateBtn.addEventListener('click', hideCreateForm);

  const addStepBtn = document.getElementById('add-step-btn');
  if (addStepBtn) addStepBtn.addEventListener('click', addStep);

  checkRecordingState();
  renderTaskList();
});

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('status-message');
  if (!el) {
    console.log(`[${type}] ${message}`);
    return;
  }

  el.textContent = message;
  el.className = `status-message visible ${type}`;

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.className = 'status-message';
  }, 4000);
}

function updateRecordUi() {
  const indicator = document.getElementById('indicator');
  if (indicator) indicator.classList.toggle('recording', isRecording);

  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) recordBtn.textContent = isRecording ? '⏹ Stop' : 'Record';
}

function closePopup() {
  window.close();
}

async function checkRecordingState() {
  try {
    const tab = await getActiveTab();
    if (!tab) return;

    const state = await browser.runtime.sendMessage({ type: 'GET_RECORDING_STATE', tabId: tab.id });
    if (state && state.recording) {
      isRecording = true;
      updateRecordUi();
    }
  } catch (e) {
    console.error('Failed to check recording state:', e);
  }
}

async function toggleRecord() {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      showStatus('No active tab found', 'error');
      return;
    }

    if (!isRecording) {
      const result = await browser.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
      if (!result || result.status !== 'started') {
        showStatus('Failed to start recording: ' + ((result && result.error) || 'unknown error'), 'error');
        return;
      }

      isRecording = true;
      updateRecordUi();
      closePopup();
    } else {
      const result = await browser.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: tab.id });

      isRecording = false;
      updateRecordUi();

      if (result && result.task) {
        showStatus(`Task "${result.task.name}" saved`, 'success');
        renderTaskList();
      } else {
        showStatus('Recording is empty', 'info');
      }
    }
  } catch (e) {
    console.error(e);
    showStatus('Error: ' + e.message, 'error');
  }
}

function readDefaultTimeout() {
  const input = document.getElementById('task-timeout');
  const value = input ? parseInt(input.value, 10) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : TASK_DEFAULT_TIMEOUT;
}

function showEditForm() {
  document.getElementById('create-task-form').classList.add('visible');
}

function hideCreateForm() {
  document.getElementById('create-task-form').classList.remove('visible');

  currentEditingTaskId = null;
  editingSteps = [];
  renderSteps();
}

function renderSteps() {
  const container = document.getElementById('editStepsList');
  if (!container) return;

  container.textContent = '';
  editingSteps.forEach((step, idx) => {
    container.appendChild(createStepRow(step, idx));
  });
}

function createStepRow(step, idx) {
  const row = document.createElement('div');
  row.className = 'step-row';

  const number = document.createElement('span');
  number.className = 'step-number';
  number.textContent = `${idx + 1}.`;

  const label = document.createElement('span');
  label.className = 'step-label';

  row.appendChild(number);
  row.appendChild(createIconButton('↑', 'Move up', idx === 0, () => moveStep(idx, -1)));
  row.appendChild(createIconButton('↓', 'Move down', idx === editingSteps.length - 1, () => moveStep(idx, 1)));

  if (step.type === 'click' || step.type === 'wait_element') {
    label.textContent = step.type === 'click' ? 'Click:' : 'Wait + click:';
    row.appendChild(label);
    row.appendChild(createSelectorInput(step));

    if (step.type === 'wait_element') {
      row.appendChild(createTimeoutInput(step));
    }
  } else if (step.type === 'input_text') {
    label.textContent = 'Input text:';
    row.appendChild(label);
    row.appendChild(createSelectorInput(step));
    row.appendChild(createValueInput(step));
  } else if (step.type === 'wait_timeout') {
    label.textContent = 'Pause (ms):';
    row.appendChild(label);
    row.appendChild(createMsInput(step));
  } else if (step.type === 'wait_page_load') {
    label.textContent = 'Wait for load:';
    row.appendChild(label);
    row.appendChild(createTimeoutInput(step, PAGE_LOAD_DEFAULT_TIMEOUT));
  } else {
    label.textContent = `${step.type}:`;
    row.appendChild(label);
  }

  row.appendChild(createIconButton('✕', 'Remove step', false, () => removeStepAt(idx)));
  return row;
}

function createSelectorInput(step) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'step-input';
  input.placeholder = 'CSS selector';
  input.value = step.selector || '';
  input.addEventListener('input', () => {
    step.selector = input.value;
  });
  return input;
}

function createValueInput(step) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'step-input';
  input.placeholder = 'Text to enter';
  input.value = step.value || '';
  input.addEventListener('input', () => {
    step.value = input.value;
  });
  return input;
}

function createNumberInput(step, key, className, defaultValue) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.className = className;
  input.value = step[key] || defaultValue;
  input.addEventListener('input', () => {
    const value = parseInt(input.value, 10);
    step[key] = Number.isFinite(value) ? value : 0;
  });
  return input;
}

function createMsInput(step) {
  return createNumberInput(step, 'ms', 'step-input', 1000);
}

function createTimeoutInput(step, defaultValue = TASK_DEFAULT_TIMEOUT) {
  const input = createNumberInput(step, 'timeout', 'step-timeout', defaultValue);
  input.title = 'Timeout, ms';
  input.placeholder = 'ms';
  return input;
}

function createIconButton(text, title, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.textContent = text;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function moveStep(idx, delta) {
  const target = idx + delta;
  if (target < 0 || target >= editingSteps.length) return;

  [editingSteps[idx], editingSteps[target]] = [editingSteps[target], editingSteps[idx]];
  renderSteps();
}

function removeStepAt(idx) {
  editingSteps.splice(idx, 1);
  renderSteps();
}

function addStep() {
  const select = document.getElementById('step-type-select');
  const stepType = select ? select.value : 'click';
  const timeout = readDefaultTimeout();

  if (stepType === 'wait_timeout') {
    editingSteps.push({ type: 'wait_timeout', ms: 1000 });
  } else if (stepType === 'input_text') {
    editingSteps.push({ type: 'input_text', selector: '', value: '' });
  } else if (stepType === 'wait_page_load') {
    editingSteps.push({ type: 'wait_page_load', timeout: PAGE_LOAD_DEFAULT_TIMEOUT });
  } else if (stepType === 'wait_element') {
    editingSteps.push({ type: 'wait_element', selector: '', timeout });
  } else {
    editingSteps.push({ type: 'click', selector: '' });
  }

  renderSteps();
}

async function handleEditTask(e) {
  e.preventDefault();

  if (!currentEditingTaskId) return;

  const name = document.getElementById('task-name').value.trim();
  if (!name) {
    showStatus('Fill in the required fields', 'error');
    return;
  }

  const description = document.getElementById('task-desc').value;
  const defaultTimeout = readDefaultTimeout();
  const steps = editingSteps.map(step => ({ ...step }));

  const updated = await taskStorage.update(currentEditingTaskId, { name, description, defaultTimeout, steps });

  if (!updated) {
    showStatus('Task not found', 'error');
    hideCreateForm();
    return;
  }

  hideCreateForm();
  renderTaskList();
  showStatus('Task saved', 'success');
}

async function renderTaskList() {
  const list = document.getElementById('task-list');
  const tasks = await taskStorage.getAll();

  list.textContent = '';

  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = 'No saved tasks';
    list.appendChild(empty);
    return;
  }

  for (const task of [...tasks].reverse()) {
    list.appendChild(createTaskCard(task));
  }
}

function createTaskCard(task) {
  const item = document.createElement('div');
  item.className = 'task-card';

  const name = document.createElement('strong');
  name.textContent = task.name;
  item.appendChild(name);

  if (task.description) {
    const description = document.createElement('div');
    description.className = 'task-description';
    description.textContent = task.description;
    item.appendChild(description);
  }

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const date = new Date(task.createdAt || Date.now());
  meta.textContent = `${task.host || ''} • ${date.toLocaleString()}`;
  item.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  actions.appendChild(createTaskButton('▶ Run', 'btn-run', () => runTask(task.id)));
  actions.appendChild(createTaskButton('✎ Edit', 'btn-edit', () => editTask(task.id)));
  actions.appendChild(createTaskButton('🗑 Delete', 'btn-delete', () => deleteTask(task.id)));
  item.appendChild(actions);

  return item;
}

function createTaskButton(text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

async function runTask(taskId) {
  const tasks = await taskStorage.getAll();
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    showStatus('Task not found', 'error');
    return;
  }

  const tab = await getActiveTab();
  if (!tab) {
    showStatus('No active tab found', 'error');
    return;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: executeTask,
      args: [task]
    });

    showStatus(`Task "${task.name}" is running`, 'success');
  } catch (e) {
    console.error(e);
    showStatus('Run failed: ' + e.message, 'error');
  }
}

async function deleteTask(taskId) {
  await taskStorage.remove(taskId);
  hideCreateForm();
  renderTaskList();
}

async function editTask(taskId) {
  const tasks = await taskStorage.getAll();
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    showStatus('Task not found', 'error');
    return;
  }

  currentEditingTaskId = taskId;
  editingSteps = Array.isArray(task.steps) ? task.steps.map(step => ({ ...step })) : [];

  document.getElementById('task-name').value = task.name;
  document.getElementById('task-desc').value = task.description || '';
  document.getElementById('task-timeout').value = task.defaultTimeout || TASK_DEFAULT_TIMEOUT;

  showEditForm();
  renderSteps();
}
