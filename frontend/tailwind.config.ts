import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // The same values as the CSS variables in globals.css. These two files
      // used to disagree: one said indigo, the other blue.
      colors: {
        brand: {
          accent:     '#1f3a5f',
          accentDeep: '#16293f',
          accentSoft: '#e8edf3',
          accentDim:  '#8fb0d0',
          gold:       '#a35f0d',
          goldSoft:   '#fbf1e2',
          ink:        '#161a1f',
          page:       '#f5f4f1',
          surface:    '#faf9f7',
          muted:      '#5f6068',
          muted2:     '#8e8e92',
          border:     '#e5e3df',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      // The seven allowed sizes. Named so they do not override Tailwind's own
      // text-sm / text-xs and silently resize existing screens.
      fontSize: {
        display: ['34px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        h1:      ['26px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        h2:      ['20px', { lineHeight: '1.3',  letterSpacing: '-0.01em' }],
        h3:      ['17px', { lineHeight: '1.4' }],
        body:    ['16px', { lineHeight: '1.6' }],
        label:   ['14px', { lineHeight: '1.4' }],
        caption: ['13px', { lineHeight: '1.45' }],
      },
      // Two radii with a job each; chips use rounded-full.
      borderRadius: { control: '8px', card: '14px' },
    },
  },
  plugins: [],
};

export default config;
