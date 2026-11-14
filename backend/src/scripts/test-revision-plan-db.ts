import {strict as assert} from 'assert';
import pool,{query} from '../config/database';
import {upsertRevisionPlan,withdrawRevisionPlan,myRevisionRecommendations,listFacultyRevisionPlans} from '../services/revision-plan.service';
import {studentOutcomeProgress,facultyOutcomeSummary} from '../services/learning-outcome.service';
// Disposable database only. Never run this against Neon or another developer's data.
if(process.env.NODE_ENV!=='test'||process.env.DB_NAME!=='outcomes_test'||!['localhost','127.0.0.1'].includes(process.env.DB_HOST||'')){
 throw new Error('Refusing revision test outside localhost outcomes_test');
}
const a='00000000-0000-4000-8000-000000000071',b='00000000-0000-4000-8000-000000000072';
const course=97001,lecture=97001,outcome=97001,quiz=97001;
async function main(){
 try{
  await query(`INSERT INTO users(id,name,email,password_hash) VALUES
   ($1,'A','revision-a@example.invalid','offline'),($2,'B','revision-b@example.invalid','offline')`,[a,b]);
  await query('INSERT INTO courses(id,title) VALUES($1,$2)',[course,'Revision test']);
  await query('INSERT INTO lectures(id,course_id,title,youtube_url,status) VALUES($1,$2,$3,$4,$5)',
    [lecture,course,'Source Evidence','https://www.youtube.com/watch?v=abc123def45','READY']);
  await query('INSERT INTO course_learning_outcomes(id,course_id,code,description) VALUES($1,$2,$3,$4)',
    [outcome,course,'CLO1','Explain a faculty-approved revision topic']);
  await query('INSERT INTO lecture_learning_outcomes(lecture_id,outcome_id) VALUES($1,$2)',[lecture,outcome]);
  await query(`INSERT INTO practice_quizzes(id,student_id,course_id,lecture_ids,status,question_count,correct_count,submitted_at)
   VALUES($1,$2,$3,$4,'COMPLETED',3,0,NOW())`,[quiz,a,course,[lecture]]);
  for(let i=0;i<3;i++){
   const questionId=97011+i;
   await query(`INSERT INTO practice_questions(id,quiz_id,lecture_id,position,category,question,options,correct_index,explanation,source_label)
     VALUES($1,$2,$3,$4,'FACTUAL',$5,$6::jsonb,0,'A','Lecture')`,
     [questionId,quiz,lecture,i+1,'Question '+(i+1)+' about precision?',JSON.stringify(['a','b','c','d'])]);
   await query('INSERT INTO practice_question_outcomes(question_id,outcome_id) VALUES($1,$2)',[questionId,outcome]);
   await query('INSERT INTO practice_answers(quiz_id,question_id,selected_index,is_correct) VALUES($1,$2,1,FALSE)',[quiz,questionId]);
  }
  assert.deepEqual(await myRevisionRecommendations(a,course),[]);
  await upsertRevisionPlan(a,course,outcome,lecture,'Review source concepts and test your understanding.',false);
  assert.equal((await listFacultyRevisionPlans(course))[0].status,'DRAFT');
  assert.deepEqual(await myRevisionRecommendations(a,course),[]);
  await upsertRevisionPlan(a,course,outcome,lecture,'Review source concepts and test your understanding.',true);
  const recommendation=await myRevisionRecommendations(a,course);
  assert.equal(recommendation.length,1);
  assert.equal(recommendation[0].attempted,3);
  assert.equal(recommendation[0].correct,0);
  assert.deepEqual(await myRevisionRecommendations(b,course),[],'Student B must not see student A evidence');
  // A COMPLETED flag without a submission timestamp must not count as graded evidence.
  assert.equal((await studentOutcomeProgress(a,course))[0].attempted,3);
  assert.equal((await facultyOutcomeSummary(course))[0].attempted,3);
  await query('UPDATE practice_quizzes SET submitted_at=NULL WHERE id=$1',[quiz]);
  assert.deepEqual(await myRevisionRecommendations(a,course),[],
   'A quiz without a submission timestamp must not trigger revision guidance');
  const incompleteStudent=(await studentOutcomeProgress(a,course))[0];
  assert.equal(incompleteStudent.attempted,0);
  assert.equal(incompleteStudent.status,'NOT_ASSESSED');
  assert.equal((await facultyOutcomeSummary(course))[0].attempted,0);
  await query('UPDATE practice_quizzes SET submitted_at=NOW() WHERE id=$1',[quiz]);
  assert.equal((await myRevisionRecommendations(a,course)).length,1,
   'Restoring the timestamp must restore eligible evidence');
  await assert.rejects(upsertRevisionPlan(a,course,outcome,lecture+3,'Review source concepts and test your understanding.',true),/mapped/);
  await withdrawRevisionPlan(course,outcome);
  assert.deepEqual(await myRevisionRecommendations(a,course),[],'Withdrawn plan must disappear');
  console.log('Approved revision plan lifecycle / student isolation passed.');
 } finally {
  await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[a,b]]).catch(()=>undefined);
  await query('DELETE FROM lectures WHERE id=$1',[lecture]).catch(()=>undefined);
  await query('DELETE FROM courses WHERE id=$1',[course]).catch(()=>undefined);
  await pool.end();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
