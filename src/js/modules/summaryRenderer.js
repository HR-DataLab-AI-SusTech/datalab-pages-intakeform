import { getFormConfig } from '../config/formConfig.js';
import { getValue, getAllValues, clearState } from './stateManager.js';
import { generateMarkdown } from './markdownGenerator.js';
import { generateCsv } from './csvGenerator.js';
import { downloadMarkdown, downloadCsv } from './downloadHandler.js';
import { goToPage } from './pageController.js';
import { BRIDGE_BASE_URL, SUBMIT_ENABLED } from '../config/bridgeConfig.js';

function getSummaryPage() {
  const formConfig = getFormConfig();
  return formConfig.pages.find((p) => p.isSummary) || {};
}

export function renderSummary(container) {
  const formConfig = getFormConfig();
  container.innerHTML = '';

  const summaryPage = getSummaryPage();
  const section = document.createElement('div');
  section.className = 'summary-page';

  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = summaryPage.summaryPageTitle || 'Review Your Answers';
  title.tabIndex = -1;
  section.appendChild(title);

  let pageIndex = 0;

  for (const page of formConfig.pages) {
    if (page.isSummary || page.isLanding) {
      continue;
    }

    const sectionEl = document.createElement('div');
    sectionEl.className = 'summary-section';

    const header = document.createElement('div');
    header.className = 'summary-section-header';

    const sectionTitle = document.createElement('h3');
    sectionTitle.className = 'summary-section-title';
    sectionTitle.textContent = page.title;

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-link';
    editBtn.textContent = summaryPage.editButtonText || 'Edit';
    editBtn.setAttribute('aria-label', `Edit ${page.title}`);
    const targetPage = pageIndex;
    editBtn.addEventListener('click', () => {
      goToPage(targetPage);
    });

    header.appendChild(sectionTitle);
    header.appendChild(editBtn);
    sectionEl.appendChild(header);

    for (const field of page.fields) {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'summary-field';

      const labelEl = document.createElement('div');
      labelEl.className = 'summary-label';
      labelEl.textContent = `${field.id.toUpperCase()}: ${field.label}`;

      const valueEl = document.createElement('div');
      valueEl.className = 'summary-value';
      const value = getValue(field.id);
      if (value) {
        valueEl.textContent = formatDisplayValue(field, value);
      } else {
        valueEl.textContent = summaryPage.emptyFieldText || 'No answer provided';
        valueEl.classList.add('empty');
      }

      fieldEl.appendChild(labelEl);
      fieldEl.appendChild(valueEl);
      sectionEl.appendChild(fieldEl);
    }

    section.appendChild(sectionEl);
    pageIndex++;
  }

  // Download section
  const downloadSection = document.createElement('div');
  downloadSection.className = 'download-section';

  // An overline + heading as REAL elements, not CSS `content:` — generated text is not reliably
  // announced by screen readers and cannot be translated.
  const overline = document.createElement('p');
  overline.className = 'download-overline';
  overline.textContent = summaryPage.downloadOverline || 'Last step';

  const downloadHeading = document.createElement('h3');
  downloadHeading.className = 'download-heading';
  downloadHeading.textContent = summaryPage.downloadHeading || 'Take your answers with you';

  const downloadText = document.createElement('p');
  downloadText.className = 'download-intro';
  downloadText.textContent =
    summaryPage.downloadInstructions ||
    'Review your answers above, then download the form.';

  downloadSection.appendChild(overline);
  downloadSection.appendChild(downloadHeading);
  downloadSection.appendChild(downloadText);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'download-btn-group';

  btnGroup.appendChild(
    createDownloadButton('Markdown', 'btn-on-brand', () => {
      const md = generateMarkdown();
      downloadMarkdown(md);
    }),
  );

  btnGroup.appendChild(
    createDownloadButton('CSV', 'btn-outline-on-brand', () => {
      const csv = generateCsv();
      downloadCsv(csv);
    }),
  );

  downloadSection.appendChild(btnGroup);

  downloadSection.appendChild(createSubmitSection());

  const startOverBtn = document.createElement('button');
  startOverBtn.className = 'btn btn-secondary start-over-btn';
  startOverBtn.textContent = summaryPage.startOverButtonText || 'Start Over';
  startOverBtn.setAttribute('aria-label', 'Clear all answers and start over');
  startOverBtn.addEventListener('click', () => {
    clearState();
    goToPage(0);
  });
  downloadSection.appendChild(startOverBtn);

  section.appendChild(downloadSection);

  container.appendChild(section);
  title.focus();
}

