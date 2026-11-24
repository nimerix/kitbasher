# Maintaining the documentation

The user manual is a separate Vite entry at `docs/index.html`. `npm run dev`
serves it at `/docs/`; `npm run build` emits `dist/docs/index.html` alongside the
editor. Both entries use the same deployment. Relative asset and navigation links
also work when the build is hosted under a subdirectory.

## Articles

The typed content lives in `src/docs/`:

- `start-guides.ts`: first assembly, interface, imports, navigation, parts,
  workflows, and inspection.
- `assembly-guides.ts`: transforms, alignment, contact paint, Warp, Sculpt, Refine, flush seams,
  anchors, pins, joints, planes, No clip, and measurement.
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

## What's new

`src/docs/changelog.ts` lists releases, newest first, and renders at
`?guide=whats-new`. Each release shows the short hash of the commit it shipped in, so a
bug report can name the build. The sidebar shows the commit the documentation was
built from, and the overview links to the newest release. The workbench header's
What's new button shows the three newest releases and marks one the visitor hasn't
opened yet.

Entries are optional; add one when a change is worth telling people about. Put it at
the top of the list with today's `date`, a short, unique `title` (it becomes the
release's link), and one entry per user-visible change. Mark each `new`, `improved`,
or `fixed`, and set `guide` to an article ID to link to it. Leave out `commit`: the
build reads git history (`scripts/release-commits.mjs`) and shows the commit that
added the entry, which is the merge on `main`. Set `commit` only when the change
shipped in an earlier commit than its entry.

Write for people using Kitbasher, not for reviewers: what they can now do, or what
works differently. `tests/unit/changelog.test.ts` checks ordering, dates, unique
titles, commits, and guide links.

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

## Sculpt brush examples

With the development server running, use `node scripts/capture-sculpt-brushes.mjs` to
regenerate the eight before-and-after images in `public/docs/images/sculpt/`. Each pair
uses the same viewport and lighting. The script selects the brush in the workbench,
drags on a practice tile, and waits for the stroke to commit before capturing the result.
Set `DOCS_CAPTURE_URL` to use another port or pass `--only=grab` to capture one brush.

## References beside the instructions

`src/docs/reference-images.ts` describes focused screenshots used inside guide
sections. The matching files are in `public/docs/images/reference/`. Supply the
actual `width` and `height` for each crop so lazy loading reserves the right space.
These figures use the same enlargement overlay as the existing article images.

| Where readers need a visual                    | Reference added                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| First assembly, workbench menus, saving        | Open File menu and its scene commands                                 |
| Workbench layout and small windows             | Header/tool row, Parts panel, and narrow-screen panel toggles         |
| Navigation and isolation                       | View selector, expanded Camera panel, and Nearby surfaces controls    |
| Part visibility and context actions            | Selected row with eye/lock buttons, hidden part, and right-click menu |
| Exact placement and collision tolerance        | Move steps and axes, plus No clip and its millimeter field            |
| Contact painting                               | Right-click brush settings                                            |
| Reference planes and retained constraints      | Ground target selector and the existing Mate planes tutorial result   |
| Display, preferences, and measurement callouts | Exploded view, Navigation settings, and Markers with Callout selected |
| Background work and notifications              | Completed interference job and an actual local-download notification  |

Regenerate these references independently of the article heroes and tutorials:

```sh
npm run docs:capture:reference
DOCS_CAPTURE_URL=http://127.0.0.1:5188 npm run docs:capture:reference -- --only=brush-settings
```

Each capture uses a fresh browser context and the original Scout scene. Menus and
controls are operated in the real editor; the activity example runs a real
interference check, and the notification example downloads a real scene. There is
no authenticated Drive session or staged provider success. Inspect the generated
crop and keep its alt text and caption consistent with the visible state.

Sections can also declare `tutorials: ['tutorial-precision']` to render a labeled
“Watch” link beside the relevant instructions. Every destination must be an
existing article with an `animation`; the link opens its `#walkthrough` player.
This reuses all 15 captioned walkthroughs without duplicating or preloading movies
in the reference guides. Readers still choose when to play, and the destination
retains its written steps and practice download.

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

