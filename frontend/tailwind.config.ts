import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          red:    '#ff0000',
          red2:   '#cc0000',
          accent: '#065fd4',
          surface:'#f2f2f2',
          muted:  '#606060',
          muted2: '#aaaaaa',
          border: '#e5e5e5',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
