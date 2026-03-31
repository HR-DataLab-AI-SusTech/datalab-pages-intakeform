import { getFormConfig } from '../config/formConfig.js';
import { getAllValues } from './stateManager.js';

export function generateMarkdown() {
  const formConfig = getFormConfig();
  const values = getAllValues();
  const now = new Date();
  const date = now.toISOString().split('T')[0];

  const lines = [];
  lines.push(`# ${formConfig.title}`);
  if (formConfig.subtitle) {
    lines.push('');
    lines.push(`> ${formConfig.subtitle}`);
  }
  lines.push('');
  lines.push(`**Generated:** ${date}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let sectionNumber = 1;

  for (const page of formConfig.pages) {
    if (page.isSummary) {
      continue;
    }

    lines.push(`## ${sectionNumber}. ${page.title}`);
    if (page.subtitle) {
      lines.push('');
      lines.push(`*${page.subtitle}*`);
    }
    lines.push('');

    for (const field of page.fields) {
      lines.push(`### ${field.id.toUpperCase()}: ${field.label}`);
      if (field.subtitle) {
        lines.push('');
        lines.push(`*${field.subtitle}*`);
      }
      lines.push('');

      const rawValue = values[field.id];
      const display = formatMarkdownValue(field, rawValue);
      lines.push(display);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    sectionNumber++;
  }

  return lines.join('\n');
}

function formatMarkdownValue(field, rawValue) {
  if (!rawValue) {
    return '*No answer provided*';
  }

  if (field.type === 'checkbox') {
    try {
      const arr = JSON.parse(rawValue);
      return arr.map((v) => `- ${v}`).join('\n');
    } catch {
      return rawValue;
    }
  }

  return rawValue;
}
