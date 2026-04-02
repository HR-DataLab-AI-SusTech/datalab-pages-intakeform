let formConfig = null;

export async function loadFormConfig() {
  try {
    const response = await fetch('./config/formConfig.json');
    if (!response.ok) {
      throw new Error(`Failed to load config: ${response.status}`);
    }
    formConfig = await response.json();
    return formConfig;
  } catch (err) {
    const container = document.getElementById('form-container');
    if (container) {
      container.innerHTML =
        '<div style="text-align:center;padding:3rem 1rem;color:#9b2743;">' +
        '<h2>Failed to load form configuration</h2>' +
        '<p>Please refresh the page or contact the administrator.</p>' +
        '</div>';
    }
    throw err;
  }
}

export function getFormConfig() {
  return formConfig;
}
