import { getFormConfig } from '../config/formConfig.js';
import { getValue } from './stateManager.js';

/* 🔺 THE FILENAME CARRIES THE PROJECT NAME, and it needs to.
 *
 * It was `<prefix>-<date>.<ext>` — i.e. the SAME name for every intake filled in on the same day.
 * Two downloads collided in the Downloads folder as "…(1).md", and, worse, nothing in the name said
 * which project a file was for; you had to open each one to tell them apart.
 *
 * `q0` ("What should we call this project?") exists precisely so an intake has a short handle, so
 * it belongs here too. Falls back to the bare prefix when q0 is empty, because a download must
 * never fail over a cosmetic detail.
 */

/** Filesystem-safe, lowercase, hyphenated, and bounded so the date stays visible at the end. */
function slugify(text) {
  return String(text)
    .normalize('NFKD')                  // "Café" → "Cafe" + a combining accent…
    .replace(/[̀-ͯ]/g, '')    // …then drop the accent, rather than the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')        // anything a filesystem or a shell might object to
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)                       // a long project name must not push the date off the end
    .replace(/-+$/, '');                // the slice above can leave a trailing hyphen
}

function getFilename(extension) {
  const formConfig = getFormConfig();
  const date = new Date().toISOString().split('T')[0];
  const prefix = formConfig.downloadFilenamePrefix || 'datalab-intake';
  const project = slugify(getValue('q0') || '');
  return project
    ? `${prefix}-${project}-${date}.${extension}`
    : `${prefix}-${date}.${extension}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

export function downloadMarkdown(markdownString) {
  const blob = new Blob([markdownString], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, getFilename('md'));
}

export function downloadCsv(csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, getFilename('csv'));
}