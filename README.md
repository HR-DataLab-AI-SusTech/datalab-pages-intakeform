# Datalab Intake Form

A config-driven, multi-step intake form for the HR Datalab. Collects data science project requests through a guided questionnaire and exports the results as a downloadable Markdown file.

No database, no backend — just static HTML/CSS/JS served via Docker.

![Datalab Intake Form](docs/frontpage_screenhot.jpeg)

## Quick Start

### Using Docker (recommended)

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

To stop:

```bash
docker compose down
```

### Without Docker

Serve the `src/` directory with any static file server:

```bash
# Using Python
python3 -m http.server 8080 --directory src

# Using Node.js (npx)
npx serve src -l 8080
```

## How It Works

1. The user navigates through 7 form pages, filling in questions about their data science project
2. Page 7 shows a summary of all answers with "Edit" links to go back
3. Clicking "Download as Markdown" generates a `.md` file with all answers
4. Form state is persisted in `sessionStorage` — refreshing the page won't lose data

## Generated Markdown Output

The downloaded file (`datalab-intake-YYYY-MM-DD.md`) is a structured Markdown document with all answers organized by section. Here's what the output looks like:

```markdown
# Datalab Intake Form

> Project intake for Data Science use-cases

**Generated:** 2026-03-31

---

## 1. Description of the Data Science Use-Case

*Help us understand the project you have in mind.*

### Q1: Describe the data science use-case in a popular summary.

*Write a brief, accessible summary that a non-technical person could understand.*

We want to predict patient readmission rates using historical hospital data
to improve discharge planning and reduce unnecessary readmissions.

### Q2: What is the background of the problem?

*Describe the context and why this problem matters.*

Currently 15% of patients are readmitted within 30 days. Each readmission
costs an average of EUR 5,000 and impacts patient outcomes negatively.

---

## 2. Management and Regulations

*Legal and ethical considerations for your project.*

### Q5: Is there Medical Ethics Review Committee (METC) approval?

Yes

### Q6: Does the project involve privacy-sensitive data under the GDPR?

Yes

---

...
```

### Output structure

- The **form title** and **subtitle** become the document heading and quote block
- Each **page** becomes an `## h2` section with auto-numbering
- Page and field **subtitles** are rendered in *italics* as context
- Each **field** becomes an `### h3` heading with the question ID and label
- **Checkbox** fields are rendered as a bullet list (`- item`)
- Empty fields show `*No answer provided*`
- Sections are separated by `---` horizontal rules

### Filename

The filename is configurable via `downloadFilenamePrefix` in `formConfig.js`:

```
{downloadFilenamePrefix}-YYYY-MM-DD.md
```

Default: `datalab-intake-2026-03-31.md`

## Configuring the Form

All form content lives in a single JSON file:

```
src/config/formConfig.json
```

Edit this file to add, remove, or change questions. No other file needs to change. Since it's plain JSON (not JavaScript), non-developers can safely edit it too.

### Config Structure

```json
{
  "title": "Datalab Intake Form",
  "subtitle": "Project intake for ...",
  "downloadFilenamePrefix": "datalab-intake",

  "pages": [
    {
      "id": "my-page",
      "title": "Page Heading",
      "subtitle": "Optional description text",
      "fields": [ ]
    },
    {
      "id": "summary",
      "title": "Summary & Download",
      "isSummary": true,
      "summaryPageTitle": "Review Your Answers",
      "editButtonText": "Edit",
      "emptyFieldText": "No answer provided",
      "downloadInstructions": "Review your answers above, then download...",
      "downloadButtonText": "Download as Markdown",
      "fields": []
    }
  ]
}
```

### Field Types

#### `textarea` — Multi-line text input

```json
{
  "id": "background",
  "type": "textarea",
  "label": "What is the background of the problem?",
  "subtitle": "Describe the context and why this matters.",
  "placeholder": "Enter your answer...",
  "required": true,
  "rows": 5
}
```

#### `text` — Single-line text input

```json
{
  "id": "file-format",
  "type": "text",
  "label": "What is the file format?",
  "subtitle": "Specify file extensions you expect.",
  "placeholder": "e.g. .csv, .wav, .json",
  "required": true
}
```

#### `radio` — Single-select (pick one)

```json
{
  "id": "data-collected",
  "type": "radio",
  "label": "Is the data already collected?",
  "options": ["Yes, already collected", "No, still needs to be collected"],
  "required": true
}
```

#### `checkbox` — Multi-select (pick many)

```json
{
  "id": "stack-elements",
  "type": "checkbox",
  "label": "Which stack elements are needed?",
  "subtitle": "Select all that apply.",
  "options": ["Data collection", "Cleaning", "Analysis", "Visualization", "ML/AI", "Deployment"],
  "required": true
}
```

#### `select` — Dropdown menu

```json
{
  "id": "priority",
  "type": "select",
  "label": "What is the project priority?",
  "placeholder": "Choose a priority...",
  "options": ["Low", "Medium", "High", "Critical"],
  "required": true
}
```

