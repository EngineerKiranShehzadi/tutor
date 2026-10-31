// The access token lives only in this module's memory — never in localStorage,
// where any script on the page (an XSS payload included) could read it. A page
// reload starts with no token; the httpOnly refresh cookie, which scripts
// cannot read, gets a fresh one through refreshAccessToken().

let accessToken: string | null = null;

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null): void => { accessToken = token; };

// Older builds kept the token in localStorage; make sure no copy is left behind.
if (typeof window !== 'undefined') {
  try { localStorage.removeItem('accessToken'); } catch { /* storage unavailable */ }
}

let inFlight: Promise<string | null> | null = null;

const callRefresh = (): Promise<Response> =>
  fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ''}/auth/refresh-token`, {
    method: 'POST',
    credentials: 'include',
  });

// Exchanges the refresh cookie for a new access token. Every caller (axios,
// Apollo, the chat stream, AuthProvider) shares one in-flight request, because
// each refresh rotates the cookie and a second parallel one would present the
// already-rotated token. 409 means another tab won that race a moment ago and
// the browser already holds its new cookie, so retry once.
export const refreshAccessToken = (): Promise<string | null> => {
  if (!inFlight) {
    inFlight = (async () => {
      try {
        let res = await callRefresh();
        if (res.status === 409) {
          await new Promise(r => setTimeout(r, 300));
          res = await callRefresh();
        }
        if (!res.ok) { accessToken = null; return null; }
        const json = await res.json();
        accessToken = (json?.data?.accessToken as string | undefined) ?? null;
        return accessToken;
      } catch {
        return null;
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
};
