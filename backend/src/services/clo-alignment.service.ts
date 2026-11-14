// Question-level CLO approval is never inferred from lecture membership alone.
// Used only after independent grounding/ambiguity verification succeeds.
export type CloVerdict = {grounded:boolean;unambiguous:boolean;outcomeId:number};
export function verifiedCloOutcomeId(
  verdict:CloVerdict|null|undefined,
  approvedIds:readonly number[]
):number|null{
  if(!verdict || verdict.grounded!==true || verdict.unambiguous!==true)return null;
  if(!Number.isSafeInteger(verdict.outcomeId)||verdict.outcomeId<=0)return null;
  return approvedIds.includes(verdict.outcomeId)?verdict.outcomeId:null;
}
