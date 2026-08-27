import { loadFormConfig, getFormConfig } from './config/formConfig.js';
import { initNavigation } from './modules/navigation.js';
import { hasAnyValues } from './modules/stateManager.js';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('form-container');
  if (container) {
    container.innerHTML =
      '<div style="text-align:center;padding:3rem;color:#666d7a;">Loading...</div>';
  }

  try {
    await loadFormConfig();
  } catch {
    return;
  }

  const formConfig = getFormConfig();

  const titleEl = document.querySelector('.header-title');
  if (titleEl) {
    titleEl.textContent = formConfig.title;
  }

  const subtitleEl = document.querySelector('.header-subtitle');
  if (subtitleEl && formConfig.subtitle) {
    subtitleEl.textContent = formConfig.subtitle;
  }

  document.title = formConfig.title;

  initNavigation();
});

window.addEventListener('beforeunload', (e) => {
  if (hasAnyValues()) {
    e.preventDefault();
  }
});
