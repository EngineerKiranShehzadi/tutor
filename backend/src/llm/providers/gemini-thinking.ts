import type { LlmThinking } from '../llm.types';
import type { GeminiThinkingConfig } from '../../services/gemini-provider.service';

// Gemini model families take different thinking controls: 2.5 uses a token
// budget (thinkingBudget), 3.x uses a level (thinkingLevel) and rejects the
// budget. This is the single place that translates the provider-neutral
// LlmThinking setting, so changing a task's model never needs a code change.
//
//  - gemini-2.5-*: off/minimal -> budget 0 (Pro can't be disabled: its
//    minimum is 128); low/medium/high -> fixed budgets below.
//  - gemini-3.x:   levels map 1:1. Models that don't accept MINIMAL (3 Pro and
//    3.8+ Flash, whose lowest level is LOW) get off/minimal clamped to LOW.
//  - anything else (e.g. the *-latest aliases, whose family can change under
//    us): no thinking config is sent, so the model's default applies.
const BUDGET_2_5: Record<LlmThinking, number> = { off: 0, minimal: 0, low: 1024, medium: 8192, high: 24576 };
const PRO_2_5_MIN_BUDGET = 128;

const LEVEL_3: Record<Exclude<LlmThinking, 'off'>, NonNullable<GeminiThinkingConfig['thinkingLevel']>> = {
  minimal: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH',
};

const rejectsMinimalLevel = (model: string): boolean => {
  if (model.includes('-pro')) return true;
  const minor = /^gemini-3\.(\d+)/.exec(model);
  return minor !== null && parseInt(minor[1], 10) >= 8;
};

export const toGeminiThinkingConfig = (
  model: string,
  thinking: LlmThinking | undefined
): GeminiThinkingConfig | undefined => {
  if (thinking === undefined) return undefined;

  if (model.startsWith('gemini-2.5')) {
    const budget = BUDGET_2_5[thinking];
    return { thinkingBudget: model.includes('-pro') ? Math.max(budget, PRO_2_5_MIN_BUDGET) : budget };
  }

  if (model.startsWith('gemini-3')) {
    const level = LEVEL_3[thinking === 'off' ? 'minimal' : thinking];
    return { thinkingLevel: level === 'MINIMAL' && rejectsMinimalLevel(model) ? 'LOW' : level };
  }

  return undefined;
};
