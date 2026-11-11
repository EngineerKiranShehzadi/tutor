import assert from 'assert/strict';
import pool from '../config/database';
import {loadPracticeQuiz,submitPracticeQuiz,myPracticeProgress,myPracticeQuizzes} from '../services/practice-quiz.service';

async function main() {
  if(!['localhost','127.0.0.1'].includes(process.env.DB_HOST??'') || !/test/.test(process.env.DB_NAME??'')) {
    throw new Error('Practice grading integration tests require a disposable local database');
  }
  const user=await pool.query<{id:string}>(`INSERT INTO users(name,email,password_hash,is_verified) VALUES('Practice Test Student','practice-selftest@example.invalid','not-a-login',TRUE) RETURNING id`);
  const other=await pool.query<{id:string}>(`INSERT INTO users(name,email,password_hash,is_verified) VALUES('Practice Test Stranger','practice-stranger@example.invalid','not-a-login',TRUE) RETURNING id`);
  const studentId=user.rows[0].id;
  const otherId=other.rows[0].id;
  try {
    const course=await pool.query<{id:number}>(`INSERT INTO courses(title) VALUES('Practice Test Course') RETURNING id`);
    const courseId=course.rows[0].id;
    const lectureA=await pool.query<{id:number}>(`INSERT INTO lectures(title,youtube_url,course_id,status) VALUES('Lecture 01','', $1,'READY') RETURNING id`,[courseId]);
    const lectureB=await pool.query<{id:number}>(`INSERT INTO lectures(title,youtube_url,course_id,status) VALUES('Lecture 02','', $1,'READY') RETURNING id`,[courseId]);
    const ids=[lectureA.rows[0].id,lectureB.rows[0].id];
    const quiz=await pool.query<{id:string}>(`INSERT INTO practice_quizzes(student_id,course_id,lecture_ids,question_count) VALUES($1,$2,$3,2) RETURNING id`,[studentId,courseId,ids]);
    const quizId=Number(quiz.rows[0].id);
    const questionRows = [
      {lecture_id:ids[0],position:1,category:'FACTUAL',question:'Which term means a set of beliefs about right and wrong?',options:['Ethics','Physics','Geometry','Botany'],correct_index:0,explanation:'Ethics is about beliefs of right and wrong.',source_label:'Lecture 01.pptx | Slide 11',source_chunk_id:null},
      {lecture_id:ids[1],position:2,category:'CONCEPTUAL',question:'Why should an organisation establish a code of ethics?',options:['To remove laws','To guide ethical decisions','To replace staff','To remove accountability'],correct_index:1,explanation:'The code guides recognition and resolution of ethical issues.',source_label:'Lecture 02.pptx | Slide 13',source_chunk_id:null},
    ];
    const inserted = await pool.query<{id:string;position:number}>(
      `INSERT INTO practice_questions(quiz_id,lecture_id,position,category,question,options,correct_index,explanation,source_label,source_chunk_id)
       SELECT $1::bigint,p.lecture_id,p.position,p.category,p.question,p.options,p.correct_index,p.explanation,p.source_label,p.source_chunk_id
       FROM jsonb_to_recordset($2::jsonb) AS p(
         lecture_id int,position int,category text,question text,options jsonb,
         correct_index int,explanation text,source_label text,source_chunk_id int
       ) RETURNING id,position`,
      [quizId,JSON.stringify(questionRows)]
    );
    assert.equal(inserted.rows.length,2);
    const idByPosition = new Map(inserted.rows.map(q=>[q.position,Number(q.id)]));
    const id1=idByPosition.get(1)!,id2=idByPosition.get(2)!;
    const before=await loadPracticeQuiz(studentId,quizId);
    assert.equal(before.status,'READY');
    assert.equal(before.questions.length,2);
    assert.equal(before.questions[0].correctIndex,null);
    assert.equal(before.questions[0].explanation,null);
    assert.equal(before.questions[0].source,null);
    await assert.rejects(()=>loadPracticeQuiz(otherId,quizId),/Quiz not found/);
    await assert.rejects(()=>submitPracticeQuiz(studentId,quizId,[{questionId:id1,selectedIndex:0}]),/Please answer every question/);
    const result=await submitPracticeQuiz(studentId,quizId,[{questionId:id1,selectedIndex:0},{questionId:id2,selectedIndex:3}]);
    assert.equal(result.status,'COMPLETED');
    assert.equal(result.correct,1);
    assert.equal(result.percent,50);
    assert.equal(result.questions[0].isCorrect,true);
    assert.equal(result.questions[1].isCorrect,false);
    assert.equal(result.questions[1].correctIndex,1);
    assert.ok(result.questions[1].explanation);
    assert.equal(result.breakdown.length,2);
    assert.equal(result.breakdown[0].correct,1);
    assert.equal(result.breakdown[1].incorrect,1);
    assert.match(result.breakdown[1].recommendation,/Why should an organisation/);
    const repeated=await submitPracticeQuiz(studentId,quizId,[{questionId:id1,selectedIndex:3},{questionId:id2,selectedIndex:1}]);
    assert.equal(repeated.correct,1,'An already submitted quiz must not be regraded');
    const prog=await myPracticeProgress(studentId,courseId);
    assert.equal(prog.attempts,1);
    assert.equal(prog.answered,2);
    assert.equal(prog.correct,1);
    assert.equal(prog.percent,50);
    assert.equal(prog.lectures.length,2);
    const theirs=await myPracticeProgress(otherId,courseId);
    assert.equal(theirs.attempts,0);
    assert.equal((await myPracticeQuizzes(studentId,courseId)).length,1);
    assert.equal((await myPracticeQuizzes(otherId,courseId)).length,0);
    console.log('Practice grading database integration checks passed');
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])',[ [studentId,otherId] ]);
    await pool.query(`DELETE FROM lectures WHERE course_id IN (SELECT id FROM courses WHERE title='Practice Test Course')`);
    await pool.query(`DELETE FROM courses WHERE title='Practice Test Course'`);
  }
}
main().then(()=>pool.end()).catch(async err=>{console.error(err);await pool.end();process.exitCode=1;});
