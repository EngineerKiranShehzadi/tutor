import {strict as assert} from 'assert';
import {observedChange} from '../services/learning-effectiveness-policy';
const q=(quizId:number,attempted:number,correct:number,submittedAt:string)=>({quizId,attempted,correct,submittedAt});
const inputs=[
 q(7,5,2,'2026-11-01T10:00:00Z'),
 q(8,5,4,'2026-11-12T10:00:00Z')
];
const result=observedChange(inputs);
assert.equal(result?.firstPercent,40);
assert.equal(result?.latestPercent,80);
assert.equal(result?.changePoints,40);
assert.equal(observedChange([inputs[0]]),null);
assert.equal(observedChange([q(1,2,1,'2026-11-01T10:00:00Z'),inputs[1]]),null);
assert.equal(observedChange([q(1,3,2,'invalid'),inputs[1]]),null);
assert.equal(observedChange([inputs[0],inputs[0]]),null);
assert.equal(observedChange([q(7,4,4,'2026-11-01T10:00:00Z'),q(9,4,1,'2026-11-12T10:00:00Z')])?.changePoints,-75);
assert.deepEqual(observedChange([inputs[1],inputs[0]])?.first.quizId,7);
console.log('Observed quiz change and insufficient evidence policy tests passed.');
