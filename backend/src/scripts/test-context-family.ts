import assert from 'assert/strict';
import {contextFamilyKey,boundedNewNeighbors} from '../services/context-family.service';

assert.equal(contextFamilyKey({question:'What is a prompt?',start_time:'lesson.docx | Slide 4'}),
 'lesson.docx | Slide 4|Q:what is a prompt?');
assert.equal(contextFamilyKey({question:'What is a prompt? [Answer part 2]',start_time:'lesson.docx | Slide 4'}),
 'lesson.docx | Slide 4|Q:what is a prompt?');
assert.equal(contextFamilyKey({question:'Source excerpt: lecture.docx | Slide 4 | Part 3',start_time:'lecture.docx | Slide 4'}),
 'lecture.docx | Slide 4|Source excerpt: lecture.docx | Slide 4');
assert.equal(contextFamilyKey({question:'Question',start_time:null}),null);
assert.deepEqual(boundedNewNeighbors([{id:1}],[{id:1},{id:2},{id:2},{id:3}],1),[{id:2}]);
assert.deepEqual(boundedNewNeighbors([{id:1}],[{id:2}],0),[]);
console.log('Parent/child context expansion integrity guards passed');