function createDownloadButton(label, cssClass, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${cssClass}`;
  btn.textContent = `Download ${label}`;
  btn.setAttribute('aria-label', `Download form as ${label} file`);

  btn.addEventListener('click', () => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Downloading...';
    try {
      onClick();
      btn.textContent = 'Downloaded!';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      }, 2000);
    } catch {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  return btn;
}

function createSubmitSection() {
  const wrapper = document.createElement('div');
  wrapper.className = 'submit-section';

  // 🔺 Backend not deployed yet ⇒ render an explanation, never a dead button. See SUBMIT_ENABLED
  // in config/bridgeConfig.js for the three conditions that have to hold before flipping it on.
  // This page is public the moment anything reaches `main`, so an enabled button that cannot work
  // is worse for a stakeholder than no button at all: they would fill in the whole form and get a
  // bare network error.
  if (!SUBMIT_ENABLED) {
    const note = document.createElement('p');
    note.className = 'submit-status';
    note.textContent =
      'Online submission is not switched on yet — send the downloaded file to the datalab team.';
    wrapper.appendChild(note);
    return wrapper;
  }

  // 🔺 Classed, and the classes matter: this whole section sits on the RED panel, where the
  // inherited near-black body colour measures 4.01 and fails AA. An unclassed label here renders
  // as good as invisible — the same fault that hit the intro paragraph on the live site.
  const label = document.createElement('label');
  label.className = 'submit-label';
  label.textContent = 'Passphrase';
  label.setAttribute('for', 'intake-submit-passphrase');

  const passphraseInput = document.createElement('input');
  passphraseInput.type = 'password';
  passphraseInput.className = 'submit-passphrase';
  passphraseInput.id = 'intake-submit-passphrase';
  passphraseInput.autocomplete = 'off';
  passphraseInput.setAttribute('aria-label', 'Submission passphrase');

  // ⚠️ NOT `btn-primary` — that class IS HR red, which on a red panel is an invisible button.
  // `btn-on-brand` is the white-fill/red-label pairing built for this background.
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-on-brand submit-btn';
  submitBtn.textContent = 'Submit';
  submitBtn.setAttribute('aria-label', 'Submit the intake form');

  const statusEl = document.createElement('p');
  statusEl.className = 'submit-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  submitBtn.addEventListener('click', () => {
    submitIntake({ passphraseInput, submitBtn, statusEl });
  });

  wrapper.appendChild(label);
  wrapper.appendChild(passphraseInput);
  wrapper.appendChild(submitBtn);
  wrapper.appendChild(statusEl);

  return wrapper;
}

function setSubmitStatus(statusEl, text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove('submit-status-error', 'submit-status-success');
  if (kind) {
    statusEl.classList.add(kind === 'error' ? 'submit-status-error' : 'submit-status-success');
  }
}

async function submitIntake({ passphraseInput, submitBtn, statusEl }) {
  const passphrase = passphraseInput.value;
  if (!passphrase) {
    setSubmitStatus(statusEl, 'Enter the passphrase before submitting.', 'error');
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Submitting...';
  setSubmitStatus(statusEl, '');

  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Intake-Passphrase': passphrase,
      },
      body: JSON.stringify({ answers: getAllValues() }),
    });

    if (response.status === 403) {
      setSubmitStatus(statusEl, 'Wrong passphrase.', 'error');
      return;
    }
    if (response.status === 429) {
      setSubmitStatus(statusEl, 'Too many attempts, try again later.', 'error');
      return;
    }
    if (!response.ok) {
      setSubmitStatus(statusEl, 'Submission failed — please try again later.', 'error');
      return;
    }

    const result = await response.json();
    statusEl.textContent = '';
    statusEl.classList.remove('submit-status-error');
    statusEl.classList.add('submit-status-success');
    statusEl.appendChild(document.createTextNode('Submitted — thank you.'));
    if (result && result.compass_pr_url) {
      statusEl.appendChild(document.createTextNode(' '));
      const link = document.createElement('a');
      link.href = result.compass_pr_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Review queue entry (internal reference)';
      statusEl.appendChild(link);
    }
    passphraseInput.value = '';
  } catch {
    setSubmitStatus(statusEl, 'Submission failed — please check your connection and try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

function formatDisplayValue(field, value) {
  if (field.type === 'checkbox') {
    try {
      const arr = JSON.parse(value);
      return arr.join(', ');
    } catch {
      return value;
    }
  }
  return value;
}
