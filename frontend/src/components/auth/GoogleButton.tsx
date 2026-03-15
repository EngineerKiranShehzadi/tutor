export const GoogleButton = () => (
  <button
    type="button"
    className="w-full py-2.5 px-4 bg-white border-[1.5px] border-[var(--border)] rounded-lg text-sm font-semibold flex items-center justify-center gap-2.5 hover:bg-[var(--surface)] transition-colors"
  >
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.1 0 5.9 1.1 8.1 2.9l6-6C34.5 3.1 29.5 1 24 1 14.6 1 6.7 6.6 3.1 14.5l7 5.4C11.9 13.9 17.4 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.3 37.5 46.5 31.5 46.5 24.5z"/>
      <path fill="#FBBC05" d="M10.1 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7-5.4C1.5 17.1.5 20.4.5 24s1 6.9 2.6 9.9l7-5.3z"/>
      <path fill="#34A853" d="M24 46.5c5.5 0 10.1-1.8 13.4-4.9l-7.5-5.8c-1.9 1.3-4.3 2-5.9 2-6.5 0-12-4.4-14-10.4l-7 5.4C6.7 41.4 14.6 46.5 24 46.5z"/>
    </svg>
    Continue with Google
  </button>
);
