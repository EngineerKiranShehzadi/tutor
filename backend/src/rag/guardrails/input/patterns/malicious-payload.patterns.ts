// Deterministic *signal* patterns for guards/malicious-payload.guard.ts.
// These flag suspicious syntax — they never decide REJECT on their own. The
// course this app serves teaches exactly this syntax (SQL injection, XSS,
// path traversal, shell/template injection examples), so a match here only
// means "look closer at framing", never "block".
//
// Kept as separate, named groups (not one giant regex) so each attack
// family can be read, tested, and extended independently.

export const SQL_INJECTION_PATTERNS = [
  /\bunion\b\s+(?:all\s+)?\bselect\b/i,
  /\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i, // e.g. OR 1=1
  /'\s*or\s*'?\d*'?\s*=\s*'?\d*'?/i,             // e.g. ' OR '1'='1
  /;\s*drop\s+table\b/i,
  /;\s*delete\s+from\b/i,
  /--\s*$/, // trailing SQL comment terminator
];

export const XSS_PATTERNS = [
  /<script[\s>]/i,
  /<\/script>/i,
  /\bon(?:error|load|click|mouseover|focus)\s*=\s*["']/i,
  /javascript\s*:/i,
];

export const SHELL_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash)\b/i,
  /;\s*(?:cat|ls|whoami|chmod|chown)\b/i,
  /`[^`]+`/, // backtick command substitution
  /\$\([^)]+\)/, // $() command substitution
];

export const PATH_TRAVERSAL_PATTERNS = [
  /(?:\.\.\/){2,}/,
  /(?:\.\.\\){2,}/,
  /\.\.%2f/i,
];

export const TEMPLATE_INJECTION_PATTERNS = [
  /\{\{.*(?:constructor|__proto__|process|require)\b.*\}\}/i,
  /\$\{.*(?:constructor|process|require)\b.*\}/i,
];

// Framing that indicates the suspicious syntax is being discussed,
// explained, or quoted rather than directed at this application — the
// dataset context this course is built on. A match against ANY of these
// biases the guard toward ALLOW even when a signal pattern above also
// matched.
export const EDUCATIONAL_FRAMING_PATTERNS = [
  /^(what|why|how|when|where|which|explain|describe|define|discuss|analyze|analyse)\b/i,
  /\b(example of|demonstrate|show me an example|what does this (?:do|mean)|walk me through|help me understand)\b/i,
  /\b(this (?:code|query|script|payload|example|snippet)|the following (?:code|query|script|payload|example))\b/i,
  /\?\s*$/,
];

// Narrow, high-confidence "acting on this application" framing — an
// imperative directly instructing the assistant/system to run, apply, or
// carry out the payload, with no educational framing alongside it. Only
// combined with a signal pattern match does this guard actually REJECT.
export const DIRECT_EXECUTION_IMPERATIVE_PATTERNS = [
  /\b(run|execute|apply)\s+(this|the following|it)\b/i,
  /\bdelete\s+(all|every)\b/i,
  /\bgo\s+ahead\s+and\s+(run|execute|delete|drop)\b/i,
];
