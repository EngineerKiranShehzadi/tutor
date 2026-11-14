'use strict';
// Focused static regression checks: not a replacement for axe/keyboard/browser review.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../src');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('lecture question input is announced with keyboard-help and error region',()=>{
 const s=read('components/chat/ChatInput.tsx');
 assert.match(s,/aria-label="Ask a question about this lecture"/);
 assert.match(s,/aria-describedby="lecture-chat-keyboard-help"/);
 assert.match(s,/id="lecture-chat-keyboard-help"/);
 assert.match(s,/role="alert"/);
 assert.match(s,/aria-label="Send message"/);
 assert.match(s,/aria-label="Stop recording"/);
});
test('learning forms preserve keyboard focus and report saving status',()=>{
 const css=read('app/globals.css');
 assert.match(css,/\.learning-form-a11y :is\(input,textarea,select\):focus-visible/);
 assert.match(css,/prefers-reduced-motion: reduce/);
 for(const file of ['components/admin/FacultyRevisionEditor.tsx','components/admin/MisconceptionReview.tsx']){
  const s=read(file);
  assert.match(s,/learning-form-a11y/);
  assert.match(s,/role="status"/);
  assert.match(s,/role="alert"/);
 }
});
test('learning selectors and evidence progress have usable accessible labels',()=>{
 const teacher=read('components/chat/TutoringModeSelector.tsx');
 const learner=read('app/(dashboard)/learning-outcomes/page.tsx');
 const gaps=read('app/(admin)/admin/faculty-gaps/page.tsx');
 assert.match(teacher,/htmlFor="tutoring-mode-selector"/);
 assert.match(teacher,/aria-describedby="tutoring-mode-help"/);
 assert.match(learner,/htmlFor="student-outcome-course"/);
 assert.match(gaps,/htmlFor="faculty-gap-course"/);
 assert.match(gaps,/role="progressbar"/);
});

test('student course loading and failed course fetch do not masquerade as missing learning outcomes',()=>{
 const page=read('app/(dashboard)/learning-outcomes/page.tsx');
 assert.match(page,/courses\.loading&&!courses\.data/);
 assert.match(page,/courses\.error&&/);
 assert.match(page,/No courses are available yet/);
 assert.match(page,/courseId!==null&&!progress\.loading&&!progress\.error&&!rows\.length/);
 assert.match(page,/disabled=\{courses\.loading\|\|!!courses\.error\|\|all\.length===0\}/);
});

test('faculty revision approval editor is mounted for each mapped course outcome',()=>{
 const admin=read('app/(admin)/admin/learning-outcomes/page.tsx');
 assert.match(admin,/import \{ FacultyRevisionEditor \} from '@\/components\/admin\/FacultyRevisionEditor'/);
 assert.match(admin,/<FacultyRevisionEditor courseId=\{courseId\} outcomeId=\{o\.id\} code=\{o\.code\} lectureIds=\{o\.lectureIds\}\/>/);
 const editor=read('components/admin/FacultyRevisionEditor.tsx');
 assert.match(editor,/SAVE_REVISION_PLAN/);
 assert.match(editor,/WITHDRAW_REVISION_PLAN/);
});

test('admin learning outcomes reports unavailable courses separately from empty outcomes',()=>{
 const page=read('app/(admin)/admin/learning-outcomes/page.tsx');
 assert.match(page,/if\(allCourses\.length===0\)\{setCourseId\(null\);return;\}/);
 assert.match(page,/courses\.error&&/);
 assert.match(page,/No courses available\. Add a course/);
 assert.match(page,/courseId!==null&&!outcomesQuery\.loading&&!outcomesQuery\.error&&!outcomes\.length/);
 assert.match(page,/disabled=\{courses\.loading\|\|!!courses\.error\|\|allCourses\.length===0\|\|pending\}/);
});
