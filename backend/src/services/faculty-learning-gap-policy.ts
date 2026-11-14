/**
 * Descriptive, faculty-facing formative assessment signals.
 * This is NOT a validated mastery metric or predictive early-warning model.
 * Suppress small cohorts to avoid overinterpretation and disclosure.
 */
export const MIN_GRADED_ANSWERS_PER_LEARNER = 3;
export const MIN_ASSESSED_STUDENTS = 5;
export type FacultyGapStatus = 'NOT_MAPPED'|'INSUFFICIENT_EVIDENCE'|'REVIEW_RECOMMENDED'|'MONITOR';
export function classifyFacultyGap(
  mappedQuestions:number, sufficientlyAssessedStudents:number, revisionStudents:number
): FacultyGapStatus {
  if([mappedQuestions,sufficientlyAssessedStudents,revisionStudents].some(v=>!Number.isSafeInteger(v)||v<0)||
    revisionStudents>sufficientlyAssessedStudents) throw new Error('Invalid faculty evidence counts');
  if(mappedQuestions===0)return 'NOT_MAPPED';
  if(sufficientlyAssessedStudents<MIN_ASSESSED_STUDENTS)return 'INSUFFICIENT_EVIDENCE';
  return revisionStudents/sufficientlyAssessedStudents>=0.3?'REVIEW_RECOMMENDED':'MONITOR';
}
export function facultyGapAction(status:FacultyGapStatus,hasLectures:boolean):string{
  if(status==='NOT_MAPPED')return 'Review and map existing quiz questions to this learning outcome.';
  if(status==='INSUFFICIENT_EVIDENCE')return 'Gather more faculty-mapped quiz evidence before drawing class-level conclusions.';
  if(status==='REVIEW_RECOMMENDED')return hasLectures
    ? 'Review the mapped lectures and consider adding a worked example or guided practice. Faculty approval required.'
    : 'Map relevant lectures and review explanations before planning an intervention.';
  return 'Continue monitoring future completed quizzes. No intervention is triggered automatically.';
}
