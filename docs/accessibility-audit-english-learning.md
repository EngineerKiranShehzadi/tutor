# Accessibility audit — current first increment

Scope: lecture chat composer, tutoring-mode selector, new Faculty Revision and Misconception forms, Learning Outcomes and Faculty Learning Gaps pages.

Implemented:
- Semantic name for chat text entry, a stable keyboard-hint description, and explicit recording-stop label.
- Live error/status announcement for voice errors and faculty save outcomes.
- Scoped keyboard focus-visible indicators in newly added learning forms without altering the established theme colors.
- Reduced-motion styling for learning form animations.
- Static CI tests for the above critical accessibility attributes.

**This is not a WCAG 2.2 AA certification.** Remaining acceptance must include real browser keyboard Tab/Shift+Tab and Enter/Space, screen-reader VoiceOver/NVDA, zoom/reflow at 200%/400%, contrast and dark variants, form error recovery, 320px viewport and actual axe scans. Do not claim full accessibility based solely on these tests.

References: https://www.w3.org/TR/WCAG22/ and https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html
