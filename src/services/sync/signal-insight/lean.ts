import { DemarkSide } from '../../manager/types/demark-types';
import { DemarkTrend, Lean, Live13, TimeframeStructure } from '../../manager/types/insight-types';

/** The direction a timeframe points to, as the facts read it (R32); null while forming or once its 13 has failed. */
export function structureLean(s: TimeframeStructure): Lean | null {
    return s.lean;
}

/** The languages the rules write; ko and ja are never sent to the LLM (2026-11-02). */
export type Lang = 'en' | 'zhCN' | 'ko' | 'ja';

/** The languages the LLM writes the conclusion in. */
export type LlmLang = 'en' | 'zhCN';

/** A sell 9 or 13 tops an up move, a buy one bottoms a down move. */
export const SIDE_TREND: Record<DemarkSide, DemarkTrend> = { sell: 'up', buy: 'down' };

/** An exhausted structure's own 13: its timeframe's intact one on the side of its move. */
export function intactThirteenOf(live13: readonly Live13[], s: TimeframeStructure): Live13 | undefined {
    return live13.find((live) => live.interval === s.interval && live.intact && SIDE_TREND[live.side] === s.trend);
}
