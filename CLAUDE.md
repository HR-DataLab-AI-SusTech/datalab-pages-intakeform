# Project: AI SusTech Datalab Intake Form

## Overview

Config-driven multi-step intake form for the AI SusTech Datalab. Vanilla HTML/CSS/JS, no framework, no build step. Deployed to GitHub Pages via GitHub Actions; can also be served locally via Docker (nginx). Form content is defined in `src/config/formConfig.json`.

## Key Commands

```bash
npm run lint          # ESLint + Stylelint + HTMLHint
npm run format        # Prettier
docker compose up     # Serve on localhost:8080
```

## Deployment

- **Production**: GitHub Pages — auto-deployed via `.github/workflows/deploy-pages.yml` on push to `main`
- **Live URL**: https://hr-datalab-ai-sustech.github.io/datalab-pages-intakeform/
- **Local**: `docker compose up` on localhost:8080

## Privacy

- No external CDN requests (fonts are self-hosted)
- No analytics, tracking, or third-party scripts
- Filling out the form and downloading Markdown/CSV is unchanged and still makes **zero
  network calls** — answers stay in the browser (`sessionStorage`) unless you use Submit.
- There is also an optional **Submit** action that sends the answers to the lab's own
  self-hosted backend (not a third party) so the datateam can review submissions
  centrally. It is gated by a shared passphrase. Using Submit means the data leaves the
  browser — don't describe the form as fully private once that path is used.

## Architecture

- `src/config/formConfig.json` — single source of truth for all form content (pages, questions, UI text)
- `src/js/config/formConfig.js` — fetches JSON, exposes `getFormConfig()`
- `src/js/modules/` — one module per concern (renderer, navigation, validation, state, export, download)
- `src/css/variables.css` — all design tokens (colors, fonts, spacing)
- Page types: landing (`isLanding`), form (default), summary (`isSummary`)
- State lives in `sessionStorage` via `stateManager.js`
- Browser history via `pushState` with page ID hashes

## Brand: Hogeschool Rotterdam / AI SusTech Datalab

- HR red: #e2001a (header, primary — buttons, active steps)
- Near-black: #0a0a0a (decorative accent bars, info links, foreground text)
- Green: #3f7d20 (CTA, success — download button, completed steps)
- Cool grey-white: #f4f6fb (background)
- Light neutral borders: #e5e7eb
- Distinct error red: #dc2828 (never the same red as primary — the two must stay
  visually separable)
- Font: Poppins (self-hosted, no Google Fonts — privacy-safe)

## Frontend Design Skill

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics.

### Design Direction: Editorial/Magazine

The current design uses an editorial aesthetic with:
- Poppins font family (self-hosted, HR corporate font)
- Dominant HR red with near-black accents
- Cool grey-white backgrounds with subtle grain texture
- Staggered animations on page transitions
- Strong typographic hierarchy with decorative underlines

### Guidelines

- **Typography**: Use Poppins (self-hosted). Never load fonts from external CDNs (privacy requirement).
- **Color**: Dominant color with sharp accents. Use CSS variables.
- **Motion**: Staggered reveals on page load. CSS-only where possible.
- **Spatial**: Generous whitespace. Card-based layout with shadows and rounded corners.
- **Details**: Grain overlay, decorative accent bars, hover micro-interactions.

NEVER use generic AI aesthetics: overused fonts, purple gradients, predictable layouts, cookie-cutter patterns.
