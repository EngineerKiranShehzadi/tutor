// Displayed agent identity for a lecture. Uses the existing frontend
// lecture -> agent mapping (LECTURES in lib/constants.ts, keyed by YouTube
// video id — the same mapping the seed script uses), so no database ids are
// hardcoded and no new agent routing is introduced. The *real* agent selection
// still happens server-side from lecture_id.
import { LECTURES } from '../constants';

export const DEFAULT_AGENT_NAME = 'AI Tutor';

export const resolveAgentName = (youtubeVideoId?: string | null): string =>
  (youtubeVideoId ? LECTURES.find(l => l.videoId === youtubeVideoId)?.agentName : undefined) ?? DEFAULT_AGENT_NAME;
