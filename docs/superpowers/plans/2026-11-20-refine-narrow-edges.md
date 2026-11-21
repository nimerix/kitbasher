# Refine narrow edges implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Refine's edge solver find and cleanly cut edges on narrow lips, rims and borders, and under guides laid beside the edge, without creasing smooth surfaces or moving rivets.

**Architecture:** Five rule changes in the band classification (`src/core/refine-band.ts`) and one in the edge fit (`src/core/refine-edge.ts`). No new modules, types or UI. Each change was prototyped behind a switch on branch `spike/solver-narrow-lips` and measured on the two private reference scans; this plan lands them unconditionally, tests first, on synthetic fixtures.

**Tech stack:** TypeScript, three.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-scan-restoration-design.md`, section "Narrow flanks and guides laid beside the edge". Sections "How an edge is rebuilt" and "Anti-goals" also bind.

## Global constraints

- Lengths are mm. Existing thresholds in `refine-band.ts` keep their values: `flankRun` 3, `minBandAngle` 10, `minFlankFlatness` 2.2, `reachWidth` 0.35, `reachEdges` 6, `widestEstimate` 1, `minimumFlank` 12.
- The prototype is a reference to read, never to merge or cherry-pick: `git show 26df86c:<path>` (26df86c is the tip of `spike/solver-narrow-lips`). In it each change sits behind `spike('<name>', ...)`. Land the switched-on behaviour unconditionally. Nothing of `src/core/refine-trace.ts`, `spike(...)`, `trace(...)`, `buildCrestBand`, `crestSide`, `liftReach`, `solvableRuns`, `fillEnds`, `fillAny` or `snapAll` may land.
- An existing test's limit or expectation changes only where a task below says so. If another existing test fails, find the cause; do not loosen it. Report it if the cause is outside the task.
- Synthetic fixtures use `const scan = { step: 0.06, ripple: 0.01, noise: 0.006 }` unless a task says otherwise.
- New tests go in `tests/unit/refine-narrow-edges.test.ts`. Its fixture recipes and helpers (`outcome`, `line`, `chainOff`, `step`, `deg`) come from `git show 26df86c:tests/unit/refine-spike-fixtures.test.ts`, with the switch and trace plumbing removed: `outcome(model, input)` solves and applies once and returns `{ solved, pieces, skipped, folded, max, angle, fits, deviation, chain, out }`.
- Private data: the reference scans and anything derived from them (replay output, renders, crops) never enter the tracked tree and are never committed. Derived files go only under `S = .superpowers/sdd/2026-11-19-scan-restoration/solver-spike/` (git-ignored). Nothing is uploaded anywhere.
- Scan gate, run from the task's own worktree root: `node $S/scripts/replay.mjs <name>` then `node $S/scripts/gate.mjs <name>`. It prints one line per replayed guide: pieces, skipped, folded, largest move, or `refused`. A largest move may differ from the figure in a task by up to 0.002.
- Checks before every commit: `npx vitest run tests/unit/refine-` and `npm run format:check`. Before a task is reported done: `npm test`, `npm run build`, and the Refine e2e spec on the task's own strict port with `reuseExistingServer: false` (copy `.superpowers/sdd/2026-11-19-scan-restoration/pw-5388.config.ts` from the main checkout and change the port; never use `playwright.config.ts`, which reuses port 5173).
- Commit subjects: `(<type>) <Sentence-case summary>`. No AI, model or tool attribution, no trailers.
- Prettier: single quotes, trailing commas, 100 columns. Comments and docs: sentence case headers, no em dashes.

## Review focus

1. A guide between two parallel edges both within reach (a belt face 0.5 mm wide) - it should take the nearer edge every time, not one or the other by sampling. Test in Task 1.
2. A Width smaller than the guide's distance from the edge - the band no longer contains the guide's own vertices; it should solve or refuse cleanly, never throw or cut a broken chain. Test in Task 1.
3. A rivet right beside a narrow border - filling a slice must not move it. Test in Task 2.
4. A guide run again over its own result on a narrow wall - it should change nothing visible. Test in Task 2.
5. A straight edge on a noisy scan - a Line guide must stay a line. Test in Task 3.

---

### Task 1: Measure the width from the solved edge

**Files:**
- Modify: `src/core/refine-band.ts` (`classifyOriented`: the extent passed to `gather`, `result(cap)`, the `gathered` it returns; `estimateBand`)
- Modify: `src/core/refine-edge.ts` (export `seamMove`)
- Create: `tests/unit/refine-narrow-edges.test.ts`
- Modify: `tests/unit/refine-edge-path.test.ts`, `tests/unit/refine-edge.test.ts`, `tests/unit/refine-session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const seamMove = 0.006` from `refine-edge.ts`. `buildBand`, `estimateWidth`, `estimateBand` and `solveEdge` keep their signatures. `BandClassification.gathered` now means the largest Width, measured from the solved edge, that the classification covers.

- [ ] **Step 1: Write the failing tests** in `tests/unit/refine-narrow-edges.test.ts`, with the shared helpers.

```ts
describe('a guide laid beside the edge', () => {
  const edge = () =>
    modelOf(extrudedProfile([[-2, 0], [0, 0], [0, -2]], [0.08], 4, scan));

  it('finds a 90 degree edge from 0.28 mm onto one face at width 0.5', () => {
    const model = edge();
    const r = outcome(model, line(model, [-0.28, 0, -1.4], [-0.28, 0, 1.4], 0.5, 0.65));
    expect(r.solved && [r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
    expect(chainOff(r, [0, 0], 0.7)).toBeLessThan(0.03); // measured 0.017
  });

  it('estimates the same width on the crest and 0.2 mm beside it', () => {
    const { mesh, topology, noise } = edge();
    const at = (x: number) => [pointOn(mesh, [x, 0, -1.4]), pointOn(mesh, [x, 0, 1.4])];
    const on = estimateWidth(mesh, topology, 'line', at(-0.02), noise);
    const beside = estimateWidth(mesh, topology, 'line', at(-0.2), noise);
    expect(on).toBeGreaterThan(0);
    expect(Math.abs(beside - on)).toBeLessThan(0.06);
  });

  it('solves or refuses cleanly at a width under its distance from the edge', () => {
    const model = edge();
    const r = outcome(model, line(model, [-0.28, 0, -1.4], [-0.28, 0, 1.4], 0.2, 0.65));
    if (r.solved) expect([r.pieces, r.skipped, r.folded]).toEqual([1, 0, 0]);
  });

  it('takes the nearer of two edges 0.5 mm apart', () => {
    // A belt: a face 0.5 mm wide between a 90 degree edge at x = 0 and another at x = -0.5.
    for (const seed of [1, 2, 3]) {
      const m = modelOf(
        extrudedProfile([[-0.5, -2], [-0.5, 0], [0, 0], [0, -2]], [0.08, 0.08], 4, { ...scan, seed }),
      );
      const r = outcome(m, line(m, [-0.15, 0, -1.4], [-0.15, 0, 1.4], 0.4, 0.65));
      expect(r.solved).toBe(true);
      expect(chainOff(r, [0, 0], 0.7)).toBeLessThan(0.05);
    }
  });
});
```

The second and fourth tests are predictions, not spike measurements. If one fails against a correct implementation of Step 3, do not bend the code to it: report the measured values.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/refine-narrow-edges.test.ts`. Expected: the first fails (refused, `solved` false).

- [ ] **Step 3: Implement.** In `classifyOriented`:
  - `gather` reads out to `max((width ?? 0) + reachOf(edge), reachOf(edge) + seedStart * edge + spanOf(edge))`.
  - `result(cap)` keeps a vertex when `|o[i]| <= cap`, where `o` is its offset from the solved edge, instead of `band.g[i] <= cap`.
  - The returned `gathered` is `band.width - reach`.
  - `estimateBand`'s width is `min(widestEstimate, found.soft + max(2 * found.soft, 6 * found.edge))`, without `found.away`. Update the doc comments on `estimateWidth` and `buildBand` to say the width is measured from the solved edge.

- [ ] **Step 4: Settle the three existing tests this changes.** Take each change from `git diff fb84509 26df86c -- tests/unit/refine-edge-path.test.ts tests/unit/refine-edge.test.ts tests/unit/refine-session.test.ts`, without the trace plumbing:
  - `refine-edge-path.test.ts`, "closes the four-segment path on the box made with seed ...": limit `cornerLimit = 0.02 * Math.sqrt(3)` with its derivation comment, seeds 1, 2, 4, 5, 7, 8. The other 0.02 limits in the file stay.
  - `refine-edge.test.ts`, "moves a vertex beside one that stays ...": seeds 1 to 12 and the rim against `seamMove`, and the worst within a quarter of it.
  - `refine-session.test.ts`, "says one thing per Accept press ...": the failing guide becomes `surfacePoint([-1.2, 0, 1])` to `surfacePoint([1.2, 0, 1])` with its comment.

- [ ] **Step 5: Run.** `npx vitest run tests/unit/refine-`. Expected: all pass.

- [ ] **Step 6: Scan gate.** `node $S/scripts/replay.mjs task-1 && node $S/scripts/gate.mjs task-1`. Expected changes from the branch before this task: `57-1` solves in 3 pieces, `57-5` solves in 1 piece with 7 folded (max 0.1055), `57-13` solves in 1 piece (max 0.0142), `57-11` goes from 3 pieces to 2. `45-15` max 0.0342 and `45-23` max 0.0462, both 1 piece. Everything else as before. The 3 pieces and the 7 folded are fixed by Tasks 2 and 3.

- [ ] **Step 7: Commit.** `(fix) Measure a Refine edge's width from the solved edge`

### Task 2: Read flank runs between zone boundaries and fill slices without one

**Files:**
- Modify: `src/core/refine-band.ts` (`classifyOriented`: `split`, the code after the reseed loop, `result(cap)`)
- Modify: `tests/helpers/soft-edges.ts` (add `variedProfile`)
- Modify: `tests/unit/refine-narrow-edges.test.ts`

**Interfaces:**
- Consumes: Task 1's edge-relative `result(cap)`.
- Produces: `variedProfile(cornersAt: (z: number) => Vec2[], radii: number[], length: number, options?: SoftOptions, anchored = 0, lift?: (x: number, y: number, z: number) => number)` in `tests/helpers/soft-edges.ts`, as in `26df86c` with "Spike:" dropped from its comment.

- [ ] **Step 1: Write the failing tests.** Port fixtures A, H, I and J from `26df86c:tests/unit/refine-spike-fixtures.test.ts` into a `describe('a narrow flank')`, asserting only the outcome of the code as it will be:
  - "solves a groove wall of 0.20 to 0.30 mm straight run": for both plates (`[-2, 0]`, `[-2, -0.8]`), runs 0.20, 0.22, 0.24, 0.26, 0.28, 0.30, widths `null` and 0.45, strength 0.8: `[pieces, skipped, folded]` equals `[1, 0, 0]`.
  - "cuts in one piece past two rivets beside the edge and leaves them alone" (H): `[1, 0, 0]`, `chainOff(r, [0, 0], 1)` under 0.02 (measured 0.007), and every vertex 0.03 mm or more above the top face moves 0.
  - "cuts in one piece along a wall that narrows in two places, and in four" (I): `[1, 0, 0]` for both.
  - "refuses a wall that has its own flank in fewer than half of the slices" (J): `solved` false.
  - "changes nothing visible when run again over a narrow wall": fixture A, level plate, run 0.24, width 0.45, strength 1: solve and apply, then solve the same guide on the result (`modelFrom(out)`, as "changes nothing it made sharp when run again over its own result" in `refine-edge.test.ts` does) and apply: the largest move of the second pass is under 0.005.

- [ ] **Step 2: Run them.** Expected: A fails at runs 0.22 and 0.24 on the level plate (refused), H fails on pieces (6), I fails (2 pieces; four dips refused). J passes already.

- [ ] **Step 3: Implement,** following `26df86c:src/core/refine-band.ts`:
  - `result(cap)`: per side and slice, the run is `min(sides[s].end[k], sides[s].extent[k], cap) - sides[s].start[k]`, counted only where the slice has a flank (`end > start`), against `flankRun * edge`, needed in half of the slices.
  - `split(pair, solved, fill = false)`: with `fill`, a slice without a flank on a side takes `start` and `end` interpolated linearly from the nearest slices before and after it that have one, `end` capped at `max(extent, start)`. Only when at least half of that side's slices have their own flank, and never before the first or after the last slice that has one.
  - After the reseed loop, the evidence (reach, angle, flatness, soft, and the count and run tests in `result`) reads the classification each slice made itself. Only the zones returned from `result`, which decide what moves and what is cut, come from `split(fits, solved, true)`. See the `finish` helper in `26df86c`.

- [ ] **Step 4: Run.** `npx vitest run tests/unit/refine-`. Expected: all pass, including "refuses a width that leaves no sharp core" and "holds an open path at its corner joint and decides each free end for itself".

- [ ] **Step 5: Scan gate.** `task-2`. Expected changes from Task 1: `45-5` and `45-31` solve, 1 piece, 0 skipped, 0 folded, max 0.0548 and 0.0553. `57-1` 1 piece (max 0.0541). `57-3` solves, 1 piece (max 0.05). `57-31` 1 piece (max 0.0375). Everything else as after Task 1.

- [ ] **Step 6: Commit.** `(fix) Keep a Refine edge whole along a narrow flank`

### Task 3: Fit a Line guide's edge as an arc where it curves

**Files:**
- Modify: `src/core/refine-edge.ts` (`unbiasedFlanks`' `meetWith`, `solvePart`)
- Modify: `tests/unit/refine-narrow-edges.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: no public change. Inside `refine-edge.ts`, `meetWith` returns the kind it fitted and `solvePart` carries it in `Part.kind`.

- [ ] **Step 1: Write the failing tests** in a `describe('a line over an edge that curves')`:
  - "follows the rim of a cylinder of radius 5" (fixture E: `softCylinder(5, 1, 0.15, scan)`, Line guide between the two rim crest points 3.4 mm apart, width 0.52, strength 0.65): `[pieces, skipped, folded]` equals `[1, 0, 0]`, `deviation` under 0.01 (measured 0.0001), and every chain vertex in the middle half of the guide lies within 0.03 of radius 5 from the axis.
  - "stays a line on a straight edge of a rippled, noisy box": `softBox([2, 1.5, 1], 0.3, { step: 0.06, ripple: 0.02, noise: 0.01, seed })` for seeds 1 to 4, Line guide along the top front edge's crest from x = -1.6 to 1.6, automatic width: solves, and the chain's middle half lies within 0.02 of one straight line (largest distance from the line through its two end vertices).

- [ ] **Step 2: Run them.** Expected: E fails (1 piece but folded triangles, or deviation over 0.01).

- [ ] **Step 3: Implement** in `meetWith`: when the guide's kind is `line` and the meet has at least 9 points, measure `gap = largestGap(curve, band.drawn, meet.points, edge)`. If `gap > edge`, fit `fitCurve('arc', meet.points, 3, edge)`; keep the arc, and report the kind as `arc`, only when its own largest gap is under `gap / 2`. `solvePart` uses the returned kind from there on.

- [ ] **Step 4: Run.** `npx vitest run tests/unit/refine-`. Expected: all pass.

- [ ] **Step 5: Scan gate.** `task-3`. Expected change from Task 2: `57-5` 1 piece, 0 skipped, 0 folded, max 0.0411. Everything else as after Task 2.

- [ ] **Step 6: Commit.** `(fix) Follow a curved edge under a Refine line guide`

### Task 4: Let a flank start past the reach

**Files:**
- Modify: `src/core/refine-band.ts` (`classifyOriented`, the candidate search)
- Modify: `tests/unit/refine-band.test.ts`, `tests/unit/refine-narrow-edges.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: a named constant `seedReach = 2` in `refine-band.ts` (flank seeds may start up to `seedReach` times the reach from the guide).

- [ ] **Step 1: Write the failing tests** in a `describe('a wide rounding')`:
  - "finds a fin edge across a 0.27 mm round" (fixture D, guide at x = -0.295, width 0.48, strength 0.65): `[pieces, skipped, folded]` equals `[1, 0, 0]`, `angle` between 90 and 99 (measured 94.5), `chainOff(r, [0, 0], 0.5)` under 0.07 (measured 0.05).
  - "still refuses 1.2 mm onto the flat face" (fixture D, guide at x = -1.2): `solved` false.
  - "still refuses a line and an arc on a cylinder wall" (fixture G): both `solved` false.
  - In `refine-band.test.ts`, "finds no edge under a guide on a flat face": the first two cases stay. The third (`nearer`, 0.3 from the crest line) is moved into a new test "finds the edge from a clean face 0.3 mm beside it": `estimateWidth(...)` is greater than 0 and at most 1, and `buildBand(mesh, topology, 'line', nearer, 0.6, noise)` is not null with `angle` between 85 and 95.

- [ ] **Step 2: Run them.** Expected: the fin test and the new band test fail (refused).

- [ ] **Step 3: Implement.** In the candidate search, the loop over bins runs while `b * bin <= seedReach * reach`, and a seed counts as near enough when one of its vertices has `sign * u[i] <= seedReach * reach`. `reaches` is unchanged: the solved edge must still lie within `reach` of the guide in half of the slices.

- [ ] **Step 4: Run.** `npx vitest run tests/unit/refine-`. Expected: all pass.

- [ ] **Step 5: Scan gate.** `task-4`. Expected change from Task 3: `45-27` solves, 1 piece, 0 skipped, 0 folded, max 0.0573. `57-5` 1 piece, 0 skipped, 0 folded, max 0.0336. Everything else as after Task 3. Final state, for reference: refused are `45-1`, `45-3`, `45-13`, `45-17`, `45-19`, `45-29`, `57-17`; `57-11` stays 2 pieces with 21 skipped.

- [ ] **Step 6: Commit.** `(fix) Find a Refine edge across a rounding wider than the reach`

### Task 5: Check the result on the reference scans and bring the docs in line

**Files:**
- Modify: `src/docs/assembly-guides.ts`, `docs/superpowers/specs/2026-11-19-scan-restoration-design.md`
- Private output only: `$S/final/` (report and renders)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: `$S/final/REPORT.md`.

- [ ] **Step 1: Render.** Run the spike's render spec against this branch for every guide whose outcome changed and for the two kept edges (`git show 26df86c:tests/e2e/refine-spike.spec.ts` and `26df86c:pw-spike.config.ts` are the harness; copy them into the worktree untracked, with your own strict port, and delete them after). Before and after pairs go to `$S/final/compare/`. Judge each pair against the owner's reference photos (six PNGs kept outside the repository) and say plainly which look sharper, which show nothing, and which add a mark.

- [ ] **Step 2: Measure what the spike did not.** On both scans, for each guide that now solves: the mesh after Apply is closed under welding with no zero-area triangles; scene Undo restores the original geometry and Redo the edited one; the guide run again over its own result moves nothing by more than 0.005. Detect: the number of edge proposals on each scan before (branch `feature/scan-restoration` at `3399a81`) and after, at default settings. Time: the gate's total solve time before and after, and one preview update on each scan.

- [ ] **Step 3: Write `$S/final/REPORT.md`:** the gate table, the judgements, the measurements, and anything that got worse.

- [ ] **Step 4: Update the user guide** in `src/docs/assembly-guides.ts`:
  - Replace `Automatic width lets the tool estimate how far to either side of the guide it reads and rebuilds the surface.` with `Width is measured from the edge the tool finds, not from the guide. Automatic width lets the tool estimate how far to either side of that edge it reads and rebuilds the surface.`
  - Replace `A guide needs surface on both sides to work with. Lay it along the rounded edge itself. If the tool says no edge was found, move the guide onto the rounding or change Width. Narrow lips and rims often have too little surface on one side, and the tool then finds no edge there.` with `A guide needs surface on both sides to work with. Lay it along the rounded edge itself or close beside it. A line laid along an edge that curves follows the curve. If the tool says no edge was found, move the guide onto the rounding or change Width. A lip or rib rounded right over, with no flat top left, has no edge for the tool to find.`
  - Run `npx playwright test -c <your config> documentation.spec.ts`. Expected: pass.

- [ ] **Step 5: Update the spec.** In "Narrow flanks and guides laid beside the edge", replace the paragraph "Measured on the reference scans with the prototype." with the same statement measured on the build, from the report. In "Where the build falls short of this spec", revise the acceptance-test and "Why" bullets to match the report. State only what the report measured.

- [ ] **Step 6: Commit.** `(docs) Describe how Refine reads narrow edges`
