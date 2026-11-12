'use client';
// 2D animated teacher portrait. It is an illustration, not a 3D model:
// breathing, head sway, blinking and a speech-driven mouth are applied as CSS
// transforms/overlays on top of one still image. Driven by the same state
// logic and the same viseme timeline as the 3D avatar.
import { useEffect, useRef } from 'react';
import { AvatarPoseDriver, AvatarState } from '@/lib/avatar/avatar-state';
import { MouthWeights } from '@/lib/avatar/lip-sync';
import { PORTRAIT_IMAGE_URL, PORTRAIT_LAYOUT, PORTRAIT_LAYOUT as L } from '@/lib/avatar/config';

export interface PortraitAvatarProps {
  state: AvatarState;
  getMouth: () => MouthWeights;
  onStatus: (s: 'loading' | 'ready' | 'error', detail?: string) => void;
  imageUrl?: string;
  /** extra zoom toward the face (1 = whole crop); used for the small chat-column stage */
  zoom?: number;
  /** no backdrop colour (the parent paints the stage) */
  transparent?: boolean;
}

// Jaw layer mask: everything below the lip line, feathered at the sides so the
// shifted chin blends into the unmoved cheeks.
const JAW_MASK = [
  `linear-gradient(to bottom, transparent ${PORTRAIT_LAYOUT.mouth.y - 0.4}%, #000 ${PORTRAIT_LAYOUT.mouth.y + 2.4}%)`,
  `radial-gradient(ellipse 21% 38% at ${PORTRAIT_LAYOUT.mouth.x}% ${PORTRAIT_LAYOUT.mouth.y + 11}%, #000 55%, transparent 100%)`,
].join(', ');

// clamp() drove the eyelid and mouth overlays, which are no longer drawn.

export default function PortraitAvatar({ state, getMouth, onStatus, imageUrl = PORTRAIT_IMAGE_URL, zoom = 1, transparent = false }: PortraitAvatarProps) {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const stageRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const jawRef = useRef<HTMLDivElement>(null);
  const layered = !!(L.headUrl && L.bodyUrl && imageUrl === L.url);
  const layeredRef = useRef(layered);
  layeredRef.current = layered;
  const mouthRef = useRef<HTMLDivElement>(null);
  const lidLRef = useRef<HTMLDivElement>(null);
  const lidRRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const mouthFnRef = useRef(getMouth);
  stateRef.current = state;
  mouthFnRef.current = getMouth;

  useEffect(() => {
    const driver = new AvatarPoseDriver(20260102, false);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const pose = driver.update(dt, stateRef.current, mouthFnRef.current());

      // Layered portrait: the body stays still (only a tiny breathing scale) and the
      // head pivots at the neck. Single image: the whole picture moves together.
      const breath = Math.sin(now / 1000 * (2 * Math.PI / 4.2));
      const tx = pose.head.yaw * L.moveYawPx;
      const ty = pose.head.pitch * L.movePitchPx + breath * 0.8;
      const rot = pose.head.roll * L.rollDegPerRad;
      const stage = stageRef.current;
      if (layeredRef.current) {
        // The head is a cut-out laid over a body image. Letting it drift and
        // rotate on its own pulled it off the shoulders, which is what made the
        // portrait look like two pictures stacked. The whole stage still
        // breathes, so the figure is not frozen; the head simply stays put.
        if (stage) stage.style.transform = `scale(${((1.02 * zoomRef.current) + breath * 0.003).toFixed(4)})`;
        const head = headRef.current;
        if (head) head.style.transform = 'translate(0px, 0px) rotate(0deg)';
      } else if (stage) {
        // Idle means idle: a photograph drifting left and right on its own,
        // while nobody is talking to it, is the thing that looks wrong. The
        // picture is held exactly still unless the tutor is listening,
        // thinking or speaking.
        if (stateRef.current === 'IDLE') {
          stage.style.transform = `scale(${(1.02 * zoomRef.current).toFixed(4)})`;
        } else {
          stage.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${rot.toFixed(3)}deg) scale(${((1.02 * zoomRef.current) + breath * 0.004).toFixed(4)})`;
        }
      }

      // Nothing is drawn on top of the face any more. The eyelid ovals and the
      // mouth patch were tuned against the old head crop; on the full
      // photograph they would land in the wrong place, and both read as shapes
      // stuck on a picture in the first place. The portrait breathes and sways
      // as a whole, which is movement the photograph can actually carry, and
      // the status chip beside it says when the tutor is speaking.
      if (lidLRef.current) lidLRef.current.style.opacity = '0';
      if (lidRRef.current) lidRRef.current.style.opacity = '0';
      if (mouthRef.current) mouthRef.current.style.opacity = '0';
      if (jawRef.current) jawRef.current.style.transform = 'translateY(0%)';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pos = (x: number, y: number) => ({ left: `${x}%`, top: `${y}%` });

  return (
    <div className={`w-full h-full overflow-hidden relative ${transparent ? '' : 'bg-slate-200'}`}>
      <div ref={stageRef} className="absolute inset-0 will-change-transform" style={{ transformOrigin: zoom > 1 ? '50% 36%' : '50% 78%' }}>
        {layered && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={L.bodyUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover select-none" />
          </>
        )}
        <div
          ref={headRef}
          className="absolute inset-0"
          style={{ transformOrigin: `${L.headPivot.x}% ${L.headPivot.y}%` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={layered ? L.headUrl : imageUrl}
            alt=""
            draggable={false}
            onLoad={() => onStatus('ready')}
            onError={() => onStatus('error', 'Portrait image missing')}
            className="w-full h-full object-cover select-none"
          />
        {/* eyelids (blink) */}
        {L.blink && [{ ...L.eyeLeft, skin: L.eyelidLeft }, { ...L.eyeRight, skin: L.eyelidRight }].map((e, i) => (
          <div
            key={i}
            ref={i === 0 ? lidLRef : lidRRef}
            className="absolute rounded-[50%]"
            style={{
              ...pos(e.x, e.y),
              width: `${L.eyeWidthPct}%`, height: `${L.eyeHeightPct}%`,
              background: `linear-gradient(${e.skin.top}, ${e.skin.bottom})`,
              transform: 'translate(-50%, -50%) scaleY(0)', transformOrigin: '50% 0%',
              boxShadow: `0 0 3px 2px ${e.skin.bottom}`,
            }}
          />
        ))}
          {/* lower face: same head image, masked to the chin/beard area, drops while speaking */}
          {layered && (
            <div
              ref={jawRef}
              className="absolute inset-0 pointer-events-none"
              style={{
                WebkitMaskImage: JAW_MASK, maskImage: JAW_MASK,
                WebkitMaskComposite: 'source-in', maskComposite: 'intersect',
              } as React.CSSProperties}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={L.headUrl} alt="" draggable={false} className="w-full h-full object-cover select-none" />
            </div>
          )}
        {/* mouth cavity: drawn above the jaw so the opening shows between the lips */}
        <div
          ref={mouthRef}
          className="absolute rounded-[50%]"
          style={{
            ...pos(L.mouth.x, L.mouth.y),
            width: `${L.mouthWidthPct}%`, height: `${L.mouthMaxOpenPct}%`,
            background: `radial-gradient(ellipse at 50% 35%, ${L.mouthInner} 55%, #1d0807 100%)`,
            border: `1.5px solid ${L.lipEdge}`,
            opacity: 0, transform: 'translate(-50%, -30%) scale(1, 0.15)', transformOrigin: '50% 0%',
          }}
        />
        </div>
      </div>
    </div>
  );
}
