// Port of the Python reference alphabtc.py (AlphaBTC's DeMark Regime
// interpretation) plus the per-timeframe assembly of context.py `compose`.

import {
    DemarkSummary,
    INSIGHT_INTERVALS,
    InsightInterval,
    NewTrend,
    Regime,
    RegimeSignal,
    TimeframeRegimeState
} from '../types/insight-types';
import { DemarkSide } from '../types/demark-types';
import { decimalPlaces, toScaled } from './fixed-decimal';

const BASE_LEVEL: Record<1 | 2, number> = { 1: 2, 2: 3 };

/** Whole seconds from `at` to `asOf`; null when `at` is missing or later than `asOf`. */
function secondsAgo(asOf: number, at: number | null): number | null {
    return at !== null && asOf >= at ? Math.floor((asOf - at) / 1000) : null;
}

/** `a > b` for decimal strings. */
function greaterThan(a: string, b: string): boolean {
    const scale = Math.max(decimalPlaces(a), decimalPlaces(b));
    return toScaled(a, scale) > toScaled(b, scale);
}

/** AlphaBTC `dmkLive`: 9/13 status, keeping a just-finished 13 until a new 9 confirms. */
export function deriveState(summary: DemarkSummary): TimeframeRegimeState {
    const prev = summary.prev;
    const prevQ13 = prev !== null && prev.qualified && prev.countdown >= 13;
    const exhausted = summary.rounds
        .filter((r) => r.qualified13At !== null && r.countdown >= 13)
        .map((r) => r.qualified13At as number);
    const lastEx13 = exhausted[exhausted.length - 1] ?? null;
    const ls = summary.lastSignal;
    const last9 = ls !== null && ls.kind === 9 ? ls.at : null;
    const lastIs13 =
        (ls !== null && ls.kind === 13) || (lastEx13 !== null && (last9 === null || lastEx13 > last9));
    const carry13 = lastIs13 && summary.phase !== 'countdown' && summary.setupStep < 9 && prevQ13;
    const up = carry13 && prev !== null ? prev.side === 'sell' : summary.trend === 'up';
    const setupDone = carry13 || summary.phase === 'countdown' || summary.setupStep >= 9;
    const countdown = carry13 ? 13 : summary.phase === 'countdown' ? summary.step : 0;

    let setup9At: number | null = null;
    if (ls !== null && ls.kind === 9) {
        setup9At = ls.at;
    } else if (carry13) {
        const withBoth = summary.rounds.filter((r) => r.setup9At !== null && r.qualified13At !== null);
        const rounds = withBoth.length > 0 ? withBoth : summary.rounds.filter((r) => r.setup9At !== null);
        setup9At = rounds[rounds.length - 1]?.setup9At ?? summary.risk.risk9At;
    }
    let qualified13At: number | null;
    if (ls !== null && ls.kind === 13) {
        qualified13At = ls.at;
    } else if (carry13 && lastEx13 !== null) {
        qualified13At = lastEx13;
    } else if (summary.risk.risk13At !== null && !summary.risk.provisional) {
        qualified13At = summary.risk.risk13At;
    } else {
        qualified13At = null;
    }

    // risk9 belongs to the primary sequence's side, so compare in that direction.
    const risk9 = summary.risk.risk9;
    const rising = summary.trend === 'up';
    const beyondRisk9 =
        risk9 === null ? null : rising ? greaterThan(summary.close, risk9) : greaterThan(risk9, summary.close);

    return {
        s9: setupDone ? (up ? 'up' : 'down') : 'none',
        s13: countdown >= 13,
        carry13,
        countdown,
        setup9At,
        qualified13At,
        setup9SecondsAgo: secondsAgo(summary.asOf, setup9At),
        qualified13SecondsAgo: secondsAgo(summary.asOf, qualified13At),
        beyondRisk9
    };
}

