// Deterministic Stage-A signal patterns for guards/prompt-injection.guard.ts.
// A match here is a *signal*, never an automatic REJECT — this course
// teaches prompt injection and jailbreaking as course material, so
// "What does 'ignore previous instructions' mean?" must match one of these
// and still end up ALLOWed (educational framing wins — see
// EDUCATIONAL_FRAMING_PATTERNS / IMPERATIVE_FRAMING_PATTERNS below).
//
// Grouped by manipulation family, not one giant regex, so each family can be
// read/extended independently.

export const IGNORE_INSTRUCTIONS_PATTERNS = [
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|your)\s+instructions?\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|your)\s+instructions?\b/i,
  /\bforget\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|your)\s+instructions?\b/i,
];

export const REVEAL_SYSTEM_PROMPT_PATTERNS = [
  /\breveal\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions?|initial\s+instructions?)\b/i,
  /\bwhat\s+(?:is|are)\s+your\s+(?:system\s+prompt|hidden\s+instructions?)\b/i,
  /\bshow\s+me\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions?|internal\s+(?:rules|configuration))\b/i,
  /\bprint\s+(?:your|the)\s+(?:system\s+prompt|instructions?)\b/i,
  /\brepeat\s+(?:the\s+text\s+)?(?:above|your\s+instructions?)\b/i,
];

export const OVERRIDE_GROUNDING_PATTERNS = [
  /\b(?:answer|respond)\s+(?:using|from|based on)\s+your\s+(?:own\s+)?(?:knowledge|training)\b/i,
  /\bignore\s+(?:the\s+|your\s+|any\s+)?lecture\s+(?:content|context|restrictions?)\b/i,
  /\bdisregard\s+(?:the\s+|your\s+|any\s+)?lecture\s+(?:content|context|restrictions?)\b/i,
  /\bpretend\s+(?:you\s+)?(?:have\s+no\s+restrictions?|don'?t\s+have\s+(?:any\s+)?rules?)\b/i,
];

export const DISABLE_RESTRICTIONS_PATTERNS = [
  /\bdisable\s+(?:your\s+)?(?:restrictions?|filters?|safety|guardrails?)\b/i,
  /\bunrestricted\s+mode\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\s+(?:this|the)\s+(?:assistant|model|ai|chatbot)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+have\s+no|an\s+ai\s+with\s+no)\s+(?:restrictions?|rules?|filters?)\b/i,
];

export const IMPERSONATION_PATTERNS = [
  /\byou\s+are\s+now\s+(?:a|an|the)\s+(?:system|developer|admin|root)\b/i,
  /\bact\s+as\s+(?:the\s+)?(?:system|developer|admin)\b/i,
  /\bfrom\s+now\s+on\s+you\s+are\b/i,
  /\bnew\s+system\s+prompt\s*:/i,
];

// Question/discussion framing — a match here strongly suggests the message
// is asking *about* prompt injection rather than attempting it.
export const EDUCATIONAL_FRAMING_PATTERNS = [
  /^(what|why|how|when|where|which|explain|describe|define|discuss|analyze|analyse)\b/i,
  /\b(what does .* mean|what is (?:a|an) |give (?:me )?an example|example of|demonstrate|discussed in (?:this|the) lecture|would (?:this|that) be considered)\b/i,
  /\b(prompt injection|jailbreak|adversarial prompt|prompt engineering)\b/i, // meta/topic vocabulary itself
  /\?\s*$/,
];

// Direct imperative addressed at the assistant with no educational framing —
// only meaningful in combination with a signal-pattern match above.
export const IMPERATIVE_FRAMING_PATTERNS = [
  /^(ignore|disregard|forget|reveal|show|print|disable|pretend|act as|you are now)\b/i,
];
