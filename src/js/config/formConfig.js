let formConfig = null;

export async function loadFormConfig() {
  const response = await fetch('/config/formConfig.json');
  formConfig = await response.json();
  return formConfig;
}

export function getFormConfig() {
  return formConfig;
}
