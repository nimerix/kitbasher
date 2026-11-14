# Maintaining the documentation

The user manual is a separate Vite entry at `docs/index.html`. `npm run dev`
serves it at `/docs/`; `npm run build` emits `dist/docs/index.html` alongside the
editor. Both entries use the same deployment. Relative asset and navigation links
also work when the build is hosted under a subdirectory.

## Articles

The typed content lives in `src/docs/`:

- `start-guides.ts`: first assembly, interface, imports, navigation, parts,
  workflows, and inspection.
- `assembly-guides.ts`: transforms, alignment, contact paint, flush seams, anchors, pins,
  joints, planes, No clip, and measurement.
- `workspace-guides.ts`: saving, Drive, exports, appearance, preferences,
  performance, headset sessions, automation, and troubleshooting.
- `content.ts`: navigation order, grouping, search, and the default keyboard
  reference generated from the editor's own keybinding definitions.
- `types.ts`: article, section, image, table, note, and code-block shapes.

Add an article with a unique `id`, an existing group, and unique section IDs.
Include its ID in the order in `content.ts` and only use existing IDs in `related`.
Article and section strings are plain text. Use explicit section fields for
steps, bullets, tables, notes, or code instead of Markdown syntax.

Guide links use `?guide=alignment`, optionally followed by a section fragment such
as `#pick-a-method`. Query links need no per-article server routing. Native browser
history, modified-click, and full-page deep links work independently of the
client-side navigation enhancement.

## Images

Screenshots and explanatory SVG diagrams are in `public/docs/images/`. Figures
need descriptive alternative text and a caption that describes the actual image.
Readers can enlarge images in a same-page overlay, dismissed with its close button,
Escape, or a click behind the image. Keep images local so opening
documentation does not contact an external image provider.

To recapture the screenshots, start the development server and run:

```sh
npm run dev
# In a second terminal, with Google Chrome installed:
npm run docs:capture
# Or point at another development port:
DOCS_CAPTURE_URL=http://127.0.0.1:5188 npm run docs:capture
```

The script launches a fresh, headless browser with its own empty storage, loads
the original Scout sample, opens actual tools, and saves compressed WebP images.
It does not read or change an existing user's tab or assembly. It uses source-module
imports and therefore requires the development server, not the production preview.
The Drive screenshot deliberately shows the unconfigured local installation;
do not substitute a staged authenticated screenshot for a real account outcome.

The pin examples use `scripts/docs-pins.mjs` to isolate the sample torso and apply
real pin constraints. `pins.webp` shows rotation around a hard pin; `soft-pins.webp`
shows priority 85 and 15 pins resisting the same rotation, with the weaker pin’s
stretch, slider, and numeric field visible. Use a 1440 × 1000 viewport for both
captures. Keep the captions consistent with the displayed priorities and gaps.

The SVGs illustrate point and plane alignment, rigid residuals, multi-seam flush
fitting, and the scene workflow. They are explanatory diagrams, not screenshots.

## Validation

```sh
npm run build
npx playwright test tests/e2e/documentation.spec.ts
```

The browser tests cover editor links, all guide deep links and images, search and
keyboard dismissal, history, section links, mobile navigation/reflow, and missing
guide recovery. After changing a tool, check its instructions against the current
UI and update both text and images. Screenshot or emulator evidence does not
establish physical headset performance or successful live Google authorization.
