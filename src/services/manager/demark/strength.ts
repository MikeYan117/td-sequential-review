// Signal strength score v1.5 (spec section 5, R32/R34/R36): the v1 weights, each timeframe scored on the side
// of its facts lean (TimeframeStructure.lean), so the card and the text read every timeframe the same way.
// With a main line the card is scored from its lead timeframe (facts.mainLine.leadInterval) plus the other
// timeframes on its side; without one, the two sides are compared. Only 5m/15m/1h/4h are scored: since R36
// the facts never read 1d, so it never leads.
// The score measures how strong the current evidence is. It is not a probability or a win rate: a replay
// of the earlier v1 rules on 10 symbols over 2026-09-09 to 2026-10-09 had weak / moderate cards pointing
// the right way about 49% / 50% of the time (strong had only 3 cases), so a higher band does not mean a
// more reliable direction.

import { DemarkSide } from '../types/demark-types';
import {
    CardDirection,
    CardStrength,
    Lean,
    RegimeSignal,
    ScoredInterval,
    StrengthLabel,
    TimeframeRegimeState,
    TimeframeScore,
    TimeframeStructure
} from '../types/insight-types';
import { INTERVAL_MS } from './binance-klines';

export const SCORED_INTERVALS: readonly ScoredInterval[] = ['5m', '15m', '1h', '4h'];

export const STRENGTH_V1 = {
    anchorWeight: 12,
    confluenceWeight: 4,
    conflictWeight: { '5m': 4, '15m': 4, '1h': 8, '4h': 8 },
    freshFloor: 0.5,
    freshSpanBars: 24,
    /** A 9 counting toward 13 scores AlphaBTC's signal 1 base level, without its regime adjustment (v1.2). */
    nineLevel: 2,
    moderateFrom: 45,
    strongFrom: 75
} as const;

/**
 * One timeframe's evidence, on the side of `structure.lean` (the timeframe's facts structure): null
 * without one, or while it has no lean (forming, or its 13 has failed). An exhausted move scores its
 * active signals' calibrated level (swing on 4h, intraday below), aged from its 13; a 9 counting
 * toward 13 scores `nineLevel`, aged from the 9.
 */
export function scoreTimeframe(
    interval: ScoredInterval,
    state: TimeframeRegimeState | null,
    signals: readonly RegimeSignal[],
    lastClosedBarTime: number,
    structure: Pick<TimeframeStructure, 'stage' | 'lean'> | null
): TimeframeScore | null {
    if (state === null || structure === null || structure.lean === null) return null;
    const side: DemarkSide = structure.lean === 'bullish' ? 'buy' : 'sell';

    let level: number;
    let at: number | null;
    if (structure.stage === 'exhausted') {
        // The signals sit on the reversal side, the exhausted move's lean, so their regime adjustment applies.
        const levels = signals
            .filter((signal) => signal.active)
            .map((signal) => (interval === '4h' ? signal.swingLevel : signal.intradayLevel))
            .filter((level): level is number => level !== null);
        if (levels.length === 0) {
            throw new Error(`Exhausted ${interval} timeframe has no active signal level`);
        }
        level = Math.max(...levels);
        at = state.qualified13At ?? state.setup9At;
    } else {
        level = STRENGTH_V1.nineLevel;
        at = state.setup9At;
    }

    const ageBars = at === null ? null : (lastClosedBarTime - at) / INTERVAL_MS[interval];
    const fresh =
        ageBars === null
            ? STRENGTH_V1.freshFloor
            : Math.max(STRENGTH_V1.freshFloor, 1 - ageBars / STRENGTH_V1.freshSpanBars);

    return { side, level, ageBars, fresh, e: level * fresh };
}

export function strengthLabel(strength: number): StrengthLabel {
    if (strength >= STRENGTH_V1.strongFrom) return 'strong';
    if (strength >= STRENGTH_V1.moderateFrom) return 'moderate';
    return 'weak';
}

function toStrength(raw: number): number {
    return Math.min(100, Math.max(0, Math.round(raw)));
}

interface SideResult {
    raw: number;
    strength: number;
    anchor: ScoredInterval | null;
    confluent: ScoredInterval[];
    conflicting: ScoredInterval[];
}

