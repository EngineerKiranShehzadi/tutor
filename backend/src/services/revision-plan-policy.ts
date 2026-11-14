export const REVISION_MIN_ANSWERS=3;
export function revisionEligible(attempted:number,correct:number):boolean{
 if(!Number.isSafeInteger(attempted)||!Number.isSafeInteger(correct)||attempted<0||correct<0||correct>attempted)
  throw new Error('Invalid graded evidence');
 return attempted>=REVISION_MIN_ANSWERS&&correct/attempted<0.6;
}
export function normalizeRevisionGuidance(raw:string):string{
 const value=(raw||'').trim();
 if(value.length<15||value.length>600)throw new Error('Guidance must be between 15 and 600 characters');
 return value;
}
