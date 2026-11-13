import assert from 'assert/strict';
import { validatePersonalCourseId, MAX_PERSONAL_COURSES } from '../services/student-youtube-course.service';
import { validPlaylistId } from '../services/youtube-discovery.service';

assert.equal(MAX_PERSONAL_COURSES,2);
assert.equal(validatePersonalCourseId('42'),42);
for (const bad of [0,-1,1.2,'x',Number.MAX_SAFE_INTEGER+1]) {
  assert.throws(()=>validatePersonalCourseId(bad));
}
assert.equal(validPlaylistId('PL4kipppqKObLmh-ZpCqp8iXj1V2guWyhj'),true);
assert.equal(validPlaylistId('https://evil.example/'),false);
console.log('Personal YouTube course offline contract checks passed');