/** AlphaBTC `cycAuto` for an anchor timeframe (1h intraday, 4h swing). */
export function regimeOf(state: TimeframeRegimeState | null): Regime {
    if (state === null) return 'unavailable';
    if (state.s9 === 'none') return 'none';
    if (state.s9 === 'down') return state.s13 ? 'pump' : 'rev';
    return state.s13 ? 'rev' : 'decay';
}

/** AlphaBTC `regimeDelta`: pump favours BUY, rev favours SELL, one level, clamped 1..5. */
export function adjustLevel(level: number, side: DemarkSide, regime: Regime): number {
    const base = regime === 'pump' ? 1 : regime === 'rev' ? -1 : 0;
    const delta = base * (side === 'buy' ? 1 : -1);
    return Math.max(1, Math.min(5, level + delta));
}

/** AlphaBTC `sigBlock`: signal 1 at a confirmed 9, signal 2 at 13. */
export function regimeSignals(
    state: TimeframeRegimeState,
    summary: DemarkSummary,
    intraday: Regime,
    swing: Regime
): RegimeSignal[] {
    const side: DemarkSide = state.s9 === 'down' ? 'buy' : 'sell';
    const specs: [1 | 2, boolean, string | null][] = [
        [1, state.s9 !== 'none', summary.risk.setupClose],
        [2, state.s13, summary.risk.close13]
    ];
    return specs.map(([n, active, price]) => {
        const base = BASE_LEVEL[n];
        return {
            n,
            side,
            active,
            price,
            baseLevel: active ? base : null,
            intradayLevel: active ? adjustLevel(base, side, intraday) : null,
            swingLevel: active ? adjustLevel(base, side, swing) : null
        };
    });
}

/** AlphaBTC `tdNew`: the setup forming beside an old countdown, or the setup itself. */
export function newTrend(summary: DemarkSummary): NewTrend {
    let trend: NewTrend['trend'];
    let step: number;
    let setup9At: number | null;
    if (summary.second !== null) {
        trend = summary.second.trend;
        step = summary.second.step;
        setup9At = summary.second.setup9At;
    } else if (summary.phase === 'setup') {
        trend = summary.trend;
        step = summary.step;
        const ls = summary.lastSignal;
        setup9At = ls !== null && ls.kind === 9 ? ls.at : null;
    } else {
        return { present: false, trend: summary.trend, step: 0, confirmed: false, seconds: null };
    }
    const confirmed = step >= 9;
    return {
        present: true,
        trend,
        step,
        confirmed,
        seconds: secondsAgo(summary.asOf, confirmed ? setup9At : summary.setupRun.start)
    };
}

export interface ComposedTimeframe {
    state: TimeframeRegimeState | null;
    signals: RegimeSignal[];
    newTrend: NewTrend | null;
}

/** context.py `compose`: the 1h regime is intraday, the 4h regime is swing; null summaries show nothing. */
export function composeRegime(summaries: Readonly<Record<InsightInterval, DemarkSummary | null>>): {
    regime: { intraday: Regime; swing: Regime };
    timeframes: Record<InsightInterval, ComposedTimeframe>;
} {
    const states = {} as Record<InsightInterval, TimeframeRegimeState | null>;
    for (const interval of INSIGHT_INTERVALS) {
        const summary = summaries[interval];
        states[interval] = summary === null ? null : deriveState(summary);
    }
    const intraday = regimeOf(states['1h']);
    const swing = regimeOf(states['4h']);
    const timeframes = {} as Record<InsightInterval, ComposedTimeframe>;
    for (const interval of INSIGHT_INTERVALS) {
        const summary = summaries[interval];
        const state = states[interval];
        timeframes[interval] =
            summary === null || state === null
                ? { state: null, signals: [], newTrend: null }
                : { state, signals: regimeSignals(state, summary, intraday, swing), newTrend: newTrend(summary) };
    }
    return { regime: { intraday, swing }, timeframes };
}
