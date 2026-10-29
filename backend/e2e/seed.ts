// Seeds the LOCAL test database for the browser e2e run: an admin, a student, a second student,
// a lecture with an active agent profile (but NO dataset — the browser run uploads it).
// Prints JSON {lectureId, adminToken, studentToken, student2Token, studentId}.
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';

const dbUrl = process.env.DATABASE_URL ?? '';
if (!/(localhost|127\.0\.0\.1)/.test(dbUrl) || !/(test|pipe)/i.test(dbUrl.split('/').pop() ?? '')) {
  console.error('seed: refusing — DATABASE_URL must be a LOCAL database named *test*/*pipe*.'); process.exit(2);
}
(async () => {
  const mk = async (name: string, email: string, role: 'ADMIN' | 'STUDENT') =>
    (await query<{ id: string }>(
      `INSERT INTO users (name,email,password_hash,role,is_verified) VALUES ($1,$2,'x',$3,true)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role RETURNING id`, [name, email, role])).rows[0].id;
  const admin = await mk('E2E Admin', 'e2e-admin@test.local', 'ADMIN');
  const student = await mk('E2E Student', 'e2e-student@test.local', 'STUDENT');
  const student2 = await mk('E2E Student Two', 'e2e-student2@test.local', 'STUDENT');
  const lec = (await query<{ id: number }>(
    `INSERT INTO lectures (title, description, youtube_url, youtube_video_id)
     VALUES ('Prompt Engineering Basics (e2e)', 'Browser e2e lecture', 'https://youtu.be/e2e00000001', 'e2e00000001') RETURNING id`)).rows[0].id;
  await query(`INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions) VALUES ($1,'Nova','Explain simply, only from the lecture.')`, [lec]);
  console.log(JSON.stringify({
    lectureId: lec, studentId: student,
    adminToken: generateAccessToken(admin, 'ADMIN'),
    studentToken: generateAccessToken(student, 'STUDENT'),
    student2Token: generateAccessToken(student2, 'STUDENT'),
  }));
  process.exit(0);
})();
