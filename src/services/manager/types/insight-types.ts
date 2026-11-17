// Signal insight panel types. The DeMark summary types mirror the Python reference
// summary.py field for field: camelCase names, datetimes as epoch
// milliseconds (bar open times), prices as decimal strings.

import { DemarkSide } from './demark-types';

export type DemarkTrend = 'up' | 'down';
export type InsightInterval = '5m' | '15m' | '1h' | '4h' | '1d';
export const INSIGHT_INTERVALS: readonly InsightInterval[] = ['5m', '15m', '1h', '4h', '1d'];

export interface DemarkRound {
    side: DemarkSide;
    trend: DemarkTrend;
    setup: number;
    countdown: number;
    setup9At: number | null;
    qualified13At: number | null;
}

export interface DemarkSignalRef {
    kind: 9 | 13;
    at: number;
    side: DemarkSide;
}

export interface DemarkPrevCountdown {
    side: DemarkSide;
    countdown: number;
    qualified: boolean;
    barsAgo: number;
}

export interface DemarkSecondSetup {
    side: DemarkSide;
    trend: DemarkTrend;
    step: number;
    setup9At: number | null;
}

export interface DemarkSetupRun {
    start: number;
    side: DemarkSide;
    count: number;
    active: boolean;
    completed: boolean;
}

export interface DemarkNextBarNeeds {
    direction: 'above' | 'below';
    price: string;
}

export interface DemarkSummaryRisk {
    risk9: string | null;
    risk9At: number | null;
    setupClose: string | null;
    riskLevel: string | null;
    risk13At: number | null;
    provisional: boolean;
    close13: string | null;
    tdst: string | null;
    nextBarNeeds: DemarkNextBarNeeds | null;
}

export interface DemarkSummary {
    side: DemarkSide;
    trend: DemarkTrend;
    phase: 'setup' | 'countdown';
    step: number;
    target: 9 | 13;
    setupStep: number;
    countdownStep: number;
    rounds: DemarkRound[];
    lastSignal: DemarkSignalRef | null;
    prev: DemarkPrevCountdown | null;
    second: DemarkSecondSetup | null;
    barsSinceQualified13: number | null;
    setupRun: DemarkSetupRun;
    risk: DemarkSummaryRisk;
    /** Close time of the window's last bar. */
    asOf: number;
    close: string;
}

export type Regime = 'decay' | 'rev' | 'pump' | 'none' | 'unavailable';

export interface TimeframeRegimeState {
    s9: 'up' | 'down' | 'none';
    s13: boolean;
    carry13: boolean;
    countdown: number;
    setup9At: number | null;
    qualified13At: number | null;
    setup9SecondsAgo: number | null;
    qualified13SecondsAgo: number | null;
    beyondRisk9: boolean | null;
}

export interface RegimeSignal {
    n: 1 | 2;
    side: DemarkSide;
    active: boolean;
    price: string | null;
    baseLevel: number | null;
    intradayLevel: number | null;
    swingLevel: number | null;
}

export interface NewTrend {
    present: boolean;
    trend: DemarkTrend;
    step: number;
    confirmed: boolean;
    seconds: number | null;
}

export type CardDirection = 'bullish' | 'bearish' | 'neutral';
/** The direction one timeframe points to (`TimeframeStructure.lean`). */
export type Lean = 'bullish' | 'bearish';
export type StrengthLabel = 'weak' | 'moderate' | 'strong';
export type ScoredInterval = '5m' | '15m' | '1h' | '4h';

export interface TimeframeScore {
    side: DemarkSide;
    level: number;
    ageBars: number | null;
    fresh: number;
    e: number;
}

export interface CardStrength {
    direction: CardDirection;
    strength: number;
    strengthLabel: StrengthLabel;
    /** With a main line, its lead timeframe (`MainLineFact.leadInterval`). Without a main line, the same-side scored timeframe with the largest evidence (v1.2); null on a neutral card. */
    anchorInterval: ScoredInterval | null;
    confluentIntervals: ScoredInterval[];
    conflictingIntervals: ScoredInterval[];
}

// Insight facts (spec section 6): rule-computed inputs for the AI text, also returned by the API.
// Prices are decimal strings without trailing zeros; percentages are two-decimal signed strings.

export type TimelineStatus = 'reached13' | 'running' | 'cancelled' | 'recycled' | 'held' | 'standing' | 'failed';

export interface TimelineEvent {
    kind: 9 | 13;
    side: DemarkSide;
    barsAgo: number;
    price: string;
    status: TimelineStatus;
}

export interface TimeframeStructure {
    interval: InsightInterval;
    close: string;
    trend: DemarkTrend;
    stage: 'forming' | 'established' | 'exhausted';
    setupStep: number;
    countdown: number;
    formingOpposite: { trend: DemarkTrend; step: number } | null;
    timeline: TimelineEvent[];
    /** Exhausted by a 13 whose risk level has broken since: the timeframe has no lean and is not scored. */
    thirteenFailed: boolean;
    /**
     * The force reading (R32), read once here for the card, the text and the frontend: a move counting
     * from 9 toward 13 leans its own way (up bullish, down bearish); once exhausted by an intact 13 it
     * turns (up bearish, down bullish). Null while forming or once the 13 has failed.
     */
    lean: Lean | null;
}

export interface Live13 {
    interval: InsightInterval;
    side: DemarkSide;
    barsAgo: number;
    price: string;
    riskLevel: string;
    intact: boolean;
    roomPct: string;
    sincePct: string;
    oppositeSetup: number;
}

