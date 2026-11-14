import {strict as assert} from 'assert';
import {nextSocraticStage,socraticTurnInstructions} from '../services/socratic-state.service';
const stages:[0|1|2|3,1|2|3|null][]=[[0,1],[1,2],[2,3],[3,null]];
for(const [current,next] of stages){
 assert.equal(nextSocraticStage(current),next);
 const instruction=socraticTurnInstructions(current);
 assert.ok(instruction.includes('ONE')||instruction.includes('Final'));
 assert.ok(instruction.length>65);
}
assert.match(socraticTurnInstructions(0),/Do not reveal the full answer/);
assert.match(socraticTurnInstructions(3),/provide the source-grounded explanation/);
console.log('Bounded Socratic stage policy tests passed.');
