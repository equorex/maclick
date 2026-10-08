let isRecording = false;
let currentEditingTaskId = null;
let editingSteps = [];
let statusTimer = null;
let domainFilter = DOMAIN_FILTER_DEFAULT;
let currentHost = '';
let dragSourceIndex = null;

const editorRefs = {
  form: null,
  name: null,
  desc: null,
  timeout: null,
  steps: null,
  typeSelect: null
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  play: 'M8 5v14l11-7z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  drag: 'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'
};

const STEP_TYPES = [
  ['click', 'Click'],
  ['input_text', 'Input text'],
  ['wait_element', 'Wait element then click'],
  ['wait_timeout', 'Timeout'],
  ['wait_page_load', 'Wait for load page']
];

const STEP_DEFAULTS = {
  click: () => ({ selector: '' }),
  input_text: () => ({ selector: '', value: '' }),
  wait_element: () => ({ selector: '', timeout: TASK_DEFAULT_TIMEOUT }),
  wait_timeout: () => ({ ms: 1000 }),
  wait_page_load: () => ({ timeout: PAGE_LOAD_DEFAULT_TIMEOUT })
};

function normalizeStep(type, source = {}) {
  const step = { type, ...STEP_DEFAULTS[type]() };

  if ('selector' in step && typeof source.selector === 'string') step.selector = source.selector;
  if ('value' in step && source.value != null) step.value = source.value;
  if ('timeout' in step && Number.isFinite(source.timeout)) step.timeout = source.timeout;
  if ('ms' in step && Number.isFinite(source.ms)) step.ms = source.ms;

  return step;
}

function createIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

document.addEventListener('DOMContentLoaded', () => {
  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) recordBtn.addEventListener('click', toggleRecord);

  const grantBtn = document.getElementById('grant-permission-btn');
  if (grantBtn) grantBtn.addEventListener('click', requestHostAccess);

  bindDomainFilter();
  init();
});

async function init() {
  try {
    domainFilter = await prefsStorage.getDomainFilter();
  } catch (e) {
    console.error('Failed to read domain filter:', e);
    domainFilter = DOMAIN_FILTER_DEFAULT;
  }

  currentHost = await getCurrentHost();
  updateDomainFilterUi();
  await updatePermissionBanner();

  await checkRecordingState();
  await renderTaskList();
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function getHostFromUrl(url) {
  if (!url) return '';

  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

async function getCurrentHost() {
  const tab = await getActiveTab();
  return tab ? getHostFromUrl(tab.url) : '';
}

const HOST_ORIGINS = ['<all_urls>'];

async function hasHostAccess() {
  if (!browser.permissions || typeof browser.permissions.contains !== 'function') return true;

  try {
    return await browser.permissions.contains({ origins: HOST_ORIGINS });
  } catch (e) {
    console.error('Failed to check host access:', e);
    return true;
  }
}

async function updatePermissionBanner() {
  const banner = document.getElementById('permission-banner');
  if (!banner) return;

  banner.hidden = await hasHostAccess();
}

async function requestHostAccess() {
  if (!browser.permissions || typeof browser.permissions.request !== 'function') return;

  try {
    const granted = await browser.permissions.request({ origins: HOST_ORIGINS });
    await updatePermissionBanner();

    if (granted) {
      showStatus('Site access granted', 'success');
    } else {
      showStatus('Site access is required to run tasks', 'error');
    }
  } catch (e) {
    console.error('Failed to request host access:', e);
    showStatus('Failed to request site access', 'error');
  }
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
  if (recordBtn) recordBtn.textContent = isRecording ? 'Stop' : 'Record';

  const hint = document.getElementById('record-hint');
  if (hint) hint.textContent = isRecording ? 'Recording…' : 'Idle';
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
      if (!getHostFromUrl(tab.url)) {
        showStatus('Cannot record on this page (technical domain)', 'error');
        return;
      }

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
      } else if (result && result.error === 'no_host') {
        showStatus('Cannot save a task for this page (technical domain)', 'error');
      } else {
        showStatus('Recording is empty', 'info');
      }
    }
  } catch (e) {
    console.error(e);
    showStatus('Error: ' + e.message, 'error');
  }
}

function bindDomainFilter() {
  const group = document.getElementById('domain-filter');
  if (!group || !group.children) return;

  for (const button of group.children) {
    if (!button.getAttribute || button.getAttribute('data-filter') === null) continue;
    button.addEventListener('click', () => selectDomainFilter(button.getAttribute('data-filter')));
  }
}

