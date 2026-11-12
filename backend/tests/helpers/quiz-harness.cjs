const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../../src');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (status = 200, payload = { candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] }, finishReason: 'STOP' }] }) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
function harness(overrides = {}) {
  const logs = [];
  const env = { LLM: { GEMINI: { API_KEY: 'NEVER-LOG-THIS-KEY', QUIZ_MAX_RPM: 10 }, QUIZ: { MODEL: 'gemini-2.5-flash-lite' } } };
  const mocks = new Map([
    [path.join(ROOT, 'middleware/errorHandler'), { AppError }],
    [path.join(ROOT, 'config/env'), { env }],
    [path.join(ROOT, 'utils/logger'), { logger: { info: s => logs.push(s), warn: s => logs.push(s) } }],
    [path.join(ROOT, 'llm/json-schema'), { toJsonSchema: schema => ({ type: schema.type.toLowerCase() }) }],
    [path.join(ROOT, 'config/database'), overrides.database ?? { query: async () => { throw Error('Unexpected DB call'); } }],
    [path.join(ROOT, 'llm/llm-provider.resolver'), { resolveLlmProvider: () => overrides.provider ?? { generate: async () => { throw Error('Unexpected model call'); } } }],
  ]);
  const modules = new Map();
  function load(file) {
    const full = path.resolve(ROOT, file).replace(/\.ts$/, '');
    if (mocks.has(full)) return mocks.get(full);
    if (modules.has(full)) return modules.get(full).exports;
    const mod = { exports: {} }; modules.set(full, mod);
    const source = fs.readFileSync(full + '.ts', 'utf8');
    const built = ts.transpileModule(source, { fileName: full + '.ts', reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    const errors = (built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, JSON.stringify(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))));
    const localRequire = id => id.startsWith('.') ? load(path.resolve(path.dirname(full), id)) : require(id);
    new Function('require','module','exports','__filename','__dirname',built.outputText)(localRequire,mod,mod.exports,full+'.ts',path.dirname(full));
    return mod.exports;
  }
  return { load, logs, env };
}
function source(id = 4) { return { id: 1000 + id, lecture_id: id, answer: 'Integrity means acting according to principles in all situations. Practice improves the accuracy of a learned skill.', question: 'What does integrity mean?', topic: 'Integrity', start_time: null }; }
function quizHarness(options = {}) {
  const calls = [], queries = [], writes = [];
  let eligibility = 0, nextId = 100, released = 0, committed = false;
  let inserted = [], quiz;
  const requested = options.lectures ?? [4, 6];
  const lectures = requested.map(id => ({ id, title: 'Lecture ' + id, active_version_id: id + 10, status: 'READY' }));
  const previous = options.previous ?? { course_id: 1, lecture_ids: requested, status: 'COMPLETED', question_count: requested.length,
    questions: requested.map(id => ({ lectureId: id, question: 'Which action improves the accuracy of a learned skill?', sourceId: source(id).id })) };
  const database = {
    __esModule: true,
    query: async (sql, params) => {
      queries.push({sql,params});
      if (sql.includes('SELECT q.course_id, q.lecture_ids')) return { rows: options.notOwned || params[1] !== 'student' ? [] : [previous] };
      if (sql.includes('SELECT l.id, l.title')) { eligibility++; return { rows: options.eligibility ? options.eligibility(eligibility,lectures) : lectures }; }
      if (sql.includes('WITH requested AS')) {
        if (options.evidence) return { rows: await options.evidence(params) };
        return { rows: params[1].map((id,i) => ({...source(id),version_id:params[2][i]})) };
      }
      if (sql.startsWith('SELECT * FROM practice_quizzes WHERE id=')) return { rows: quiz ? [quiz] : [] };
      if (sql.includes('SELECT q.*, l.title')) return { rows: inserted };
      throw Error('Unexpected SQL in mock: '+sql);
    },
    default: { connect: async () => {
      if (options.connectDelay) await pause(options.connectDelay);
      return { release: () => { released++; }, query: async (sql,params) => {
        writes.push(sql);
        if (options.writeFailure && sql.startsWith('INSERT INTO practice_questions')) throw Error('write failed');
        if (sql.startsWith('INSERT INTO practice_quizzes')) {
          quiz={id:String(++nextId),student_id:params[0],course_id:params[1],lecture_ids:params[2],question_count:params[3],status:'IN_PROGRESS',correct_count:null,created_at:new Date(),submitted_at:null};
          return {rows:[quiz]};
        }
        if (sql.startsWith('INSERT INTO practice_questions')) {
          inserted=JSON.parse(params[1]).map((q,i)=>({...q,id:String(nextId*100+i),quiz_id:quiz.id,title:'Lecture '+q.lecture_id,selected_index:null}));
          return {rows:options.shortSave?inserted.slice(1):inserted};
        }
        if (sql==='COMMIT') committed=true;
        return {rows:[]};
      }};
    } },
  };
  const generationByLecture=new Map(); let verifyCall=0;
  const provider={generate:async req=>{
    calls.push(req);
    if(options.provider)return options.provider(req,calls);
    if(req.telemetry.operation==='QUIZ_VERIFY'){
      verifyCall++;
      const body=JSON.parse(req.userPrompt);
      const checks=body.questions.map(q=>({index:q.index,grounded:true,unambiguous:true,...(body.previousQuestions?{distinctFromPrevious:true}:{})}));
      if(options.verification)return options.verification(body,verifyCall,checks);
      return {raw:JSON.stringify({checks}),finishReason:'STOP'};
    }
    const id=Number(req.userPrompt.match(/Lecture ID: (\d+)/)[1]);
    const attempt=(generationByLecture.get(id)??0)+1;generationByLecture.set(id,attempt);
    const categories=req.userPrompt.match(/Categories in question order: ([A-Z, ]+)\./)[1].split(', ');
    const questions=categories.map((category,i)=>({lectureId:id,sourceId:source(id).id,category,
      question:`For lecture ${id} practice ${attempt} item ${i}, what does integrity require?`,
      options:['Consistent principles','Random choices','Ignoring values','Cheating'],correctIndex:0,
      explanation:'The source requires consistent principles in all situations.',evidenceQuote:source(id).answer.split('. ')[0]+'.'}));
    if(options.generation)return options.generation(questions,id,attempt,req);
    return {raw:JSON.stringify({questions}),finishReason:'STOP'};
  }};
  const h=harness({database,provider});
  return {...h,svc:h.load('services/practice-quiz.service'),calls,queries,writes,previous,
    get released(){return released;},get committed(){return committed;}};
}
module.exports={harness,quizHarness,source,pause,response,AppError};
