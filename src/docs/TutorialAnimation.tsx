import { useEffect, useId, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { DocAnimation } from './types';

/** Native media decoding/controls; no animation runtime or autoplay. */
export function TutorialAnimation({ animation }: { animation: DocAnimation }) {
  const video = useRef<HTMLVideoElement>(null);
  const caption = useId();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState('1');
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = video.current;
    if (!media) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      setReducedMotion(preference.matches);
      if (preference.matches) media.pause();
    };
    updatePreference();
    preference.addEventListener('change', updatePreference);
    const hide = () => {
      if (document.hidden) media.pause();
    };
    document.addEventListener('visibilitychange', hide);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) media.pause();
    });
    observer.observe(media);
    return () => {
      media.pause();
      observer.disconnect();
      preference.removeEventListener('change', updatePreference);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  const play = async (restart = false) => {
    const media = video.current;
    if (!media) return;
    if (restart) media.currentTime = 0;
    try {
      await media.play();
    } catch (error) {
      // Pausing, leaving the page, or changing a source can interrupt play normally.
      if (video.current === media && (error as DOMException).name !== 'AbortError') setFailed(true);
    }
  };

  return (
    <figure className="tutorial-animation" aria-label={animation.title}>
      <div className="tutorial-animation-toolbar">
        <strong>Watch the walkthrough</strong>
        <div className="tutorial-animation-actions">
          <button
            type="button"
            disabled={failed}
            onClick={() => (playing ? video.current?.pause() : void play())}
          >
            {playing ? (
              <Pause size={14} aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            {playing ? 'Pause animation' : 'Play animation'}
          </button>
          <button type="button" disabled={failed} onClick={() => void play(true)}>
            <RotateCcw size={14} aria-hidden="true" /> Replay
          </button>
          <label>
            Speed
            <select
              aria-label="Animation playback speed"
              value={speed}
              onChange={(event) => {
                setSpeed(event.target.value);
                if (video.current) video.current.playbackRate = Number(event.target.value);
              }}
            >
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="1.5">1.5×</option>
            </select>
          </label>
        </div>
      </div>
      <video
        ref={video}
        src={animation.src}
        poster={animation.poster}
        controls
        playsInline
        muted
        preload="none"
        width={1440}
        height={1000}
        tabIndex={0}
        aria-label={animation.title}
        aria-describedby={caption}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedData={() => setFailed(false)}
        onError={() => setFailed(true)}
      >
        <track
          kind="captions"
          src={animation.captions}
          srcLang="en"
          label="Step captions"
          default
        />
        Read the illustrated steps below if your browser cannot play this animation.
      </video>
      <figcaption id={caption}>
        {failed && (
          <p role="alert">
            The animation could not be played. Download it or follow the illustrated steps below.
          </p>
        )}
        {reducedMotion && <p>Reduced motion is on. Playback starts only when you choose Play.</p>}
        <p>
          A silent walkthrough of the practice scene, with step captions. Movement between fitted
          poses is slowed down to explain the change; applying a fit in the workbench is one edit.
          Use the timeline to inspect a moment, or follow the written steps below.
        </p>
        <a href={animation.src} download>
          Download animation (MP4)
        </a>
      </figcaption>
    </figure>
  );
}
