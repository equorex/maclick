function executeTask(task) {
  const DEFAULT_TIMEOUT = 300;
  const PAGE_LOAD_TIMEOUT = 30000;
  const STEP_DELAY = 300;
  const POLL_INTERVAL = 100;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const getTimeout = step => {
    const value = parseInt(step.timeout, 10);
    if (Number.isFinite(value) && value > 0) return value;

    const fallback = parseInt(task.defaultTimeout, 10);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_TIMEOUT;
  };

  const getPageLoadTimeout = step => {
    const value = parseInt(step.timeout, 10);
    return Number.isFinite(value) && value > 0 ? value : PAGE_LOAD_TIMEOUT;
  };

  const waitForElement = async (selector, timeout) => {
    if (!selector) return null;

    const start = Date.now();
    let element = document.querySelector(selector);

    while (!element && Date.now() - start < timeout) {
      await sleep(POLL_INTERVAL);
      element = document.querySelector(selector);
    }

    return element;
  };

  const clickElement = async (step) => {
    const element = await waitForElement(step.selector, getTimeout(step));
    if (!element) throw new Error(`Element not found: ${step.selector}`);
    element.click();
  };

  const setElementValue = (element, value) => {
    const prototype = element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(element, value);
  };

  const fillElement = async (step) => {
    const element = await waitForElement(step.selector, getTimeout(step));
    if (!element) throw new Error(`Element not found: ${step.selector}`);

    element.focus();
    setElementValue(element, step.value == null ? '' : String(step.value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.blur();
  };

  const runStep = async (step) => {
    if (step.type === 'click' || step.type === 'wait_element') {
      await clickElement(step);
      return;
    }

    if (step.type === 'input_text') {
      await fillElement(step);
      return;
    }

    if (step.type === 'wait_timeout') {
      const ms = parseInt(step.ms, 10);
      await sleep(Number.isFinite(ms) ? ms : 1000);
      return;
    }

    if (step.type === 'wait_page_load') {
      const timeout = getPageLoadTimeout(step);
      const start = Date.now();

      while (document.readyState !== 'complete') {
        if (Date.now() - start > timeout) throw new Error('Page load timeout');
        await sleep(POLL_INTERVAL);
      }

      return;
    }

    throw new Error(`Unknown step type: ${step.type}`);
  };

  const run = async () => {
    for (let index = 0; index < task.steps.length; index++) {
      try {
        await runStep(task.steps[index]);
      } catch (e) {
        console.error(`Step ${index + 1} failed: ${e.message}`);
        return;
      }

      await sleep(STEP_DELAY);
    }

    console.log('Task completed');
  };

  return run();
}

globalThis.PAGE_LOAD_DEFAULT_TIMEOUT = 30000;
globalThis.executeTask = executeTask;
