import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // The same values as the CSS variables in globals.css. These two files
      // used to disagree: one said indigo, the other blue.
      colors: {
        brand: {
          accent:     '#15664f',
          accentDeep: '#0e4a39',
          accentSoft: '#e7f0eb',
          accentDim:  '#74c4a4',
          gold:       '#9a6b12',
          goldSoft:   '#f6efdd',
          ink:        '#15201c',
          page:       '#f1f3ef',
          surface:    '#f7f8f6',
          muted:      '#5c6661',
          muted2:     '#99a39d',
          border:     '#e2e5e1',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      // The seven allowed sizes. Named so they do not override Tailwind's own
      // text-sm / text-xs and silently resize existing screens.
      fontSize: {
        display: ['40px', { lineHeight: '1.1',  letterSpacing: '-0.02em' }],
        h1:      ['30px', { lineHeight: '1.2',  letterSpacing: '-0.015em' }],
        h2:      ['22px', { lineHeight: '1.3',  letterSpacing: '-0.01em' }],
        h3:      ['18px', { lineHeight: '1.4' }],
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
