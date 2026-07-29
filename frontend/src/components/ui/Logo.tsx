interface Props {
  variant?: 'dark' | 'light';
  /**
   * full    — icon + "AskAI" + "TUTOR"  (default, all contexts)
   * compact — icon + "AskAI" only       (narrow headers, compact sidebars)
   * icon    — icon only                 (favicon, avatar, micro-spaces)
   */
  size?: 'full' | 'compact' | 'icon';
  className?: string;
}

/**
 * AskAI Tutor — inline SVG logo, fully transparent background.
 *
 * variant="dark"   white / sky-blue wordmark   dark backgrounds (sidebar, auth, landing)
 * variant="light"  slate / brand-blue wordmark  light backgrounds (student navbar)
 *
 * Icon concept — "Neural A":
 *   Five nodes arranged as the letter A:
 *     · Apex   (23, 12) — top of A
 *     · Hub    (23, 22) — crossbar intersection, main AI processing node
 *     · CL     (17.3, 22) — crossbar left endpoint
 *     · CR     (28.7, 22) — crossbar right endpoint
 *     · BL     (11, 33)   — bottom-left foot
 *     · BR     (35, 33)   — bottom-right foot
 *   Traces connect hub to all peripheral nodes plus a crossbar through hub.
 *   Primary read: AI neural network.  Secondary read: "A" brand monogram for AskAI.
 */
export const Logo = ({ variant = 'dark', size = 'full', className = '' }: Props) => {
  const textMain   = variant === 'dark' ? '#ffffff' : '#0f172a';
  const textAccent = variant === 'dark' ? '#93c5fd' : '#065fd4';

  // ViewBox width tightens for compact and icon variants
  const vbW = size === 'icon' ? 46 : size === 'compact' ? 148 : 158;

  return (
    <svg
      viewBox={`0 0 ${vbW} 52`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="AskAI Tutor"
    >
      <defs>
        {/* Brand gradient — blue #065fd4 → indigo #4f46e5 */}
        <linearGradient id="lg-askai" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#065fd4" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>

        {/* Inner depth — top-left radial glow for glass/depth feel */}
        <radialGradient id="rg-askai" cx="28%" cy="22%" r="58%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.22" />
          <stop offset="100%" stopColor="white" stopOpacity="0"    />
        </radialGradient>
      </defs>

      {/* ─── ICON ──────────────────────────────────────────── */}

      {/* Base rounded square */}
      <rect x="1" y="4" width="44" height="44" rx="11" fill="url(#lg-askai)" />
      {/* Depth overlay */}
      <rect x="1" y="4" width="44" height="44" rx="11" fill="url(#rg-askai)" />

      {/* ── Neural "A" traces — rendered below nodes ── */}

      {/* Hub (23,22) → Apex (23,12) — vertical stem, upper half of A */}
      <line
        x1="23" y1="19.4" x2="23" y2="14.5"
        stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.5"
      />
      {/* Hub (23,22) → Bottom-left (11,33) — left leg of A */}
      <line
        x1="21.1" y1="23.8" x2="12.6" y2="31.5"
        stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.45"
      />
      {/* Hub (23,22) → Bottom-right (35,33) — right leg of A */}
      <line
        x1="24.9" y1="23.8" x2="33.4" y2="31.5"
        stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.45"
      />
      {/* Crossbar — horizontal bar of A, passes through hub (slightly higher opacity) */}
      <line
        x1="17.3" y1="22" x2="28.7" y2="22"
        stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.6"
      />

      {/* ── Hub: A-crossbar centre, primary AI node ── */}
      {/* Outer pulse ring */}
      <circle cx="23" cy="22" r="6.2" fill="white" fillOpacity="0.06" />
      {/* Inner ring */}
      <circle cx="23" cy="22" r="4.2" fill="white" fillOpacity="0.1"  />
      {/* Core dot */}
      <circle cx="23" cy="22" r="2.7" fill="white" fillOpacity="0.96" />

      {/* ── Peripheral nodes ── */}
      {/* Apex — brightest, marks the top of the A */}
      <circle cx="23"   cy="12" r="2.6" fill="white" fillOpacity="0.92" />
      {/* Crossbar endpoints — slightly smaller, mark A crossbar width */}
      <circle cx="17.3" cy="22" r="1.6" fill="white" fillOpacity="0.68" />
      <circle cx="28.7" cy="22" r="1.6" fill="white" fillOpacity="0.68" />
      {/* Foot nodes */}
      <circle cx="11"   cy="33" r="2.2" fill="white" fillOpacity="0.72" />
      <circle cx="35"   cy="33" r="2.2" fill="white" fillOpacity="0.72" />

      {/* ─── WORDMARK ──────────────────────────────────────── */}

      {/* "AskAI" — primary identity, max weight */}
      {size !== 'icon' && (
        <text
          x="57"
          y="27"
          fontFamily="'Segoe UI', system-ui, -apple-system, sans-serif"
          fontSize="22"
          fontWeight="800"
          fill={textMain}
        >
          AskAI
        </text>
      )}

      {/* "TUTOR" — brand qualifier, tracked caps, accent colour */}
      {size === 'full' && (
        <text
          x="58"
          y="43"
          fontFamily="'Segoe UI', system-ui, -apple-system, sans-serif"
          fontSize="13"
          fontWeight="700"
          fill={textAccent}
          style={{ letterSpacing: '3px' }}
        >
          TUTOR
        </text>
      )}
    </svg>
  );
};
