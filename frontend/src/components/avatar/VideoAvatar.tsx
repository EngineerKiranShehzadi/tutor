'use client';
import { useEffect, useRef } from 'react';

/**
 * The tutor's face, as a short silent clip of the course presenter.
 *
 * What came before this was a photograph with shapes drawn on top of it: two
 * coloured ovals for eyelids and a dark ellipse for the mouth, moved by the
 * lip-sync data. However they were sized or timed, they read as parts stuck
 * onto a picture, because that is what they were.
 *
 * Real footage of a person talking needs none of that. While the tutor is
 * speaking the clip plays and loops; the rest of the time it is paused on its
 * first frame, which is also the poster image, so a student sees one still
 * portrait that starts talking and then settles back to exactly the same pose.
 *
 * The clip carries no audio — the spoken answer comes from speech synthesis,
 * and a second voice underneath it would be unusable.
 */
interface VideoAvatarProps {
  /** IDLE | LISTENING | THINKING | SPEAKING | ERROR */
  state: string;
  /** Rounded by the parent; this fills whatever box it is given. */
  className?: string;
}

const CLIP_URL  = '/avatar/teacher-speaking.mp4';
const STILL_URL = '/avatar/teacher-still.jpg';

export default function VideoAvatar({ state, className = '' }: VideoAvatarProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (state === 'SPEAKING') {
      // play() rejects if the browser blocks autoplay. The clip is muted, which
      // every browser allows, but a rejection still must not throw into React.
      void video.play().catch(() => {});
      return;
    }

    video.pause();
    // Back to the opening frame, so the paused portrait is always the same one
    // rather than whatever half-formed mouth shape the clip stopped on.
    try { video.currentTime = 0; } catch { /* not seekable yet */ }
  }, [state]);

  return (
    <video
      ref={videoRef}
      className={`w-full h-full object-cover select-none pointer-events-none ${className}`}
      src={CLIP_URL}
      poster={STILL_URL}
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
    />
  );
}