async function selectDomainFilter(value) {
  if (value !== 'domain' && value !== 'all') return;

  domainFilter = value;
  try {
    await prefsStorage.setDomainFilter(value);
  } catch (e) {
    console.error('Failed to save domain filter:', e);
  }

  updateDomainFilterUi();
  await renderTaskList();
}

function effectiveFilter() {
  return currentHost ? domainFilter : 'all';
}

function updateDomainFilterUi() {
  const group = document.getElementById('domain-filter');
  if (!group || !group.children) return;

  const hostAvailable = !!currentHost;
  const active = effectiveFilter();

  for (const button of group.children) {
    if (!button.getAttribute) continue;
    const value = button.getAttribute('data-filter');
    if (!value) continue;

    const isActive = value === active;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    button.disabled = value === 'domain' && !hostAvailable;
  }
}

function readDefaultTimeout() {
  const input = editorRefs.timeout;
  const value = input ? parseInt(input.value, 10) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : TASK_DEFAULT_TIMEOUT;
}

function resetEditor() {
  editorRefs.form = null;
  editorRefs.name = null;
  editorRefs.desc = null;
  editorRefs.timeout = null;
  editorRefs.steps = null;
  editorRefs.typeSelect = null;
}

function renderSteps() {
  const container = editorRefs.steps;
  if (!container) return;

  container.textContent = '';
  editingSteps.forEach((step, idx) => {
    container.appendChild(createStepRow(step, idx));
  });
}

function createStepRow(step, idx) {
  const row = document.createElement('div');
  row.className = 'step-row';
  row.draggable = true;
  row.dataset.index = String(idx);
  row.addEventListener('dragstart', event => handleDragStart(event, idx, row));
  row.addEventListener('dragover', event => handleDragOver(event, row));
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', event => handleDrop(event, idx, row));
  row.addEventListener('dragend', () => handleDragEnd(row));

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.title = 'Drag to reorder';
  handle.appendChild(createIcon('drag'));

  const number = document.createElement('span');
  number.className = 'step-number';
  number.textContent = `${idx + 1}.`;

  const typeSelect = document.createElement('select');
  typeSelect.className = 'step-type';
  typeSelect.title = 'Action type';
  for (const [value, text] of STEP_TYPES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    typeSelect.appendChild(option);
  }
  typeSelect.value = step.type;
  typeSelect.addEventListener('change', () => changeStepType(idx, typeSelect.value));

  row.appendChild(handle);
  row.appendChild(number);
  row.appendChild(typeSelect);

  if (step.type === 'click' || step.type === 'wait_element') {
    row.appendChild(createSelectorInput(step));

    if (step.type === 'wait_element') {
      row.appendChild(createTimeoutInput(step));
    }
  } else if (step.type === 'input_text') {
    row.appendChild(createSelectorInput(step));
    row.appendChild(createValueInput(step));
  } else if (step.type === 'wait_timeout') {
    row.appendChild(createMsInput(step));
  } else if (step.type === 'wait_page_load') {
    row.appendChild(createTimeoutInput(step, PAGE_LOAD_DEFAULT_TIMEOUT));
  }

  row.appendChild(createIconButton('close', 'Remove step', false, () => removeStepAt(idx)));
  return row;
}

function changeStepType(idx, type) {
  const step = editingSteps[idx];
  if (!step || step.type === type) return;

  editingSteps[idx] = normalizeStep(type, step);
  renderSteps();
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

function createIconButton(iconName, title, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.disabled = disabled;
  button.appendChild(createIcon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

function handleDragStart(event, idx, row) {
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    event.preventDefault();
    return;
  }

  dragSourceIndex = idx;
  row.classList.add('dragging');

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(idx));
  }
}

function handleDragOver(event, row) {
  if (dragSourceIndex === null) return;

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  row.classList.add('drag-over');
}

function handleDrop(event, idx, row) {
  event.preventDefault();
  row.classList.remove('drag-over');

  if (dragSourceIndex === null) return;
  reorderSteps(dragSourceIndex, idx);
  dragSourceIndex = null;
}

function handleDragEnd(row) {
  row.classList.remove('dragging');
  dragSourceIndex = null;
}

function reorderSteps(from, to) {
  if (from === to) return;
  if (from < 0 || to < 0 || from >= editingSteps.length || to >= editingSteps.length) return;

  const [moved] = editingSteps.splice(from, 1);
  editingSteps.splice(to, 0, moved);
  renderSteps();
}

function removeStepAt(idx) {
  editingSteps.splice(idx, 1);
  renderSteps();
}

