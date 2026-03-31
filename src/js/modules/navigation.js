import { getFormConfig } from '../config/formConfig.js';
import { renderPage } from './formRenderer.js';
import { validatePage } from './validation.js';
import { renderSummary } from './summaryRenderer.js';
import { setNavigateCallback } from './pageController.js';

let currentPage = 0;
let totalPages = 0;

let formContainer;
let btnPrev;
let btnNext;
let pageCounter;
let stepIndicator;

export function initNavigation() {
  const formConfig = getFormConfig();
  totalPages = formConfig.pages.length;

  formContainer = document.getElementById('form-container');
  btnPrev = document.getElementById('btn-prev');
  btnNext = document.getElementById('btn-next');
  pageCounter = document.getElementById('page-counter');
  stepIndicator = document.getElementById('step-indicator');

  btnPrev.addEventListener('click', goToPreviousPage);
  btnNext.addEventListener('click', goToNextPage);

  setNavigateCallback(navigateTo);

  buildStepIndicator();
  showPage(currentPage);
}

function navigateTo(pageIndex) {
  if (pageIndex >= 0 && pageIndex < totalPages) {
    currentPage = pageIndex;
    showPage(currentPage);
  }
}

function goToPreviousPage() {
  if (currentPage > 0) {
    currentPage--;
    showPage(currentPage);
  }
}

function goToNextPage() {
  const formConfig = getFormConfig();
  const page = formConfig.pages[currentPage];

  if (!page.isSummary) {
    const result = validatePage(page);
    if (!result.valid) {
      return;
    }
  }

  if (currentPage < totalPages - 1) {
    currentPage++;
    showPage(currentPage);
  }
}

function showPage(index) {
  const formConfig = getFormConfig();
  const page = formConfig.pages[index];

  if (page.isSummary) {
    renderSummary(formContainer);
  } else {
    renderPage(page, formContainer);
  }

  updateButtons(index);
  updateStepIndicator(index);
  updatePageCounter(index);
}

function updateButtons(index) {
  const isFirst = index === 0;
  const isLast = index === totalPages - 1;

  btnPrev.classList.toggle('btn-hidden', isFirst);

  if (isLast) {
    btnNext.classList.add('hidden');
  } else {
    btnNext.classList.remove('hidden');
    btnNext.innerHTML = 'Next &#8594;';
    btnNext.classList.remove('btn-success');
    btnNext.classList.add('btn-primary');
  }
}

function updatePageCounter(index) {
  pageCounter.textContent = `Page ${index + 1} of ${totalPages}`;
}

function buildStepIndicator() {
  const formConfig = getFormConfig();
  stepIndicator.innerHTML = '';

  for (let i = 0; i < totalPages; i++) {
    const step = document.createElement('div');
    step.className = 'step';

    const circle = document.createElement('div');
    circle.className = 'step-circle';
    circle.textContent = i + 1;
    circle.dataset.step = i;
    circle.setAttribute('aria-label', `Step ${i + 1}: ${formConfig.pages[i].title}`);
    circle.setAttribute('role', 'button');
    circle.setAttribute('tabindex', '0');

    circle.addEventListener('click', () => navigateTo(i));
    circle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateTo(i);
      }
    });

    step.appendChild(circle);

    if (i < totalPages - 1) {
      const line = document.createElement('div');
      line.className = 'step-line';
      line.dataset.line = i;
      step.appendChild(line);
    }

    stepIndicator.appendChild(step);
  }
}

function updateStepIndicator(activeIndex) {
  for (let i = 0; i < totalPages; i++) {
    const circle = stepIndicator.querySelector(`[data-step="${i}"]`);
    circle.classList.remove('active', 'completed');

    if (i === activeIndex) {
      circle.classList.add('active');
    } else if (i < activeIndex) {
      circle.classList.add('completed');
    }

    if (i < totalPages - 1) {
      const line = stepIndicator.querySelector(`[data-line="${i}"]`);
      line.classList.toggle('completed', i < activeIndex);
    }
  }
}
