import assert from 'assert/strict';
import {randomUUID} from 'crypto';
import {query} from '../config/database';
import {
  validatePrivateQuizVideoIds,loadPrivateYoutubeQuiz,
  listPrivateYoutubeQuizzes,submitPrivateYoutubeQuiz
} from '../services/personal-youtube-quiz.service';

async function main(){
  const students:string[]=[];
  try{
    for(const label of ['Owner','Other']){
      const {rows}=await query<{id:string}>(
        "INSERT INTO users(name,email,password_hash,role,is_verified) VALUES($1,$2,'test','STUDENT',true) RETURNING id",
        [label,'quiz-owner-'+randomUUID()+'@example.invalid']);
      students.push(rows[0].id);
    }
    assert.deepEqual(validatePrivateQuizVideoIds(['abcdefghijk']),['abcdefghijk']);
    assert.throws(()=>validatePrivateQuizVideoIds(['abcdefghijk','abcdefghijk']),/Choose/);
    assert.throws(()=>validatePrivateQuizVideoIds(['bad']),/Choose/);
    const {rows:c}=await query<{id:string}>(
      "INSERT INTO student_youtube_courses(student_id,playlist_id,title,status) VALUES($1,$2,'Quiz Course','READY') RETURNING id",
      [students[0],'PL_Quiz_'+randomUUID().replaceAll('-','')]);
    const courseId=Number(c[0].id);
    const {rows:q}=await query<{id:string}>(
      `INSERT INTO student_youtube_practice_quizzes(student_id,course_id,video_ids,question_count)
       VALUES($1,$2,ARRAY['abcdefghijk']::text[],1) RETURNING id`,
      [students[0],courseId]);
    const quizId=Number(q[0].id);
    const {rows:question}=await query<{id:string}>(
      `INSERT INTO student_youtube_practice_questions
       (quiz_id,video_id,video_title,position,category,question,options,correct_index,explanation,source_label)
       VALUES($1,'abcdefghijk','First Lecture',1,'FACTUAL','What is deep learning?',
       '["A","B","C","D"]'::jsonb,2,'Explanation grounded in transcript','Video 00:00:01')
       RETURNING id`,[quizId]);
    const questionId=Number(question[0].id);
    const fresh=await loadPrivateYoutubeQuiz(students[0],quizId);
    assert.equal(fresh.questions.length,1);
    assert.equal(fresh.questions[0].correctIndex,null,'Never disclose answers before submit');
    assert.equal(fresh.questions[0].explanation,null);
    await assert.rejects(loadPrivateYoutubeQuiz(students[1],quizId),/Quiz not found/);
    assert.equal((await listPrivateYoutubeQuizzes(students[1])).length,0);
    await assert.rejects(submitPrivateYoutubeQuiz(students[1],quizId,[{questionId,selectedIndex:2}]),/Quiz not found/);
    await assert.rejects(submitPrivateYoutubeQuiz(students[0],quizId,[]),/Invalid quiz answers/);
    const done=await submitPrivateYoutubeQuiz(students[0],quizId,[{questionId,selectedIndex:2}]);
    assert.equal(done.status,'COMPLETED');
    assert.equal(done.percent,100);
    assert.equal(done.questions[0].correctIndex,2);
    assert.equal(done.questions[0].explanation,'Explanation grounded in transcript');
    const again=await submitPrivateYoutubeQuiz(students[0],quizId,[{questionId,selectedIndex:0}]);
    assert.equal(again.percent,100,'Completed quiz grade must not be overwritten');
    const history=await listPrivateYoutubeQuizzes(students[0]);
    assert.ok(history.some(x=>x.id===quizId));
    assert.equal((await listPrivateYoutubeQuizzes(students[1])).length,0);
    console.log('Private YouTube quiz ownership, answer secrecy, submission, history passed');
  }finally{
    for(const id of students)await query('DELETE FROM users WHERE id=$1',[id]).catch(()=>undefined);
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
