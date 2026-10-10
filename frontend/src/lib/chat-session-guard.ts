// Keeps "which chat session may be used right now" correct while the student
// switches lectures and async session loads are still in flight.
//
// A chat session belongs to exactly one lecture. The old hook kept a bare
// session id in a ref that was only overwritten once the NEW lecture's
// sessions had loaded, so (a) a message sent in that window went out with the
// previous lecture's session id, and (b) a slow response for the previous
// lecture could land after the switch and become the active session again.
//
// This guard fixes both with two rules, kept free of React so they can be
// unit-tested directly (see chat-session-guard.test.ts):
//  1. begin(lectureId) clears the active session immediately and invalidates
//     every token handed out earlier — async work started for an older
//     lecture can no longer activate anything.
//  2. A session id is only ever handed out for the lecture it was activated
//     for (sessionFor), so even a stale id cannot be used for another lecture.
export class ChatSessionGuard {
  private epoch = 0;
  private lectureId: number | null = null;
  private sessionId: number | null = null;

  /** Call when the selected lecture changes (and on mount). Returns the token async work must present. */
  begin(lectureId: number): number {
    this.epoch += 1;
    this.lectureId = lectureId;
    this.sessionId = null;
    return this.epoch;
  }

  /** True while no newer begin() has happened since `token` was issued. */
  isCurrent(token: number): boolean {
    return token === this.epoch;
  }

  /** Token for work started now, within the lecture already selected via begin(). */
  currentToken(): number {
    return this.epoch;
  }

  /** Makes `sessionId` the active session — only if `token` is still current. Returns whether it was applied. */
  activate(token: number, sessionId: number): boolean {
    if (!this.isCurrent(token)) return false;
    this.sessionId = sessionId;
    return true;
  }

  /** The session id that may be used for `lectureId`, or null (no session yet, still loading, or wrong lecture). */
  sessionFor(lectureId: number): number | null {
    return this.lectureId === lectureId ? this.sessionId : null;
  }

  /** The active session id for the currently selected lecture, if any. */
  activeSessionId(): number | null {
    return this.sessionId;
  }
}
