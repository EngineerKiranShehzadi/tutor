// Content-Security-Policy (A13). React already escapes what it renders; this
// is the backstop if something ever slips through: scripts, styles, fonts,
// images, frames and network calls may only come from the origins this app
// actually uses, plugins are off, and the page cannot be framed.
//   - API (REST, GraphQL, SSE): the origin of NEXT_PUBLIC_API_URL
//   - FontAwesome CSS + fonts: cdnjs.cloudflare.com
//   - lecture videos: youtube.com iframes; thumbnails: i.ytimg.com
//   - Google profile pictures: lh3.googleusercontent.com
//   - avatar textures, recorded audio and CSV downloads: blob:/data: URLs
// 'unsafe-inline' scripts are needed by Next.js's inline bootstrap scripts
// (a nonce would make every page dynamic); 'unsafe-eval' and the dev-server
// websocket are allowed in development only.
const isDev = process.env.NODE_ENV !== 'production';

const apiOrigin = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_API_URL ?? '').origin; } catch { return ''; }
})();

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https://i.ytimg.com https://lh3.googleusercontent.com",
  `connect-src 'self' data: blob:${apiOrigin ? ` ${apiOrigin}` : ''}${isDev ? ' ws: wss:' : ''}`,
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy',   value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'X-Frame-Options',           value: 'DENY' },
          { key: 'X-XSS-Protection',          value: '1; mode=block' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
