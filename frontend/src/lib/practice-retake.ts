// A retake never trusts client-supplied course IDs, lecture IDs or old answers.
export function retakeVariables(id: number): { id: number } {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid quiz.');
  return { id };
}