## Alignment tutorials

`src/docs/alignment-tutorials.ts` contains the method chooser and 15 separate
walkthroughs. Each numbered step is a section with its own screenshot, descriptive
alt text, caption, actions, expected result, and relevant recovery advice. The
`Alignment tutorials` sidebar group and links from the existing reference guides
make them discoverable. The directory is also linked from the documentation home.

The optional article `practiceScene` field renders a download link. Original,
subdivided block fixtures live in `public/docs/examples/`; these are valid legacy
JSON `.kitbash` scenes accepted by the normal importer. They contain the starting
geometry and transforms, not browser preferences or an in-progress tool operation.
All image assets are local, lazy-loaded, and use the existing image overlay.

To regenerate the fixtures and their 79 screenshots:

```sh
# With a development server running:
npm run docs:capture:alignment
# Capture one tutorial on another port:
DOCS_CAPTURE_URL=http://127.0.0.1:5188 npm run docs:capture:alignment -- --only=mate
```

The capture script imports each downloadable file through the workbench file
picker in a fresh headless Chrome context. UI controls choose methods and settings;
deterministic picks and brush hits call the same editor actions as pointer input.
The actual alignment, painting, pin, joint, and constraint solvers generate the
shown placements and residuals. It checks that operations apply successfully and
fails on page errors. No user tab, live MCP scene, or existing assembly is modified.
Screenshots are full-resolution WebP; no generated or mocked UI is used.

Keep screenshot numbers synchronized with tutorial steps. Re-run the documentation
browser suite to check every image and deep link, then inspect representative
screenshots and the rendered articles on desktop and at 320 pixels. Verify downloads
through the normal file importer as well as their HTTP responses. Do not treat a
reproducible screenshot as evidence of every physical miniature's fit quality.

## Animated tutorial walkthroughs

All 15 tutorials also have an opt-in MP4 walkthrough above the written steps. The
`animation` article field supplies its source, poster, WebVTT captions, and title.
`TutorialAnimation.tsx` uses native video decoding and controls, plus keyboard
accessible Play/Pause, Replay, and speed controls. There is no autoplay or looping;
`preload="none"` avoids downloading the movie until requested. Playback pauses when
scrolled out of view, the browser tab is hidden, or reduced motion is enabled.
Reduced-motion users can explicitly choose Play. Printed documentation retains the
illustrated steps and omits the video player.

Regenerate the animations with a development server, Chrome, and FFmpeg installed:

```sh
npm run docs:animate:alignment
DOCS_CAPTURE_URL=http://127.0.0.1:5188 npm run docs:animate:alignment -- --only=anchors
```

This runs the same actual editor actions as screenshot capture. Animation mode
leaves the existing images and practice downloads unchanged. The encoder in
`scripts/docs-animation.mjs` holds each numbered step, then inserts a two-second
motion replay between actual before/after poses. These replay frames are teaching
illustrations, not intermediate solver steps or a promise that a fitted movement
path is collision-free. Quaternion interpolation preserves the rigid shape; hard
pin and already connected joint rotations retain a stationary pivot along the
whole path. Anchor targets interpolate with their fitted part. The real achieved
scene is restored afterward. The user-facing caption explains the slowed replay.

MP4s use H.264/yuv420p at 1440 × 1000 and 24 fps with fast-start metadata. A strong
cubic-bezier(0.77, 0, 0.175, 1) ease-in-out makes pose changes legible. Local WebVTT
tracks name each step and motion replay; the full written walkthrough supplies the
more detailed description. Videos are silent and need no audio to follow. All
assets live in `public/docs/animations/`, and no animation library is required.

```sh
npx playwright test tests/e2e/documentation.spec.ts tests/e2e/documentation-animations.spec.ts
npm run build
```

The animation tests decode every movie, check timed captions, exercise playback,
pause, speed, replay and seeking, verify keyboard and reduced-motion behavior at
320 pixels, check that scrolling away pauses playback, and retain written
instructions/download access when a media request fails. Inspect a moving frame
and the final pose as well as the poster when reviewing a newly recorded clip.
