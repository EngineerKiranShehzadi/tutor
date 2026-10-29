// node e2e/make-dataset.js out.xlsx [edit]   -> the e2e lecture dataset (12 Q&As with timestamps)
const XLSX = require('xlsx');
const [out, variant] = process.argv.slice(2);
const rows = [
  ['What is zero-shot prompting?', 'Zero-shot prompting means asking the model to do a task with no examples, relying only on the instruction.', '00:02:10', '00:03:05', 'zero-shot'],
  ['What is few-shot prompting?', 'Few-shot prompting gives the model a handful of worked examples inside the prompt before the real task.', '00:03:10', '00:04:20', 'few-shot'],
  ['What is chain-of-thought prompting?', 'Chain-of-thought prompting asks the model to reason step by step before giving its final answer.', '00:04:30', '00:05:40', 'reasoning'],
  ['What is a system prompt?', 'A system prompt sets the role and rules of the assistant before the conversation starts.', '00:06:00', '00:06:50', 'system'],
  ['What is prompt temperature?', 'Temperature controls randomness: low values give focused answers, high values give more varied ones.', '00:07:00', '00:07:55', 'temperature'],
  ['What is a token?', 'A token is a small piece of text, roughly a word fragment, that the model reads and writes.', '00:08:05', '00:08:50', 'tokens'],
  ['What is prompt injection?', 'Prompt injection is an attack where untrusted text tries to override the instructions given to the model.', '00:09:00', '00:10:05', 'security'],
  ['What is hallucination in language models?', 'Hallucination is when a model states something fluent but false or unsupported by its sources.', '00:10:15', '00:11:10', 'safety'],
  ['What is retrieval augmented generation?', 'Retrieval augmented generation fetches relevant documents first and gives them to the model to ground its answer.', '00:11:20', '00:12:30', 'rag'],
  ['What is a persona prompt?', 'A persona prompt asks the model to answer as a particular role, such as a teacher or a reviewer.', '00:12:40', '00:13:20', 'persona'],
  ['What is output formatting in prompts?', 'Output formatting tells the model the exact shape of the answer, such as a list, a table or JSON.', '00:13:30', '00:14:15', 'format'],
  ['What is prompt iteration?', 'Prompt iteration means testing a prompt, reading the result and refining the wording repeatedly.', '00:14:25', '00:15:30', 'iteration'],
];
let data = rows.map(([question, answer, start_time, end_time, keywords]) => ({ question, answer, start_time, end_time, keywords }));
if (variant === 'edit') {                       // used standalone only; the browser run edits the EXPORTED file instead
  data[0].answer = 'Zero-shot prompting means giving the model only an instruction and no examples (EDITED).';
}
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Dataset'); XLSX.writeFile(wb, out);
