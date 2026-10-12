import type { AlertFeedback } from '@agentscope/shared';

/**
 * Alert feedback helpers (C.10). The feed's thumbs buttons act as a toggle:
 * clicking the active label clears it, clicking the other one switches.
 */
export function nextFeedback(
  current: AlertFeedback | null,
  clicked: AlertFeedback,
): AlertFeedback | null {
  return current === clicked ? null : clicked;
}

/** One row of `GET /api/alerts/feedback-stats`. */
export interface RuleFeedbackStats {
  ruleName: string;
  total: number;
  useful: number;
  noise: number;
}

export interface NoiseRate {
  /** Alerts the owner labelled either way. */
  labelled: number;
  /** Share of labelled alerts marked noise, 0..100, rounded. */
  pct: number;
}

/**
 * Noise rate over the labelled alerts only — unlabelled ones say nothing
 * either way, so counting them would dilute the rate towards zero. Null
 * until at least one alert of the rule is labelled.
 */
export function noiseRate(stats: RuleFeedbackStats | undefined): NoiseRate | null {
  if (!stats) return null;
  const labelled = stats.useful + stats.noise;
  if (labelled === 0) return null;
  return { labelled, pct: Math.round((stats.noise / labelled) * 100) };
}
