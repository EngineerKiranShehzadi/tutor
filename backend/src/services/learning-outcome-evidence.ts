// Descriptive indicators only: not an IRT model, psychometric estimate or official grade.
export type OutcomeStatus = 'NOT_ASSESSED'|'INSUFFICIENT_EVIDENCE'|'STRONG'|'DEVELOPING'|'NEEDS_REVISION';
export function evaluateOutcomeStatus(attempted:number,correct:number):OutcomeStatus {
  if(!Number.isSafeInteger(attempted)||!Number.isSafeInteger(correct)||attempted<0||correct<0||correct>attempted)
    throw new Error('Invalid outcome evidence counts');
  if(attempted===0)return 'NOT_ASSESSED';
  if(attempted<3)return 'INSUFFICIENT_EVIDENCE';
  const ratio=correct/attempted;
  return ratio>=0.8?'STRONG':ratio>=0.6?'DEVELOPING':'NEEDS_REVISION';
}
