/**
 * Insight facts (spec section 6): per-timeframe structure, live 13s, the 13 review, focus patterns
 * and the main line, all decided by rules. The AI text only puts these into words and copies the numbers
 * verbatim, so prices are decimal strings without trailing zeros and percentages are two-decimal
 * strings. The facts read 5m to 4h only, the timeframes the panel's table lists (R36). Pure: no I/O and
 * no clock.
 */

import { INTERVAL_MS, KlineRow } from './binance-klines';
import { CountdownStatus, SequenceState } from './engine';
import { fromScaled } from './fixed-decimal';
import { ComposedTimeframe } from './regime';
import { SCORED_INTERVALS } from './strength';
import { WindowAnalysis } from './summary';
import { DemarkSide } from '../types/demark-types';
import {
    DemarkTrend,
    FocusItem,
    INSIGHT_INTERVALS,
    InsightFacts,
    InsightInterval,
    Lean,
    Live13,
    MainLineFact,
    ReviewItem,
    ReviewVerdict,
    TimeframeStructure,
    TimelineEvent,
    TimelineStatus
} from '../types/insight-types';

/** Bars after a 13 over which its reaction is measured and its risk level must hold. */
export const REACTION_WINDOW_BARS = 12;
/** A move since a signal smaller than this (in percent, as rounded for the text) is no clear reaction. */
export const REACTION_MIN_PCT = 0.25;
const TIMELINE_EVENTS = 3;
const REVIEWS_PER_TIMEFRAME = 2;
const FOCUS_LIMIT = 4;
const LATE_COUNTDOWNS: readonly number[] = [11, 12];
const COUNTER_MOVE_MAX_COUNTDOWN = 6;
/** A bigger timeframe further along than this is a relay, not a move a smaller 13 only bounces inside. */
const BOUNCE_MAX_COUNTDOWN = 10;

export interface TimeframeInput {
    analysis: WindowAnalysis;
    composed: ComposedTimeframe;
}

/** The move a 13 exhausts: a sell 13 tops an up move, a buy 13 bottoms a down move. */
const EXHAUSTS: Record<DemarkSide, DemarkTrend> = { sell: 'up', buy: 'down' };
/** The trend a 13 expects next. */
const REVERSAL: Record<DemarkSide, DemarkTrend> = { sell: 'down', buy: 'up' };
/** The force reading (R32): a move counting from 9 toward 13 still has its force and leans its own way. */
const COUNTING_LEAN: Record<DemarkTrend, Lean> = { up: 'bullish', down: 'bearish' };
/** Once an intact 13 exhausts the move, the lean turns. */
const EXHAUSTED_LEAN: Record<DemarkTrend, Lean> = { up: 'bearish', down: 'bullish' };

const NINE_STATUS: Record<CountdownStatus, TimelineStatus> = {
    qualified13: 'reached13',
    active: 'running',
    count13_unqualified: 'running',
    cancelled: 'cancelled',
    recycled: 'recycled',
    inactive: 'held'
};

/** Two decimals, as JS `toFixed` rounds; a negative zero is written "0.00". */
export function formatPct(value: number): string {
    const text = value.toFixed(2);
    return text === '-0.00' ? '0.00' : text;
}

