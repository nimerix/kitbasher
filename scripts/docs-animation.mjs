/** Offline MP4 encoder. Only the fresh documentation browser is changed during replays. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const fps = 24;
const movementSeconds = 2;
const holdSeconds = 3;

// Strong ease-in-out from the animate skill: cubic-bezier(0.77, 0, 0.175, 1).
function ease(progress) {
  const x = (t) => 3 * (1 - t) ** 2 * t * 0.77 + 3 * (1 - t) * t * t * 0.175 + t ** 3;
  let low = 0,
    high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    if (x(middle) < progress) low = middle;
    else high = middle;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) * t * t + t ** 3;
}
const time = (seconds) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);

export async function createAnimationCapture(page, output) {
  await run('ffmpeg', ['-version']);
  await mkdir(output, { recursive: true });
  let directory, slug, frames, cues, duration, motionFrames;
  const frame = async (png, seconds) => {
    const name = `frame-${String(frames.length).padStart(4, '0')}.png`;
    await writeFile(join(directory, name), png);
    frames.push({ name, seconds });
    duration += seconds;
  };
  const cue = (start, text) => cues.push({ start, end: duration, text });
  const clean = async () => {
    await page.evaluate(async () => {
      const { useEditor } = await import('/src/core/store.ts');
      const { clearNotifications } = await import('/src/core/activity.ts');
      useEditor.setState({ toast: null });
      clearNotifications();
      await document.fonts.ready;
    });
    await page.mouse.move(15, 15);
  };
  return {
    async start(id) {
      slug = id;
      directory = await mkdtemp(join(tmpdir(), 'kitbasher-animation-'));
      frames = [];
      cues = [];
      duration = 0;
      motionFrames = 0;
    },
    async still(png, title) {
      const start = duration;
      await frame(png, holdSeconds);
      cue(start, title);
    },
    async action(runAction, title) {
      await page.evaluate(async () => {
        const { useEditor } = await import('/src/core/store.ts');
        window.__tutorialBefore = useEditor.getState().scene;
      });
      await runAction();
      const changed = await page.evaluate(async () => {
        const { useEditor } = await import('/src/core/store.ts');
        const before = window.__tutorialBefore,
          after = useEditor.getState().scene;
        window.__tutorialMotion = { before, after };
        return after.parts.some((part) => {
          const previous = before.parts.find((p) => p.id === part.id);
          return (
            previous &&
            ['position', 'quaternion'].some((key) =>
              part[key].some((v, i) => Math.abs(v - previous[key][i]) > 1e-8),
            )
          );
        });
      });
      if (!changed) throw new Error(`The ${slug} demonstration did not move: ${title}`);
      await clean();
      // Settle any camera framing initiated by the action before rendering the replay.
      await page.waitForTimeout(450);
      const start = duration;
      try {
        for (let index = 0; index <= movementSeconds * fps; index++) {
          const progress = index / (movementSeconds * fps);
          await page.evaluate(async (amount) => {
            const { useEditor } = await import('/src/core/store.ts');
            const { Quaternion, Vector3 } = await import('/node_modules/.vite/deps/three.js');
            const { before, after } = window.__tutorialMotion;
            const parts = after.parts.map((part) => {
              const previous = before.parts.find((p) => p.id === part.id);
              if (!previous) return part;
              const q0 = new Quaternion(...previous.quaternion),
                q1 = new Quaternion(...part.quaternion);
              const q = q0.clone().slerp(q1, amount);
              let position = new Vector3(...previous.position).lerp(
                new Vector3(...part.position),
                amount,
              );
              // Preserve a real fixed pivot throughout a hard-pin or connected-joint rotation.
              const hard = previous.pins?.find((pin) => pin.kind === 'hard');
              const joint = before.joints.find(
                (j) => j.childId === part.id && j.keepConnected !== false,
              );
              const pivot = hard?.point ?? joint?.childAnchor ?? previous.pivot;
              if (pivot) {
                const scaled = new Vector3(...pivot).multiply(new Vector3(...part.scale));
                const fixed = scaled
                  .clone()
                  .applyQuaternion(q0)
                  .add(new Vector3(...previous.position));
                const final = scaled
                  .clone()
                  .applyQuaternion(q1)
                  .add(new Vector3(...part.position));
                if (fixed.distanceTo(final) < 1e-6) position = fixed.sub(scaled.applyQuaternion(q));
              }
              return {
                ...part,
                position: position.toArray(),
                quaternion: q.toArray(),
                anchors: part.anchors?.map((anchor) => {
                  const prior = previous.anchors?.find((a) => a.id === anchor.id);
                  return prior
                    ? {
                        ...anchor,
                        target: new Vector3(...prior.target)
                          .lerp(new Vector3(...anchor.target), amount)
                          .toArray(),
                      }
                    : anchor;
                }),
              };
            });
            useEditor.setState({ scene: { ...after, parts } });
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          }, ease(progress));
          await frame(await page.screenshot({ type: 'png', animations: 'disabled' }), 1 / fps);
          motionFrames++;
        }
        cue(start, `Motion replay: ${title}`);
      } finally {
        await page.evaluate(async () => {
          const { useEditor } = await import('/src/core/store.ts');
          useEditor.setState({ scene: window.__tutorialMotion.after });
          delete window.__tutorialBefore;
          delete window.__tutorialMotion;
        });
      }
    },
    async finish() {
      if (!frames.length || !motionFrames) throw new Error(`Missing animated frames for ${slug}`);
      try {
        // Paths here are generated frame names, never user input or shell-expanded strings.
        const list = frames
          .map(({ name, seconds }) => `file '${name}'\nduration ${seconds}`)
          .join('\n');
        await writeFile(join(directory, 'frames.txt'), `${list}\nfile '${frames.at(-1).name}'\n`);
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          join(directory, 'frames.txt'),
          '-t',
          duration.toFixed(6),
          '-an',
          '-vf',
          'fps=24',
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          join(output, `${slug}.mp4`),
        ]);
        const vtt =
          'WEBVTT\n\n' +
          cues
            .map(({ start, end, text }) => `${time(start)} --> ${time(end)}\n${text}`)
            .join('\n\n') +
          '\n';
        await writeFile(join(output, `${slug}.vtt`), vtt);
        console.log(`Encoded ${slug}: ${duration.toFixed(1)}s, ${motionFrames} animated frames`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async dispose() {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