function scoreSide(
    side: DemarkSide,
    scores: Readonly<Record<ScoredInterval, TimeframeScore | null>>
): SideResult {
    const same: ScoredInterval[] = [];
    const opposite: ScoredInterval[] = [];
    for (const interval of SCORED_INTERVALS) {
        const score = scores[interval];
        if (!score) continue;
        (score.side === side ? same : opposite).push(interval);
    }
    if (same.length === 0) {
        return { raw: 0, strength: 0, anchor: null, confluent: [], conflicting: opposite };
    }

    // Intervals iterate small to large, so >= lets the larger timeframe win ties.
    let anchor = same[0] as ScoredInterval;
    for (const interval of same) {
        if ((scores[interval] as TimeframeScore).e >= (scores[anchor] as TimeframeScore).e) anchor = interval;
    }

    let raw = STRENGTH_V1.anchorWeight * (scores[anchor] as TimeframeScore).e;
    for (const interval of same) {
        if (interval !== anchor) raw += STRENGTH_V1.confluenceWeight * (scores[interval] as TimeframeScore).e;
    }
    for (const interval of opposite) {
        raw -= STRENGTH_V1.conflictWeight[interval] * (scores[interval] as TimeframeScore).e;
    }
    const strength = toStrength(raw);
    return { raw, strength, anchor, confluent: same, conflicting: opposite };
}

/** The timeframe a card's direction comes from (facts.mainLine's direction and leadInterval) with its score in `scores`. */
export interface CardLead {
    direction: Lean;
    interval: ScoredInterval;
    score: TimeframeScore;
}

/**
 * The lead is the anchor: 12 x its e, plus 4 x e for every other scored timeframe on its side. The other
 * side's timeframes are listed, not subtracted, so a directional card never reads 0.
 */
function leadStrength(scores: Readonly<Record<ScoredInterval, TimeframeScore | null>>, lead: CardLead): CardStrength {
    const side: DemarkSide = lead.direction === 'bullish' ? 'buy' : 'sell';
    if (lead.score.side !== side) {
        throw new Error(`The ${lead.interval} lead scores ${lead.score.side} against its ${lead.direction} direction`);
    }
    const confluent: ScoredInterval[] = [];
    const conflicting: ScoredInterval[] = [];
    let raw = STRENGTH_V1.anchorWeight * lead.score.e;
    for (const interval of SCORED_INTERVALS) {
        const score = scores[interval];
        if (!score) continue;
        if (score.side !== side) {
            conflicting.push(interval);
            continue;
        }
        confluent.push(interval);
        if (interval !== lead.interval) raw += STRENGTH_V1.confluenceWeight * score.e;
    }
    const strength = toStrength(raw);
    return {
        direction: lead.direction,
        strength,
        strengthLabel: strengthLabel(strength),
        anchorInterval: lead.interval,
        confluentIntervals: confluent,
        conflictingIntervals: conflicting
    };
}

/**
 * With a lead (facts.mainLine, v1.3) the card points the lead's way and is scored from it. Without one
 * (v1.2): the stronger side, neutral on a tie.
 */
export function cardStrength(
    scores: Readonly<Record<ScoredInterval, TimeframeScore | null>>,
    lead: CardLead | null
): CardStrength {
    if (lead !== null) {
        return leadStrength(scores, lead);
    }
    const buy = scoreSide('buy', scores);
    const sell = scoreSide('sell', scores);
    if (buy.strength === sell.strength) {
        return {
            direction: 'neutral',
            strength: 0,
            strengthLabel: 'weak',
            anchorInterval: null,
            confluentIntervals: [],
            conflictingIntervals: []
        };
    }
    const winner = buy.strength > sell.strength ? buy : sell;
    const direction: CardDirection = winner === buy ? 'bullish' : 'bearish';
    return {
        direction,
        strength: winner.strength,
        strengthLabel: strengthLabel(winner.strength),
        anchorInterval: winner.anchor,
        confluentIntervals: winner.confluent,
        conflictingIntervals: winner.conflicting
    };
}