/** Decimal text without trailing fractional zeros: "82638.10" → "82638.1", "100.000" → "100". */
export function trimPrice(text: string): string {
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** Percent change from `from` to `to`. */
function changePct(from: number, to: number): number {
    return (to / from - 1) * 100;
}

function rank(interval: InsightInterval): number {
    return INSIGHT_INTERVALS.indexOf(interval);
}

function intervalOf(analysis: WindowAnalysis): InsightInterval {
    const interval = INSIGHT_INTERVALS.find((i) => i === analysis.interval);
    if (interval === undefined) {
        throw new Error(`${analysis.interval} is not an insight interval`);
    }
    return interval;
}

function lastOf<T>(items: readonly T[]): T {
    const item = items[items.length - 1];
    if (item === undefined) {
        throw new Error('Expected a non-empty list');
    }
    return item;
}

function rowAt(analysis: WindowAnalysis, bar: number): KlineRow {
    const row = analysis.rows[bar];
    if (row === undefined) {
        throw new Error(`Bar ${bar} is outside the ${analysis.interval} window`);
    }
    return row;
}

interface Signal {
    seq: SequenceState;
    /** The bar the 9 completed or the 13 qualified on. */
    bar: number;
}

/** The window's qualified 13s, oldest first. */
function thirteens(analysis: WindowAnalysis): Signal[] {
    return analysis.engine.sequences
        .filter((seq) => seq.countdownStatus === 'qualified13')
        .map((seq) => ({ seq, bar: lastOf(seq.countdown) }))
        .sort((a, b) => a.bar - b.bar);
}

/** The window's completed Setups (9s), oldest first. */
function nines(analysis: WindowAnalysis): Signal[] {
    return analysis.engine.sequences
        .filter((seq) => seq.setupStatus === 'completed')
        .map((seq) => ({ seq, bar: lastOf(seq.setup) }))
        .sort((a, b) => a.bar - b.bar);
}

/**
 * The newest qualified 13 on the trend's side (a sell 13 exhausts an up move, a buy 13 a down move),
 * and whether no 9 on that side completed after it.
 */
export function trendThirteen(analysis: WindowAnalysis, trend: DemarkTrend): { signal: Signal; newest: boolean } | null {
    const signal = thirteens(analysis)
        .filter(({ seq }) => EXHAUSTS[seq.side] === trend)
        .pop();
    if (signal === undefined) {
        return null;
    }
    // A 9 on the 13's own bar is not after it: setups complete before countdowns count, so retain_active holds that 9.
    const newest = !nines(analysis).some(({ seq, bar }) => seq.side === signal.seq.side && bar > signal.bar);
    return { signal, newest };
}

export function timeframeStructure({ analysis, composed }: TimeframeInput): TimeframeStructure | null {
    const { summary } = analysis;
    const { state, newTrend } = composed;
    if (summary === null || state === null) {
        return null;
    }
    const last = analysis.rows.length - 1;

    const events: { bar: number; kind: 9 | 13; side: DemarkSide; status: TimelineStatus }[] = [];
    for (const seq of analysis.engine.sequences) {
        if (seq.setupStatus === 'completed') {
            events.push({ bar: lastOf(seq.setup), kind: 9, side: seq.side, status: NINE_STATUS[seq.countdownStatus] });
        }
        if (seq.countdownStatus === 'qualified13') {
            const status = seq.riskStatus === 'invalidated' ? 'failed' : 'standing';
            events.push({ bar: lastOf(seq.countdown), kind: 13, side: seq.side, status });
        }
    }
    const timeline: TimelineEvent[] = events
        .sort((a, b) => a.bar - b.bar || a.kind - b.kind)
        .slice(-TIMELINE_EVENTS)
        .map(({ bar, kind, side, status }) => ({
            kind,
            side,
            barsAgo: last - bar,
            price: trimPrice(rowAt(analysis, bar).close),
            status
        }));

    // The structure describes the established (or exhausted) trend, whose setup completed; a carried
    // 13 belongs to the previous run, and the forming run shows up as formingOpposite.
    const established = state.s9 !== 'none';
    const trend = state.s9 !== 'none' ? state.s9 : summary.trend;
    // While retain_active holds the newest 9 and an older countdown reaches 13, the state still reads
    // that 9 (countdown 0); the facts call the move exhausted. The state stays an exact port of the Python reference.
    const thirteen = established ? trendThirteen(analysis, trend) : null;
    const exhausted = state.s13 || thirteen?.newest === true;
    const thirteenFailed = exhausted && thirteen?.signal.seq.riskStatus === 'invalidated';
    let lean: Lean | null = null;
    if (exhausted) {
        lean = thirteenFailed ? null : EXHAUSTED_LEAN[trend];
    } else if (established) {
        lean = COUNTING_LEAN[trend];
    }
    return {
        interval: intervalOf(analysis),
        close: summary.close,
        trend,
        stage: exhausted ? 'exhausted' : established ? 'established' : 'forming',
        setupStep: established ? 9 : summary.setupStep,
        countdown: exhausted ? 13 : state.countdown,
        formingOpposite:
            newTrend !== null && newTrend.present && newTrend.trend !== trend
                ? { trend: newTrend.trend, step: newTrend.step }
                : null,
        timeline,
        thirteenFailed,
        lean
    };
}

/**
 * The timeframe's newest 13 while it is at most 12 bars old, or for as long as it is the intact 13 that
 * keeps `structure` exhausted (R34): a new 9 on its side or a broken risk level ends that. Room and move
 * since are measured from `currentPrice`, the newest 5m close, so a 4h 13 does not read up to 4 hours stale.
 */
export function live13Of(
    { analysis, composed }: TimeframeInput,
    currentPrice: number,
    structure: TimeframeStructure | null
): Live13 | null {
    const newest = thirteens(analysis).pop();
    if (newest === undefined) {
        return null;
    }
    const last = analysis.rows.length - 1;
    const barsAgo = last - newest.bar;
    const exhaustsStructure =
        structure !== null &&
        structure.stage === 'exhausted' &&
        !structure.thirteenFailed &&
        EXHAUSTS[newest.seq.side] === structure.trend;
    if (barsAgo > REACTION_WINDOW_BARS && !exhaustsStructure) {
        return null;
    }
    const { seq } = newest;
    if (seq.risk === null) {
        throw new Error(`Qualified 13 of sequence ${seq.id} has no risk level`);
    }
    const riskLevel = fromScaled(seq.risk, analysis.scale);
    const price = trimPrice(rowAt(analysis, newest.bar).close);
    const trend = composed.newTrend;
    return {
        interval: intervalOf(analysis),
        side: seq.side,
        barsAgo,
        price,
        riskLevel,
        intact: seq.riskStatus !== 'invalidated',
        roomPct: formatPct((Math.abs(currentPrice - Number(riskLevel)) / currentPrice) * 100),
        sincePct: formatPct(changePct(Number(price), currentPrice)),
        oppositeSetup: trend !== null && trend.present && trend.trend === REVERSAL[seq.side] ? trend.step : 0
    };
}

/**
 * How a 9 or 13 played out: its next 12 bars, and its move since to `currentPrice` (the newest 5m close),
 * which the verdict reads (R34). A 13 is expected to reverse (buy up, sell down); a 9 is expected to keep
 * its own move going (buy 9 down, sell 9 up), per the force reading (R32). Only a 13 has a risk level, so
 * only a 13 can fail.
 */
function reviewItem(analysis: WindowAnalysis, kind: 9 | 13, { seq, bar }: Signal, currentPrice: number): ReviewItem {
    const last = analysis.rows.length - 1;
    const barsAgo = last - bar;
    const windowBars = Math.min(REACTION_WINDOW_BARS, barsAgo);
    const base = Number(rowAt(analysis, bar).close);
    const expectUp = (seq.side === 'buy') === (kind === 13);
    let favorable: number | null = null;
    let adverse: number | null = null;
    let after: number | null = null;
    if (windowBars > 0) {
        const window = analysis.rows.slice(bar + 1, bar + windowBars + 1);
        const rise = changePct(base, Math.max(...window.map((row) => Number(row.high))));
        const fall = -changePct(base, Math.min(...window.map((row) => Number(row.low))));
        favorable = Math.max(0, expectUp ? rise : fall);
        adverse = Math.max(0, expectUp ? fall : rise);
        after = changePct(base, Number(rowAt(analysis, bar + windowBars).close));
    }

    const sincePct = formatPct(changePct(base, currentPrice));
    const breach =
        kind === 13
            ? analysis.engine.events.find((e) => e.kind === 'invalidated' && e.sequence === seq.id)
            : undefined;
    let verdict: ReviewVerdict;
    let settledBarsAgo: number | null;
    if (breach !== undefined && breach.bar - bar <= REACTION_WINDOW_BARS) {
        verdict = 'failed';
        settledBarsAgo = last - breach.bar;
    } else {
        settledBarsAgo = barsAgo < REACTION_WINDOW_BARS ? null : barsAgo - REACTION_WINDOW_BARS;
        // Judged on the rounded figure the text shows, as soon as one bar follows the signal.
        const since = Number(sincePct);
        if (windowBars === 0) {
            verdict = 'pending';
        } else if (Math.abs(since) < REACTION_MIN_PCT) {
            verdict = 'unclear';
        } else {
            verdict = (expectUp ? since > 0 : since < 0) ? 'confirmed' : 'unconfirmed';
        }
    }

    return {
        interval: intervalOf(analysis),
        kind,
        side: seq.side,
        barsAgo,
        price: trimPrice(rowAt(analysis, bar).close),
        windowBars,
        favorablePct: favorable === null ? null : formatPct(favorable),
        adversePct: adverse === null ? null : formatPct(adverse),
        afterPct: after === null ? null : formatPct(after),
        sincePct,
        verdict,
        settledBarsAgo
    };
}

/** The timeframe's last two 13s, then its last two 9s, each oldest first; moves since run to `currentPrice`. */
export function reviewOf({ analysis }: TimeframeInput, currentPrice: number): ReviewItem[] {
    return [
        ...thirteens(analysis)
            .slice(-REVIEWS_PER_TIMEFRAME)
            .map((signal) => reviewItem(analysis, 13, signal, currentPrice)),
        ...nines(analysis)
            .slice(-REVIEWS_PER_TIMEFRAME)
            .map((signal) => reviewItem(analysis, 9, signal, currentPrice))
    ];
}

/** A settled review stays worth writing about for one reaction window of its timeframe, at most this long. */
const REVIEW_FRESH_MAX_MS = 24 * 3_600_000;

function settledAgeMs(item: ReviewItem): number | null {
    return item.settledBarsAgo === null ? null : item.settledBarsAgo * INTERVAL_MS[item.interval];
}

function isFresh(item: ReviewItem): boolean {
    const age = settledAgeMs(item);
    const window = Math.min(REACTION_WINDOW_BARS * INTERVAL_MS[item.interval], REVIEW_FRESH_MAX_MS);
    return age !== null && age <= window;
}

/** The item with the smallest age in time, skipping null ages; ties go to the larger timeframe. */
function youngest(items: readonly ReviewItem[], barsAgo: (item: ReviewItem) => number | null): ReviewItem | null {
    let best: ReviewItem | null = null;
    let bestAge = 0;
    for (const item of items) {
        const bars = barsAgo(item);
        if (bars === null) {
            continue;
        }
        const age = bars * INTERVAL_MS[item.interval];
        if (best === null || age < bestAge || (age === bestAge && rank(item.interval) > rank(best.interval))) {
            best = item;
            bestAge = age;
        }
    }
    return best;
}

/**
 * The review the text writes about. First the main line's own signal (R34): on its timeframe, the newest
 * 13 (exhausted) or 9 (established) on the side of its move, once a bar follows it. Otherwise, among
 * outcomes settled recently ({@link isFresh}): the largest timeframe, then a 13 before a 9, then the
 * newest. Without one, the newest signal still inside its 12-bar window that has not failed and has at
 * least one bar after it, then the newest settled one. Ages are compared in time across timeframes.
 */
export function pickReview(items: readonly ReviewItem[], main: TimeframeStructure | null): ReviewItem | null {
    if (main !== null) {
        const kind = main.stage === 'exhausted' ? 13 : 9;
        let own: ReviewItem | null = null;
        for (const item of items) {
            const mainSignal =
                item.interval === main.interval &&
                item.kind === kind &&
                EXHAUSTS[item.side] === main.trend &&
                item.windowBars > 0;
            if (mainSignal && (own === null || item.barsAgo < own.barsAgo)) {
                own = item;
            }
        }
        if (own !== null) {
            return own;
        }
    }
    // Positive when `a` should be written about rather than `b`.
    const preference = (a: ReviewItem, b: ReviewItem): number =>
        rank(a.interval) - rank(b.interval) || a.kind - b.kind || (settledAgeMs(b) ?? 0) - (settledAgeMs(a) ?? 0);
    let best: ReviewItem | null = null;
    for (const item of items.filter(isFresh)) {
        if (best === null || preference(item, best) > 0) {
            best = item;
        }
    }
    return (
        best ??
        // A signal on the newest bar has no move to review yet.
        youngest(items, (item) =>
            item.settledBarsAgo === null && item.verdict !== 'failed' && item.windowBars > 0 ? item.barsAgo : null
        ) ??
        youngest(items, (item) => item.settledBarsAgo)
    );
}

function biggestFirst(structures: readonly TimeframeStructure[]): TimeframeStructure[] {
    return [...structures].sort((a, b) => rank(b.interval) - rank(a.interval));
}

function largest(items: readonly Live13[]): Live13 | undefined {
    let best: Live13 | undefined;
    for (const item of items) {
        if (best === undefined || rank(item.interval) > rank(best.interval)) {
            best = item;
        }
    }
    return best;
}

export function focusOf(structures: readonly TimeframeStructure[], live13: readonly Live13[]): FocusItem[] {
    // `order` sorts within a priority: the larger timeframe first.
    const found: { priority: number; order: number; item: FocusItem }[] = [];
    const intact = live13.filter((live) => live.intact);
    const relayBigs = new Set<InsightInterval>();

    // The big timeframe comes from the structures, not the state: a held 9 whose older countdown reached
    // 13 reads exhausted there, while the state still shows that 9 at countdown 0.
    for (const structure of structures) {
        if (structure.stage !== 'established') {
            continue;
        }
        const { interval: big, trend, countdown } = structure;
        const smaller = intact.filter((live) => rank(live.interval) < rank(big));
        if (LATE_COUNTDOWNS.includes(countdown)) {
            const small = largest(smaller.filter((live) => EXHAUSTS[live.side] === trend));
            if (small !== undefined) {
                relayBigs.add(big);
                found.push({
                    priority: 1,
                    order: rank(big),
                    item: {
                        pattern: 'relay-exhaustion',
                        small: small.interval,
                        big,
                        side: small.side,
                        bigCountdown: countdown
                    }
                });
            }
        }
        if (countdown <= COUNTER_MOVE_MAX_COUNTDOWN) {
            const small = largest(smaller.filter((live) => EXHAUSTS[live.side] !== trend));
            if (small !== undefined) {
                found.push({
                    priority: 2,
                    order: rank(big),
                    item: {
                        pattern: 'counter-move-ending',
                        small: small.interval,
                        big,
                        bigTrend: trend,
                        bigCountdown: countdown
                    }
                });
            }
        }
    }

    // A smaller 13 that exhausts the same move bigger timeframes are still counting (Countdown up to 10)
    // is only a bounce or pullback inside them: at most one per direction, with every such bigger timeframe.
    for (const trend of ['up', 'down'] as const) {
        const bigs = biggestFirst(
            structures.filter(
                (s) => s.stage === 'established' && s.trend === trend && s.countdown <= BOUNCE_MAX_COUNTDOWN
            )
        );
        const [biggest] = bigs;
        if (biggest === undefined) {
            continue;
        }
        const small = largest(
            intact.filter((live) => EXHAUSTS[live.side] === trend && rank(live.interval) < rank(biggest.interval))
        );
        if (small === undefined) {
            continue;
        }
        found.push({
            priority: 2,
            order: rank(biggest.interval),
            item: {
                pattern: 'bounce-in-trend',
                small: small.interval,
                bigs: bigs.filter((s) => rank(s.interval) > rank(small.interval)).map((s) => s.interval),
                bigTrend: trend
            }
        });
    }

    for (const side of ['buy', 'sell'] as const) {
        const intervals = intact
            .filter((live) => live.side === side)
            .map((live) => live.interval)
            .sort((a, b) => rank(a) - rank(b));
        if (intervals.length >= 2) {
            found.push({ priority: 3, order: rank(lastOf(intervals)), item: { pattern: 'resonance', side, intervals } });
        }
    }

    for (const live of live13) {
        if (!live.intact) {
            found.push({
                priority: 4,
                order: rank(live.interval),
                item: { pattern: 'thirteen-failed', interval: live.interval, side: live.side }
            });
        }
    }

    for (const structure of structures) {
        if (LATE_COUNTDOWNS.includes(structure.countdown) && !relayBigs.has(structure.interval)) {
            found.push({
                priority: 5,
                order: rank(structure.interval),
                item: {
                    pattern: 'near-exhaustion',
                    interval: structure.interval,
                    trend: structure.trend,
                    countdown: structure.countdown
                }
            });
        }
    }

    return found
        .sort((a, b) => a.priority - b.priority || b.order - a.order)
        .slice(0, FOCUS_LIMIT)
        .map((entry) => entry.item);
}

/** The short-term timeframes (the headline's 短趋势 tier); R35 puts their 13s first. */
export const SHORT_INTERVALS: readonly InsightInterval[] = ['5m', '15m'];

export function isShort(interval: InsightInterval): boolean {
    return SHORT_INTERVALS.includes(interval);
}

/**
 * The main line's structure: an exhausted move whose 13 holds, however old, a short timeframe's first (R35:
 * the exchange's users trade short-term), and within either group one that relays into a bigger timeframe,
 * then the biggest (R34); else the biggest move at Countdown 11 or 12.
 */
export function mainLineStructure(
    structures: readonly TimeframeStructure[],
    focus: readonly FocusItem[]
): TimeframeStructure | null {
    const exhausted = structures.filter((s) => s.stage === 'exhausted' && !s.thirteenFailed);
    const short = exhausted.filter((s) => isShort(s.interval));
    const candidates = short.length > 0 ? short : exhausted;
    const relaying = candidates.filter((s) =>
        focus.some((item) => item.pattern === 'relay-exhaustion' && item.small === s.interval)
    );
    const [thirteen] = biggestFirst(relaying.length > 0 ? relaying : candidates);
    if (thirteen !== undefined) {
        return thirteen;
    }
    const [near] = biggestFirst(
        structures.filter((s) => s.stage === 'established' && LATE_COUNTDOWNS.includes(s.countdown))
    );
    return near ?? null;
}

const RELATION_PATTERNS: readonly FocusItem['pattern'][] = [
    'relay-exhaustion',
    'counter-move-ending',
    'bounce-in-trend',
    'resonance'
];

function involves(item: FocusItem, main: InsightInterval): boolean {
    switch (item.pattern) {
        case 'relay-exhaustion':
        case 'counter-move-ending':
            return item.small === main || item.big === main;
        case 'bounce-in-trend':
            return item.small === main;
        case 'resonance':
            return item.intervals.includes(main);
        default:
            return false;
    }
}

/**
 * The relation between timeframes the reading names: among the relay, counter-move, bounce and
 * resonance items, the first that involves the main line, else the first. `focus` is in priority order.
 * A resonance that involves the main line is taken when that first one is a relay (the reference product names 13s
 * that still hold together even when a bigger timeframe is at Countdown 11 or 12), and always on a short
 * main line (R35), so the conclusion names the long 13s reversing with it.
 */
export function relationItemOf(focus: readonly FocusItem[], main: InsightInterval | null): FocusItem | null {
    const relations = focus.filter((item) => RELATION_PATTERNS.includes(item.pattern));
    const involved = main === null ? [] : relations.filter((item) => involves(item, main));
    const [first] = involved;
    if (first?.pattern === 'relay-exhaustion' || (main !== null && isShort(main))) {
        const resonance = involved.find((item) => item.pattern === 'resonance');
        if (resonance !== undefined) {
            return resonance;
        }
    }
    return first ?? relations[0] ?? null;
}

/**
 * A 1h-or-bigger main 13 that is only a bounce inside bigger moves points the way those moves count, led by the
 * biggest of them; otherwise, a short main line always (R35), the main line leads with its lean.
 */
function mainLineFact(main: TimeframeStructure | null, focus: readonly FocusItem[]): MainLineFact | null {
    if (main === null) {
        return null;
    }
    const relation = relationItemOf(focus, main.interval);
    if (relation?.pattern === 'bounce-in-trend' && relation.small === main.interval && !isShort(main.interval)) {
        const [biggest] = relation.bigs;
        if (biggest === undefined) {
            throw new Error(`Bounce on ${main.interval} has no bigger timeframe`);
        }
        return { interval: main.interval, direction: COUNTING_LEAN[relation.bigTrend], leadInterval: biggest };
    }
    if (main.lean === null) {
        throw new Error(`Main line ${main.interval} has no lean`);
    }
    return { interval: main.interval, direction: main.lean, leadInterval: main.interval };
}

export function buildFacts(inputs: Readonly<Record<InsightInterval, TimeframeInput>>): InsightFacts {
    const structures: TimeframeStructure[] = [];
    const live13: Live13[] = [];
    const review: ReviewItem[] = [];
    const currentPrice = Number(lastOf(inputs['5m'].analysis.rows).close);
    // R36: 1d is in the inputs for the regime, but the panel reads only the timeframes its table lists.
    for (const interval of SCORED_INTERVALS) {
        const input = inputs[interval];
        const structure = timeframeStructure(input);
        if (structure !== null) {
            structures.push(structure);
        }
        const live = live13Of(input, currentPrice, structure);
        if (live !== null) {
            live13.push(live);
        }
        review.push(...reviewOf(input, currentPrice));
    }
    const focus = focusOf(structures, live13);
    const main = mainLineStructure(structures, focus);
    return {
        structures,
        live13,
        review,
        reviewPick: pickReview(review, main),
        focus,
        mainLine: mainLineFact(main, focus)
    };
}