### Optional Field Properties

| Property | Applies to | Description |
|---|---|---|
| `subtitle` | All types | Help text shown below the question label |
| `placeholder` | text, textarea, select | Placeholder text inside the input |
| `required` | All types | If `true`, the user must answer before advancing |
| `rows` | textarea | Number of visible rows (default: 4) |
| `infoLink` | All types | External reference link (see below) |

### Adding Reference Links

Any field can include an external link for more information:

```json
{
  "id": "gdpr",
  "type": "radio",
  "label": "Does the project involve GDPR-sensitive data?",
  "infoLink": {
    "url": "https://example.com/gdpr-info",
    "text": "More about GDPR"
  },
  "options": ["Yes", "No", "Not sure"],
  "required": true
}
```

### Examples

#### Adding a new page

Add a new object to the `pages` array (before the summary page):

```json
{
  "id": "team-info",
  "title": "Team Information",
  "subtitle": "Tell us about the people involved.",
  "fields": [
    {
      "id": "q13",
      "type": "text",
      "label": "Who is the project lead?",
      "placeholder": "Full name",
      "required": true
    },
    {
      "id": "q14",
      "type": "text",
      "label": "Contact email",
      "placeholder": "name@example.com",
      "required": true
    },
    {
      "id": "q15",
      "type": "select",
      "label": "Which department?",
      "options": ["Research", "Engineering", "Clinical", "Operations", "Other"],
      "required": true
    }
  ]
}
```

#### Making a field optional

Simply omit `required` or set it to `false`:

```json
{
  "id": "notes",
  "type": "textarea",
  "label": "Any additional notes?",
  "subtitle": "Optional — add anything else we should know.",
  "rows": 4
}
```

## Development

### Prerequisites

- **Node.js** >= 18 (for linting tools)
- **Docker** (for local serving)

### Install dependencies

```bash
npm install
```

### Linting

```bash
npm run lint        # Run all linters (ESLint + Stylelint + HTMLHint)
npm run lint:js     # ESLint only
npm run lint:css    # Stylelint only
npm run lint:html   # HTMLHint only
npm run format      # Auto-format with Prettier
```

### NPM Scripts

| Script | Description |
|---|---|
| `npm run lint` | Run all linters |
| `npm run format` | Auto-format all source files |
| `npm run docker:up` | Start the Docker container |
| `npm run docker:down` | Stop the Docker container |

## Project Structure

```
src/
  index.html                        # Single-page HTML shell
  config/
    formConfig.json                  # All form content as JSON (edit this!)
  css/
    reset.css                       # CSS reset
    variables.css                   # Design tokens (colors, fonts, spacing)
    layout.css                      # Page structure (header, main, footer)
    form.css                        # Form elements (inputs, radios, checkboxes, selects)
    navigation.css                  # Step indicator and nav buttons
    summary.css                     # Summary/review page and download section
    utilities.css                   # Helpers (hidden, sr-only, reduced-motion)
  js/
    main.js                         # Entry point — loads config, wires DOM
    config/
      formConfig.js                 # Fetches and exposes the JSON config
    modules/
      formRenderer.js               # Reads config, builds DOM for each page
      navigation.js                 # Page switching, step indicator, prev/next
      validation.js                 # Per-page required field checks
      stateManager.js               # In-memory + sessionStorage answer store
      markdownGenerator.js          # Converts answers to formatted Markdown
      downloadHandler.js            # Creates Blob and triggers file download
      summaryRenderer.js            # Read-only review page with edit links
      pageController.js             # Decoupled page navigation (avoids circular deps)
docker/
  Dockerfile                        # nginx:alpine image
  nginx.conf                        # Static file serving config
docker-compose.yml                  # Mounts src/ as volume on port 8080
```

## Architecture Decisions

- **Config-driven rendering** — All questions, options, labels, and help text live in `formConfig.js`. The renderer reads this config and builds the DOM dynamically. Adding a question means editing one file.
- **No build step** — Uses native ES modules (`<script type="module">`). No bundler, no transpiler. Modern browsers handle this natively.
- **No database** — Form state lives in `sessionStorage` (survives page refresh, cleared when the tab closes). The deliverable is the downloaded Markdown file.
- **CSS custom properties** — All colors, fonts, and spacing are defined as variables in `variables.css`. Rebranding requires editing only that file.
- **Modular CSS** — Separate stylesheets by concern (layout, form, navigation, summary) to keep things maintainable.

## Theming

To change the visual appearance, edit `src/css/variables.css`:

```css
:root {
  --color-primary: #0a3049;       /* Header, buttons, active steps */
  --color-secondary: #9b2743;     /* Accent, info links, error states */
  --color-success: #5a8a3c;       /* Download button, completed steps */
  --color-bg: #f7f4ef;            /* Page background */
  --color-surface: #fff;          /* Card / form background */
  --font-display: 'DM Serif Display', georgia, serif;
  --font-body: 'DM Sans', system-ui, sans-serif;
}
```
