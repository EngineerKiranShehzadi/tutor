/**
 * Safe database integration checks: run ONLY against a disposable local
 * PostgreSQL database with migrations 020 and 022 applied.
 */
import assert from 'assert/strict';
import { createCourse, getCourse, listCourses, updateCourse, defaultCourseId } from '../services/course.service';
import { createLecture, getLectures, getLectureById } from '../services/lecture.service';
import pool from '../config/database';

async function run() {
  if (process.env.DB_HOST !== '127.0.0.1' && process.env.DB_HOST !== 'localhost') {
    throw new Error('Course service tests refuse non-local databases');
  }
  if (!/test/.test(process.env.DB_NAME ?? '')) {
    throw new Error('Course service tests require a database name containing test');
  }
  const legacyId = await defaultCourseId();
  const legacy = await getCourse(legacyId);
  assert.equal(legacy.title, 'Generative AI Fundamentals');
  assert.equal(legacy.subtitle, 'Master the Art of AI Conversations using ChatGPT');

  const course = await createCourse({
    title: '  Data Structures  ',
    subtitle: 'Learn algorithms',
    description: 'Learn the fundamentals',
  });
  assert.equal(course.title, 'Data Structures');
  assert.equal(course.lecture_count, 0);
  assert.equal(course.ready_count, 0);

  const lecture = await createLecture({
    courseId: course.id,
    title: 'Introduction to Arrays',
    description: 'Documents only',
    agentName: 'Array Tutor',
    agentInstructions: 'Use only the lecture learning material to answer questions.',
  });
  assert.equal(lecture.course_id, course.id);
  assert.equal(lecture.youtube_url, '');
  assert.equal(lecture.youtube_video_id, null);
  assert.equal((await getLectureById(lecture.id)).agent_name, 'Array Tutor');

  const isolated = await getLectures(course.id);
  assert.deepEqual(isolated.map(l => l.id), [lecture.id]);
  const original = await getLectures(legacyId);
  assert.ok(original.length >= 7);
  assert.ok(original.every(l => l.course_id === legacyId));
  assert.ok(!original.some(l => l.id === lecture.id));

  const updated = await updateCourse(course.id, {title: 'Data Structures and Algorithms'});
  assert.equal(updated.title, 'Data Structures and Algorithms');
  assert.equal(updated.lecture_count, 1);
  assert.equal((await listCourses()).length, 3); // legacy + earlier SQL test + this course

  console.log('Course service integration checks passed');
}
run().then(() => pool.end()).catch(async err => {
  console.error(err);
  await pool.end();
  process.exitCode = 1;
});
