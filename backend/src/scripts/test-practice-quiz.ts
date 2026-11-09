import assert from 'assert/strict';
import {allocateByLecture,validateGenerated,verifiedQuestionIndexes} from '../services/practice-quiz.service';

const plan=allocateByLecture([10,11,12,13,14,15,16]);
assert.equal([...plan.values()].reduce((sum,n)=>sum+n,0),10);
assert.ok([...plan.values()].every(n=>n>=1));
assert.deepEqual([...plan.values()],[2,2,2,1,1,1,1]);
assert.equal([...allocateByLecture(Array.from({length:25},(_,i)=>i+1)).values()].reduce((a,b)=>a+b,0),25);
const source={id:901,lecture_id:10,answer:'Integrity means acting according to principles in all situations.',question:'Source excerpt',topic:null,start_time:'Lecture 01.pptx | Slide 12'};
const sources=new Map([[901,source]]);
const good={
  lectureId:10,sourceId:901,category:'CONCEPTUAL',question:'What does integrity require?',
  options:['Consistency across situations','Different morals for different people','Ignoring personal principles','Unethical shortcuts'],
  correctIndex:0,explanation:'The source states that principles apply consistently.',
  evidenceQuote:'Integrity means acting according to principles in all situations.',
};
assert.deepEqual(validateGenerated({questions:[good]},sources).length,1);
assert.deepEqual(validateGenerated({questions:[good,good]},sources).length,1);
assert.equal(validateGenerated({questions:[{...good,evidenceQuote:'An invented sentence which does not exist.'}]},sources).length,0);
assert.deepEqual(validateGenerated({questions:[{...good,sourceId:902}]},sources).length,0);
assert.deepEqual(validateGenerated({questions:[{...good,lectureId:12}]},sources).length,0);
assert.deepEqual(validateGenerated({questions:[{...good,correctIndex:4}]},sources).length,0);
assert.deepEqual(validateGenerated({questions:[{...good,options:['A','A','C','D']}]},sources).length,0);
assert.deepEqual(validateGenerated({questions:[{...good,category:'UNSUPPORTED'}]},sources).length,0);
assert.deepEqual([...verifiedQuestionIndexes({checks:[{index:0,grounded:true,unambiguous:true},{index:1,grounded:false,unambiguous:true}]},2)],[0]);
assert.equal(verifiedQuestionIndexes({checks:[{index:0,grounded:true,unambiguous:true}]},2).size,0);
assert.equal(verifiedQuestionIndexes({checks:[{index:0,grounded:true,unambiguous:true},{index:0,grounded:true,unambiguous:true}]},2).size,0);
console.log('Practice quiz generation validation and lecture allocation checks passed');