function addStep() {
  const select = editorRefs.typeSelect;
  const stepType = select ? select.value : 'click';

  const step = normalizeStep(stepType);
  if (stepType === 'wait_element') step.timeout = readDefaultTimeout();

  editingSteps.push(step);
  renderSteps();
}

async function handleEditTask(event) {
  event.preventDefault();

  if (!currentEditingTaskId) return;

  const name = editorRefs.name ? editorRefs.name.value.trim() : '';
  if (!name) {
    showStatus('Fill in the required fields', 'error');
    return;
  }

  const description = editorRefs.desc ? editorRefs.desc.value : '';
  const defaultTimeout = readDefaultTimeout();
  const steps = editingSteps.map(step => ({ ...step }));

  const updated = await taskStorage.update(currentEditingTaskId, { name, description, defaultTimeout, steps });

  currentEditingTaskId = null;
  editingSteps = [];
  resetEditor();
  await renderTaskList();

  if (updated) {
    showStatus('Task saved', 'success');
  } else {
    showStatus('Task not found', 'error');
  }
}

async function cancelEdit() {
  currentEditingTaskId = null;
  editingSteps = [];
  resetEditor();
  await renderTaskList();
}

function scrollEditorIntoView() {
  const form = editorRefs.form;
  if (form && typeof form.scrollIntoView === 'function') {
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function createTaskEditForm(task) {
  const form = document.createElement('form');
  form.className = 'edit-form';
  form.addEventListener('submit', handleEditTask);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'field-input';
  nameInput.placeholder = 'Enter task name';
  nameInput.required = true;
  nameInput.value = task.name;
  form.appendChild(createField('Name:', nameInput));

  const descInput = document.createElement('textarea');
  descInput.className = 'field-input';
  descInput.rows = 2;
  descInput.value = task.description || '';
  form.appendChild(createField('Description:', descInput));

  const timeoutInput = document.createElement('input');
  timeoutInput.type = 'number';
  timeoutInput.min = '0';
  timeoutInput.className = 'field-input';
  timeoutInput.value = task.defaultTimeout || TASK_DEFAULT_TIMEOUT;
  form.appendChild(createField('Default timeout (ms):', timeoutInput));

  const stepsHeader = document.createElement('div');
  stepsHeader.className = 'steps-header';
  const stepsTitle = document.createElement('span');
  stepsTitle.className = 'steps-title';
  stepsTitle.textContent = 'Steps:';
  const stepsList = document.createElement('div');
  stepsList.className = 'steps-list';
  stepsHeader.appendChild(stepsTitle);
  stepsHeader.appendChild(stepsList);
  form.appendChild(stepsHeader);

  const typeSelect = document.createElement('select');
  typeSelect.className = 'step-type-select';
  for (const [value, text] of STEP_TYPES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    typeSelect.appendChild(option);
  }

  const addStepBtn = document.createElement('button');
  addStepBtn.type = 'button';
  addStepBtn.className = 'btn-add-step';
  addStepBtn.appendChild(createIcon('plus'));
  const addStepLabel = document.createElement('span');
  addStepLabel.textContent = 'Add step';
  addStepBtn.appendChild(addStepLabel);
  addStepBtn.addEventListener('click', addStep);

  const addRow = document.createElement('div');
  addRow.className = 'step-add-row';
  addRow.appendChild(typeSelect);
  addRow.appendChild(addStepBtn);
  form.appendChild(addRow);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelEdit);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'button-row';
  buttonRow.appendChild(saveBtn);
  buttonRow.appendChild(cancelBtn);
  form.appendChild(buttonRow);

  editorRefs.form = form;
  editorRefs.name = nameInput;
  editorRefs.desc = descInput;
  editorRefs.timeout = timeoutInput;
  editorRefs.steps = stepsList;
  editorRefs.typeSelect = typeSelect;

  renderSteps();
  return form;
}

function createField(labelText, control) {
  const field = document.createElement('label');
  field.className = 'field';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;

  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function pickLastUsed(tasks) {
  let best = null;
  for (const task of tasks) {
    if (!Number.isFinite(task.lastUsedAt)) continue;
    if (!best || task.lastUsedAt > best.lastUsedAt) best = task;
  }
  return best;
}

function filterTasks(tasks, filter, host) {
  if (filter === 'domain' && host) {
    return tasks.filter(task => task.host === host);
  }
  return tasks;
}

async function renderTaskList() {
  const list = document.getElementById('task-list');
  if (!list) return;

  const tasks = await taskStorage.getAll();
  renderLastUsed(tasks);
  renderTasks(filterTasks(tasks, effectiveFilter(), currentHost), tasks.length > 0);
}

function renderLastUsed(tasks) {
  const section = document.getElementById('last-used-section');
  const container = document.getElementById('last-used-task');
  if (!section || !container) return;

  const scoped = currentHost ? tasks.filter(task => task.host === currentHost) : [];
  const task = pickLastUsed(scoped);
  container.textContent = '';

  if (!task) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const actions = [
    createTaskButton('play', 'Run', 'btn-run', () => runTask(task.id)),
    createTaskButton('edit', 'Edit', 'btn-edit', () => editTask(task.id))
  ];
  container.appendChild(buildTaskSummary(task, actions, 'is-recent'));
}

function renderTasks(tasks, hasAnyTasks) {
  const list = document.getElementById('task-list');
  list.textContent = '';

  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = hasAnyTasks ? 'No tasks for this domain' : 'No saved tasks';
    list.appendChild(empty);
    return;
  }

  for (const task of [...tasks].reverse()) {
    list.appendChild(createTaskCard(task));
  }
}

function createTaskCard(task) {
  if (task.id === currentEditingTaskId) {
    const item = document.createElement('div');
    item.className = 'task-card is-editing';
    item.appendChild(createTaskHead(task));
    item.appendChild(createTaskEditForm(task));
    return item;
  }

  const actions = [
    createTaskButton('play', 'Run', 'btn-run', () => runTask(task.id)),
    createTaskButton('edit', 'Edit', 'btn-edit', () => editTask(task.id)),
    createTaskButton('trash', 'Delete', 'btn-delete', () => deleteTask(task.id))
  ];
  return buildTaskSummary(task, actions);
}

function createTaskHead(task, actionButtons = []) {
  const head = document.createElement('div');
  head.className = 'task-head';

  const name = document.createElement('strong');
  name.textContent = task.name;
  name.title = task.name;
  head.appendChild(name);

  if (actionButtons.length > 0) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'task-actions';
    actionButtons.forEach(button => actionsEl.appendChild(button));
    head.appendChild(actionsEl);
  }

  return head;
}

