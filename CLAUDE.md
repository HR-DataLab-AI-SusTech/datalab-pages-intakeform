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
- **Local**: `docker compose --profile dev up` on localhost:8080 (the `dev` profile also starts a
  throwaway Postgres for the bridge — see [`bridge/README.md`](bridge/README.md))
- **The bridge** is a container on PC-1, deployed separately from this page. Pushing here does NOT
  deploy it.

### 🔺 CSS and JS can be a deploy out of step with each other — style defensively

There is **no build step**, so assets ship unversioned and GitHub Pages serves them with
`max-age=600`. CSS and JS therefore expire **independently**: for up to ten minutes after a deploy a
visitor can hold **new CSS with old JS**. Versioning the entry point does not fix it — `main.js`
imports the other modules by bare relative path and nothing rewrites them.

⚠️ **This class of bug is invisible while developing**: whoever just deployed has both halves fresh
and never sees it. It produced three real faults on 2026-08-27, each looking like a different
problem:

| Symptom | Actual cause |
| --- | --- |
| a button rendered as an unstyled browser default | CSS renamed the class; old JS asked for the old name |
| panel text invisible at **1.13:1** | the new class carried the colour; old JS emits the element with no class |
| a button rendered **red on a red panel** | old JS emitted `.btn-primary`, which *is* HR red |

⭐ **So write CSS that does not depend on which JS emitted the markup:**

1. **Match on ancestor, not on class name** — `.download-section .btn-primary` is true for every JS
   version, past and future, and needs no maintaining. An alias only survives until the next rename.
2. **Put colour on the element** (`.download-section p`), not only on a new class, so markup the CSS
   has not been told about cannot render unreadable.
3. **Keep a retired class name as an alias** when the above cannot apply, and say why — the aliases
   in `summary.css` are not dead code.
4. **Verify under the failing condition**, not after a clean reload: hold the old JS and confirm it
   still renders. A screenshot from a fresh browser proves nothing about a returning visitor.

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
- Green: #3f7d20 (completed steps only — ⚠️ NOT the download button any more, see below)
- Cool grey-white: #f4f6fb (background)
- Light neutral borders: #e5e7eb
- Distinct error red: #dc2828 (never the same red as primary — the two must stay
  visually separable)
- Font: Poppins (self-hosted, no Google Fonts — privacy-safe)

🔺 **`src/css/variables.css` is the authority, not this list.** The palette is repeated here only so
an assistant has it to hand; if the two disagree, the stylesheet is right and this list needs fixing.
It also holds the `--on-brand-*` tokens for surfaces where red is the *background* — read their
contrast measurements before styling anything on the red panel, because only white clears AA there.

⚠️ **The download button is white-filled with a red label, not green.** Green stood out against an
earlier red panel, which is exactly the green/red pairing the HR guide warns about — it collapses
under deuteranopia. The panel is HR red now: the primary action is a white block, the secondary a
white outline. Neither is green, and neither is red.

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
