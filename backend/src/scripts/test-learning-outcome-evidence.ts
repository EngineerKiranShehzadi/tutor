import { strict as assert } from 'assert';
import { evaluateOutcomeStatus as status } from '../services/learning-outcome-evidence';
assert.equal(status(0,0),'NOT_ASSESSED');
assert.equal(status(1,1),'INSUFFICIENT_EVIDENCE');
assert.equal(status(2,0),'INSUFFICIENT_EVIDENCE');
assert.equal(status(3,3),'STRONG');
assert.equal(status(5,4),'STRONG');
assert.equal(status(5,3),'DEVELOPING');
assert.equal(status(5,2),'NEEDS_REVISION');
for(const [a,b] of [[-1,0],[3,4],[0,1],[1,-1],[1.5,1],[3,NaN]]){
  assert.throws(()=>status(a,b));
}
console.log('Learning outcome status tests passed.');