function buildTaskSummary(task, actions, extraClass = '') {
  const item = document.createElement('div');
  item.className = extraClass ? `task-card ${extraClass}` : 'task-card';

  item.appendChild(createTaskHead(task, actions));

  if (task.description) {
    const description = document.createElement('div');
    description.className = 'task-description';
    description.textContent = task.description;
    description.title = task.description;
    item.appendChild(description);
  }

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const date = new Date(task.createdAt || Date.now());
  meta.textContent = `${task.host || ''} • ${date.toLocaleString()}`;
  item.appendChild(meta);

  return item;
}

function createTaskButton(iconName, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn-icon ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

async function ensureTaskForCurrentHost(task, tasks) {
  if (task.host === currentHost) return { task, copied: false };

  const rootId = task.sourceId || task.id;
  const existing = tasks.find(item => item.host === currentHost && (item.sourceId || item.id) === rootId);
  if (existing) return { task: existing, copied: false };

  const copy = {
    id: crypto.randomUUID(),
    name: task.name,
    host: currentHost,
    description: task.description || '',
    defaultTimeout: task.defaultTimeout || TASK_DEFAULT_TIMEOUT,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    sourceId: rootId,
    steps: Array.isArray(task.steps) ? task.steps.map(step => ({ ...step })) : []
  };

  await taskStorage.add(copy);
  return { task: copy, copied: true };
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

  if (!currentHost) {
    showStatus('Cannot run tasks on this page (technical domain)', 'error');
    return;
  }

  const isForeign = task.host !== currentHost;

  try {
    const { task: runnable, copied } = await ensureTaskForCurrentHost(task, tasks);

    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: executeTask,
      args: [runnable]
    });

    if (!copied) await taskStorage.update(runnable.id, { lastUsedAt: Date.now() });

    if (isForeign) {
      domainFilter = 'domain';
      await prefsStorage.setDomainFilter('domain');
      updateDomainFilterUi();
    }

    showStatus(copied ? `Task copied to ${currentHost} and running` : `Task "${runnable.name}" is running`, 'success');
    await renderTaskList();
  } catch (e) {
    console.error(e);
    showStatus('Run failed: ' + e.message, 'error');
  }
}

async function deleteTask(taskId) {
  await taskStorage.remove(taskId);

  if (currentEditingTaskId === taskId) {
    currentEditingTaskId = null;
    editingSteps = [];
    resetEditor();
  }

  await renderTaskList();
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

  await renderTaskList();
  scrollEditorIntoView();
}
