import { expect, test, type Page } from '@playwright/test';
import { alignmentTutorials } from '../../src/docs/alignment-tutorials';

const tutorialUrl = (slug: string) => `/docs/?guide=tutorial-${slug}`;
const player = (page: Page) => page.locator('.tutorial-animation');
async function play(page: Page) {
  await player(page).getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect
    .poll(() =>
      player(page)
        .locator('video')
        .evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0),
    )
    .toBe(true);
}

test('every alignment tutorial has a decodable local animation with timed step captions', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect(alignmentTutorials).toHaveLength(15);
  for (const article of alignmentTutorials) {
    await test.step(article.title, async () => {
      await page.goto(`/docs/?guide=${article.id}`);
      const video = player(page).locator('video');
      await expect(video).toHaveAttribute('poster', article.animation!.poster);
      await expect(video).toHaveAttribute('preload', 'none');
      expect(
        await video.evaluate((v: HTMLVideoElement) => ({
          paused: v.paused,
          autoplay: v.autoplay,
          loop: v.loop,
        })),
      ).toEqual({ paused: true, autoplay: false, loop: false });
      await play(page);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1440);
      const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
      expect(duration).toBeGreaterThan(15);
      expect(duration).toBeLessThan(30);
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.textTracks[0]?.cues?.length ?? 0))
        .toBeGreaterThan(article.sections.length);
      const cues = await video.evaluate((v: HTMLVideoElement) =>
        Array.from(v.textTracks[0].cues ?? []).map((cue) => ({
          start: cue.startTime,
          end: cue.endTime,
          text: (cue as VTTCue).text,
        })),
      );
      for (const section of article.sections)
        expect(cues.some((cue) => cue.text === section.title)).toBe(true);
      expect(cues.some((cue) => cue.text.startsWith('Motion replay:'))).toBe(true);
      expect(
        cues.every(
          (cue, i) =>
            cue.end > cue.start &&
            cue.end <= duration + 1 / 24 &&
            (!i || cue.start >= cues[i - 1].end),
        ),
      ).toBe(true);
      await player(page).getByRole('button', { name: 'Pause animation', exact: true }).click();
      // Different decoded frames within the same replay distinguish motion from a slideshow.
      const motion = cues.find((cue) => cue.text.startsWith('Motion replay:'))!;
      const fingerprints: number[] = [];
      for (const fraction of [0.25, 0.75]) {
        await video.evaluate(
          (v: HTMLVideoElement, t) => {
            v.currentTime = t;
          },
          motion.start + (motion.end - motion.start) * fraction,
        );
        await expect
          .poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2))
          .toBe(true);
        fingerprints.push(
          await video.evaluate((v: HTMLVideoElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = 72;
            canvas.height = 50;
            const context = canvas.getContext('2d')!;
            context.drawImage(v, 0, 0, 72, 50);
            return context
              .getImageData(0, 0, 72, 50)
              .data.reduce((hash, byte) => (hash * 31 + byte) >>> 0, 0);
          }),
        );
      }
      expect(fingerprints[0]).not.toBe(fingerprints[1]);
      const response = await page.request.get(`/docs/animations/${article.id.slice(9)}.mp4`);
      expect(response.ok()).toBe(true);
      expect(response.headers()['content-type']).toContain('video/mp4');
    });
  }
  expect(errors).toEqual([]);
});

test('plays, pauses, changes speed, scrubs, replays, and pauses when scrolled out of view', async ({
  page,
}) => {
  await page.goto(tutorialUrl('point-to-point'));
  const video = player(page).locator('video');
  await play(page);
  await player(page).getByLabel('Animation playback speed').selectOption('0.5');
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(0.5);
  await player(page).getByRole('button', { name: 'Pause animation', exact: true }).click();
  const paused = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(250);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(paused);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 12;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(12, 1);
  await player(page).getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(2);
  await expect(
    player(page).getByRole('button', { name: 'Pause animation', exact: true }),
  ).toBeVisible();
  await page.locator('#step-5').scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.locator('.related-guides a[href="?guide=tutorial-multi-point"]').click();
  await expect(player(page).locator('video')).toHaveAttribute(
    'src',
    './animations/multi-point.mp4',
  );
  expect(
    await player(page)
      .locator('video')
      .evaluate((v: HTMLVideoElement) => v.paused && v.currentTime === 0),
  ).toBe(true);
});

test('keeps reduced-motion playback opt-in and supports keyboard controls at 320 pixels', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.mp4')) mediaRequests.push(request.url());
  });
  await page.goto(tutorialUrl('soft-pins'));
  await expect(player(page).getByText(/Reduced motion is on/)).toBeVisible();
  await player(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mediaRequests).toEqual([]);
  const video = player(page).locator('video');
  const start = player(page).getByRole('button', { name: 'Play animation', exact: true });
  await start.focus();
  await start.press('Enter');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0))
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(
    player(page).getByRole('button', { name: 'Play animation', exact: true }),
  ).toBeVisible();
});

test('keeps written instructions and downloads available when an animation fails', async ({
  page,
}) => {
  await page.route('**/animations/point-to-point.mp4', (route) => route.abort());
  await page.goto(tutorialUrl('point-to-point'));
  await player(page).getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect(player(page).getByRole('alert')).toContainText('could not be played');
  await expect(
    player(page).getByRole('link', { name: 'Download animation (MP4)', exact: true }),
  ).toHaveAttribute('href', './animations/point-to-point.mp4');
  await expect(page.locator('main .article-section .figure-trigger')).toHaveCount(5);
  await expect(page.locator('#step-1 h2')).toHaveText(/Choose the moving part and method/);
});
