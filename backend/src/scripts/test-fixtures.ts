/**
 * Self-contained DB fixtures for test scripts that need a user and/or a chat-ready
 * lecture, so they run green on an empty database instead of skipping (or
 * borrowing whatever row happens to exist). Everything created here has a
 * unique name and is removed by the matching cleanup function.
 */
import { createHash, randomBytes } from 'crypto';
import * as XLSX from 'xlsx';
import { query } from '../config/database';
import { prepareDatasetVersion, finishDatasetVersion } from '../services/dataset-version.service';

const EMBED_DIMS = 1024;

export type FixtureRole = 'STUDENT' | 'ADMIN';

const uniq = (): string => `${Date.now()}-${randomBytes(4).toString('hex')}`;

export async function createTestUser(role: FixtureRole): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, is_verified, role)
     VALUES ($1, $2, 'x', TRUE, $3) RETURNING id`,
    [`Fixture ${role}`, `fixture-${role.toLowerCase()}-${uniq()}@example.test`, role],
  );
  return rows[0].id;
}

export async function deleteTestUsers(ids: string[]): Promise<void> {
  if (ids.length) await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
}

// Deterministic unit vector derived from the text (no embedding server needed).
const fakeEmbed = async (text: string): Promise<number[]> => {
  let seed = createHash('sha256').update(text).digest().readUInt32LE(0);
  const v = Array.from({ length: EMBED_DIMS }, () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  });
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map(x => x / n);
};

/**
 * A lecture the chat gates accept: status READY, an active agent profile, and an
 * active dataset version whose chunks are all embedded with the current model.
 */
export async function createReadyLecture(chunkCount = 3): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO lectures (title, youtube_url, youtube_video_id)
     VALUES ($1, 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`,
    [`[fixture] ${uniq()}`],
  );
  const lectureId = rows[0].id;
  try {
    const qa = Array.from({ length: chunkCount }, (_, i) => ({
      question: `What does fixture concept number ${i + 1} mean?`,
      answer: `Fixture concept ${i + 1} means something specific and unique: ${'detail '.repeat(10)}${i + 1}.`,
      keywords: `kw${i + 1}`,
    }));
    const ws = XLSX.utils.json_to_sheet(qa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const prep = await prepareDatasetVersion(lectureId, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    if (prep.kind !== 'CREATED') throw new Error(`fixture dataset not created (${prep.kind})`);
    const res = await finishDatasetVersion(prep.versionId, { embed: fakeEmbed, retryDelayMs: 20, chunkBackoffMs: 1, maxAttempts: 3 });
    if (res?.outcome !== 'ACTIVATED') throw new Error(`fixture dataset not activated (${res?.outcome})`);
    await query(
      `INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions, is_active)
       VALUES ($1, 'Fixture Agent', 'Answer only from the fixture lecture.', TRUE)`,
      [lectureId],
    );
    await query(`UPDATE lectures SET status = 'READY' WHERE id = $1`, [lectureId]);
    return lectureId;
  } catch (err) {
    await deleteTestLecture(lectureId).catch(() => {});
    throw err;
  }
}

// Cascades to versions, chunks, profile, sessions, chat history and answer memory.
export async function deleteTestLecture(lectureId: number): Promise<void> {
  await query('DELETE FROM rag_request_log WHERE lecture_id = $1', [lectureId]);
  await query('DELETE FROM lectures WHERE id = $1', [lectureId]);
}