/** `unclear`: the move since the signal is under 0.25% either way, as rounded for the text. */
export type ReviewVerdict = 'confirmed' | 'unconfirmed' | 'unclear' | 'failed' | 'pending';

export interface ReviewItem {
    interval: InsightInterval;
    /**
     * 9: a completed Setup; 13: a qualified Countdown. A 13 is measured against the reversal (buy up, sell
     * down); a 9 against its own move continuing (buy 9 down, sell 9 up), matching the force reading (R32).
     */
    kind: 9 | 13;
    side: DemarkSide;
    barsAgo: number;
    price: string;
    windowBars: number;
    favorablePct: string | null;
    adversePct: string | null;
    afterPct: string | null;
    /** The move from the signal bar's close to the newest 5m close, as `Live13.sincePct`; the verdict reads it. */
    sincePct: string;
    verdict: ReviewVerdict;
    /** Bars since the verdict settled: the risk breach for a failed 13, else bar t+12; null until then. */
    settledBarsAgo: number | null;
}

export type FocusItem =
    | { pattern: 'relay-exhaustion'; small: InsightInterval; big: InsightInterval; side: DemarkSide; bigCountdown: number }
    | {
          pattern: 'counter-move-ending';
          small: InsightInterval;
          big: InsightInterval;
          bigTrend: DemarkTrend;
          bigCountdown: number;
      }
    | { pattern: 'bounce-in-trend'; small: InsightInterval; bigs: InsightInterval[]; bigTrend: DemarkTrend }
    | { pattern: 'resonance'; side: DemarkSide; intervals: InsightInterval[] }
    | { pattern: 'thirteen-failed'; interval: InsightInterval; side: DemarkSide }
    | { pattern: 'near-exhaustion'; interval: InsightInterval; trend: DemarkTrend; countdown: number };

/** The timeframe the reading follows (R34) and the direction it points to. */
export interface MainLineFact {
    interval: InsightInterval;
    direction: Lean;
    /**
     * The timeframe the direction comes from, which leads the card's strength: the main line, or for a main 13
     * that is only a bounce inside bigger moves, the biggest of them.
     */
    leadInterval: InsightInterval;
}

export interface InsightFacts {
    structures: TimeframeStructure[];
    live13: Live13[];
    review: ReviewItem[];
    reviewPick: ReviewItem | null;
    focus: FocusItem[];
    mainLine: MainLineFact | null;
}

// AI insight text (spec section 7). zhTW is produced by opencc-js from zhCN, never by the LLM; ko and ja are written
// by code from the same clauses as the conclusion (2026-11-02).
export interface InsightSections {
    conclusion: string;
    timeframes: string;
    review: string;
    watch: string;
}

export interface InsightText {
    asOf: number;
    generatedAt: number;
    model: string;
    direction: CardDirection;
    sections: { en: InsightSections; zhCN: InsightSections; zhTW: InsightSections; ko: InsightSections; ja: InsightSections };
}

// Protection suggestion: the hedge option the
// DeMark signals suggest for a trade in the card's direction, from DeMark facts only.
export interface ProtectionStop {
    /** 13: the risk level of the protected timeframe's intact 13. 9: the TDST of a 9 still counting toward 13. */
    signal: 9 | 13;
    price: string;
    /** Room from the newest 5m close to the stop; zero or negative once price is through it. */
    distancePct: string;
}

export interface CardProtection {
    /** A put protects the long a bullish card suggests, a call the short of a bearish card. */
    optionType: 'put' | 'call';
    /** The card's anchor timeframe. */
    interval: ScoredInterval;
    /** The option expiry: the shortest offered duration covering 8 bars of `interval`, or a shorter one when the stop is nearer than its shallowest strike. */
    durationSeconds: number;
    /** `interval`'s protection price: its intact 13's risk level, or the TDST of a 9 still counting; null when it has none. */
    stop: ProtectionStop | null;
}

/** The card's headline (2026-10-15): how far the anchor timeframe's move has gone, in place of its direction. */
export interface CardPhase {
    /** The anchor structure's stage; `forming` on a neutral card, which has no anchor. */
    stage: TimeframeStructure['stage'];
    /** "长趋势下跌反转", "短趋势上涨确立"; "趋势形成中" on a neutral card. */
    title: { en: string; zhCN: string; zhTW: string; ko: string; ja: string };
}

// Insight snapshot (spec section 9): written by the sync leader, served by the API as is.
export interface InsightCard extends CardStrength {
    phase: CardPhase;
    /** Null for a neutral card. */
    protection: CardProtection | null;
    /** The latest AI text when its direction matches the card's; null otherwise. */
    insight: InsightText | null;
}

export interface InsightTimeframe {
    interval: InsightInterval;
    /** Open time of the window's newest closed bar. */
    lastClosedBarTime: number;
    summary: DemarkSummary | null;
    state: TimeframeRegimeState | null;
    signals: RegimeSignal[];
    newTrend: NewTrend | null;
    /** Always null for 1d, which the card never scores. */
    score: TimeframeScore | null;
}

export interface InsightSnapshot {
    symbol: string;
    source: 'binance-usdm';
    ruleset: 'td-sequential-v2';
    strengthRuleset: 'strength-v1.5';
    /** Close time of the newest closed 5m bar. */
    asOf: number;
    /** When the next snapshot is due: the next 5m close plus the tick offset. */
    nextUpdateAt: number;
    card: InsightCard;
    facts: InsightFacts;
    regime: { intraday: Regime; swing: Regime };
    timeframes: InsightTimeframe[];
}
