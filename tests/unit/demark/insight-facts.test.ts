import { INTERVAL_MS, KlineRow } from '../../../src/services/manager/demark/binance-klines';
import { CountdownStatus, EngineEvent, RiskStatus, SequenceState } from '../../../src/services/manager/demark/engine';
import {
    REACTION_MIN_PCT,
    REACTION_WINDOW_BARS,
    TimeframeInput,
    buildFacts,
    focusOf,
    formatPct,
    live13Of,
    mainLineStructure,
    pickReview,
    relationItemOf,
    reviewOf,
    timeframeStructure,
    trimPrice
} from '../../../src/services/manager/demark/insight-facts';
import { ComposedTimeframe, composeRegime, deriveState } from '../../../src/services/manager/demark/regime';
import { WindowAnalysis, analyzeWindow } from '../../../src/services/manager/demark/summary';
import { DemarkSide } from '../../../src/services/manager/types/demark-types';
import {
    DemarkSummary,
    DemarkTrend,
    FocusItem,
    INSIGHT_INTERVALS,
    InsightFacts,
    InsightInterval,
    Live13,
    NewTrend,
    ReviewItem,
    ReviewVerdict,
    TimeframeRegimeState,
    TimeframeStructure
} from '../../../src/services/manager/types/insight-types';
import { loadJson, readingLean, toRows } from './helpers';

type Price = number | string;
type Bar = [high: Price, low: Price, close: Price];

function rows(interval: InsightInterval, bars: readonly Bar[]): KlineRow[] {
    return bars.map(([high, low, close], i) => ({
        openTime: i * INTERVAL_MS[interval],
        high: String(high),
        low: String(low),
        close: String(close)
    }));
}

function flat(count: number, price: Price): Bar[] {
    return Array.from({ length: count }, (): Bar => [price, price, price]);
}

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function summary(partial: Partial<DemarkSummary> = {}): DemarkSummary {
    return {
        side: 'buy',
        trend: 'down',
        phase: 'setup',
        step: 0,
        target: 9,
        setupStep: 0,
        countdownStep: 0,
        rounds: [],
        lastSignal: null,
        prev: null,
        second: null,
        barsSinceQualified13: null,
        setupRun: { start: 0, side: 'buy', count: 0, active: false, completed: false },
        risk: {
            risk9: null,
            risk9At: null,
            setupClose: null,
            riskLevel: null,
            risk13At: null,
            provisional: false,
            close13: null,
            tdst: null,
            nextBarNeeds: null
        },
        asOf: 0,
        close: '0',
        ...partial
    };
}

function state(partial: Partial<TimeframeRegimeState> = {}): TimeframeRegimeState {
    return {
        s9: 'none',
        s13: false,
        carry13: false,
        countdown: 0,
        setup9At: null,
        qualified13At: null,
        setup9SecondsAgo: null,
        qualified13SecondsAgo: null,
        beyondRisk9: null,
        ...partial
    };
}

function composed(st: Partial<TimeframeRegimeState> = {}, trend: NewTrend | null = null): ComposedTimeframe {
    return { state: state(st), signals: [], newTrend: trend };
}

function newTrendOf(present: boolean, trend: DemarkTrend, step: number): NewTrend {
    return { present, trend, step, confirmed: step >= 9, seconds: null };
}

/** A completed Setup whose 9 is on bar `nineAt`. */
function nine(id: number, side: DemarkSide, nineAt: number, countdownStatus: CountdownStatus): SequenceState {
    return {
        id,
        side,
        setup: range(nineAt - 8, nineAt),
        setupStatus: 'completed',
        perfected: false,
        countdown: [],
        countdownStatus,
        tdst: null,
        risk: null,
        riskStatus: 'not_available'
    };
}

/** A qualified 13 on bar `at` (at >= 21) with a scaled risk level. */
function thirteen(
    id: number,
    side: DemarkSide,
    at: number,
    risk = 0n,
    riskStatus: RiskStatus = 'valid'
): SequenceState {
    return {
        ...nine(id, side, at - 13, 'qualified13'),
        countdown: range(at - 12, at),
        risk,
        riskStatus
    };
}

function invalidated(seq: SequenceState, bar: number): EngineEvent {
    return { kind: 'invalidated', sequence: seq.id, side: seq.side, bar, count: null, reason: 'risk_level_breach' };
}

function analysis(
    interval: InsightInterval,
    bars: readonly Bar[],
    sequences: SequenceState[],
    options: { events?: EngineEvent[]; scale?: number; summary?: DemarkSummary | null } = {}
): WindowAnalysis {
    return {
        interval,
        rows: rows(interval, bars),
        scale: options.scale ?? 0,
        engine: { sequences, events: options.events ?? [] },
        summary: options.summary === undefined ? summary() : options.summary
    };
}

function input(a: WindowAnalysis, c: ComposedTimeframe = composed()): TimeframeInput {
    return { analysis: a, composed: c };
}

/**
 * Real windows from an `insight-compose-*.json` fixture, analysed and composed. `bars` keeps only the
 * first bars of a window, replaying that timeframe as of an earlier close.
 */
function fixtureInputs(
    name: string,
    bars: Partial<Record<InsightInterval, number>> = {}
): Record<InsightInterval, TimeframeInput> {
    const f = loadJson(`insight-compose-${name}.json`);
    const analyses = {} as Record<InsightInterval, WindowAnalysis>;
    const summaries = {} as Record<InsightInterval, DemarkSummary | null>;
    for (const interval of INSIGHT_INTERVALS) {
        analyses[interval] = analyzeWindow(toRows(f.windows[interval]).slice(0, bars[interval]), interval);
        summaries[interval] = analyses[interval].summary;
    }
    const { timeframes } = composeRegime(summaries);
    const inputs = {} as Record<InsightInterval, TimeframeInput>;
    for (const interval of INSIGHT_INTERVALS) {
        inputs[interval] = { analysis: analyses[interval], composed: timeframes[interval] };
    }
    return inputs;
}

/** The newest 5m close: the current price live 13s are measured from. */
function currentPrice(inputs: Record<InsightInterval, TimeframeInput>): number {
    return Number(inputs['5m'].analysis.rows.at(-1)?.close);
}

/** A window's newest qualified 13, on `side` when given, and whether a 9 on its side completed after it. */
function newestThirteen(
    analysis: WindowAnalysis,
    side?: DemarkSide
): { side: DemarkSide; riskStatus: RiskStatus; nineAfter: boolean } | undefined {
    const { sequences } = analysis.engine;
    const newest = sequences
        .filter((seq) => seq.countdownStatus === 'qualified13' && (side === undefined || seq.side === side))
        .map((seq) => ({ seq, bar: seq.countdown.at(-1) ?? NaN }))
        .sort((a, b) => a.bar - b.bar)
        .at(-1);
    if (newest === undefined) {
        return undefined;
    }
    const nineAfter = sequences.some(
        (seq) => seq.setupStatus === 'completed' && seq.side === newest.seq.side && (seq.setup.at(-1) ?? NaN) > newest.bar
    );
    return { side: newest.seq.side, riskStatus: newest.seq.riskStatus, nineAfter };
}

/** A hand-built structure whose lean follows the reading table (R32). */
function structureOf(
    interval: InsightInterval,
    trend: DemarkTrend,
    stage: TimeframeStructure['stage'],
    countdown: number
): TimeframeStructure {
    return {
        interval,
        close: '100',
        trend,
        stage,
        setupStep: 9,
        countdown,
        formingOpposite: null,
        timeline: [],
        thirteenFailed: false,
        lean: readingLean(trend, stage)
    };
}

/**
 * One timeframe of a hand-built buildFacts input: a move counting toward 13, or a move exhausted by a 13
 * `barsAgo` bars ago (a sell 13 exhausts an up move), optionally followed by a new 9 on its side or with
 * its risk level broken two bars after it. A timeframe without a frame is forming.
 */
type FactsFrame =
    | { trend: DemarkTrend; countdown: number }
    | { thirteen: DemarkSide; barsAgo: number; nineAfter?: boolean; broken?: boolean };

const FRAME_BARS = 80;
const MOVE_OF: Record<DemarkSide, DemarkTrend> = { sell: 'up', buy: 'down' };

function frameInput(interval: InsightInterval, frame: FactsFrame | undefined): TimeframeInput {
    const bars = flat(FRAME_BARS, '100');
    if (frame === undefined) {
        return input(analysis(interval, bars, []));
    }
    if ('trend' in frame) {
        return input(analysis(interval, bars, []), composed({ s9: frame.trend, countdown: frame.countdown }));
    }
    const at = FRAME_BARS - 1 - frame.barsAgo;
    const seq = thirteen(0, frame.thirteen, at, 0n, frame.broken === true ? 'invalidated' : 'valid');
    const sequences = frame.nineAfter === true ? [seq, nine(1, frame.thirteen, at + 5, 'active')] : [seq];
    const events = frame.broken === true ? [invalidated(seq, at + 2)] : [];
    return input(analysis(interval, bars, sequences, { events }), composed({ s9: MOVE_OF[frame.thirteen] }));
}

/** buildFacts over hand-built timeframes; every close, and so the current price, is 100. */
function factsOf(frames: Partial<Record<InsightInterval, FactsFrame>>): InsightFacts {
    const inputs = {} as Record<InsightInterval, TimeframeInput>;
    for (const interval of INSIGHT_INTERVALS) {
        inputs[interval] = frameInput(interval, frames[interval]);
    }
    return buildFacts(inputs);
}

describe('formatPct and trimPrice', () => {
    test.each([
        [-0.004, '0.00'],
        [0.2349, '0.23'],
        [-1.005, '-1.00'],
        [5, '5.00'],
        [-0.01198, '-0.01']
    ])('formatPct(%d) = %s', (value, expected) => {
        expect(formatPct(value)).toBe(expected);
    });

    test.each([
        ['82638.10', '82638.1'],
        ['100.000', '100'],
        ['100', '100'],
        ['0.00012300', '0.000123']
    ])('trimPrice(%s) = %s', (text, expected) => {
        expect(trimPrice(text)).toBe(expected);
    });

    test('the reaction window is 12 bars', () => {
        expect(REACTION_WINDOW_BARS).toBe(12);
    });

    test('a move under 0.25% is no clear reaction', () => {
        expect(REACTION_MIN_PCT).toBe(0.25);
    });
});

describe('timeframeStructure', () => {
    const bars = flat(60, '100.50');

    test('returns null without a summary', () => {
        expect(timeframeStructure(input(analysis('1h', bars, [], { summary: null })))).toBeNull();
    });

    test('reports the primary sequence and its stage', () => {
        const a = analysis('1h', bars, [], { summary: summary({ trend: 'up', setupStep: 4, close: '100.5' }) });
        expect(timeframeStructure(input(a, composed({ s9: 'up', countdown: 5 })))).toEqual({
            interval: '1h',
            close: '100.5',
            trend: 'up',
            stage: 'established',
            setupStep: 9,
            countdown: 5,
            formingOpposite: null,
            timeline: [],
            thirteenFailed: false,
            lean: 'bullish'
        });
    });

    test.each([
        [{ s9: 'up', s13: true, countdown: 13 }, 'exhausted'],
        [{ s9: 'down', countdown: 3 }, 'established'],
        [{ s9: 'none' }, 'forming']
    ] as const)('stage for %j is %s', (st, stage) => {
        expect(timeframeStructure(input(analysis('1h', bars, []), composed(st)))?.stage).toBe(stage);
    });

    // The force reading (R32): a move counting from 9 toward 13 leans its own way, an exhausted one turns.
    test.each([
        [{ s9: 'up', countdown: 5 }, 'established', 'bullish'],
        [{ s9: 'down', countdown: 5 }, 'established', 'bearish'],
        [{ s9: 'up', s13: true, carry13: true, countdown: 13 }, 'exhausted', 'bearish'],
        [{ s9: 'down', s13: true, carry13: true, countdown: 13 }, 'exhausted', 'bullish'],
        [{ s9: 'none' }, 'forming', null]
    ] as const)('lean for %j (%s) is %s', (st, stage, lean) => {
        const a = analysis('1h', bars, [], { summary: summary({ trend: st.s9 === 'none' ? 'up' : st.s9, setupStep: 4 }) });
        expect(timeframeStructure(input(a, composed(st)))).toMatchObject({ stage, lean });
    });

    // Shaped like a real XAUUSDT 5m window whose newest bar (2026-09-06 07:35 UTC) is a buy 13: the run's own
    // countdown has just reached 13 and no newer Setup has started, so the summary is back in its Setup phase
    // at 9/9 and the state reads countdown 0 without s13.
    test("condition (b): the run's own 13 reads as an exhausted down move, leaning bullish", () => {
        const s = summary({
            side: 'buy',
            trend: 'down',
            phase: 'setup',
            step: 9,
            setupStep: 9,
            lastSignal: { kind: 13, at: 59 * INTERVAL_MS['5m'], side: 'buy' },
            prev: { side: 'buy', countdown: 13, qualified: true, barsAgo: 0 },
            setupRun: { start: 38 * INTERVAL_MS['5m'], side: 'buy', count: 9, active: false, completed: true }
        });
        const st = deriveState(s);
        expect(st).toMatchObject({ s9: 'down', s13: false, carry13: false, countdown: 0 });
        const a = analysis('5m', bars, [thirteen(0, 'buy', 59)], { summary: s });
        expect(timeframeStructure(input(a, { state: st, signals: [], newTrend: null }))).toMatchObject({
            trend: 'down',
            stage: 'exhausted',
            countdown: 13,
            thirteenFailed: false,
            lean: 'bullish'
        });
    });

    test('an established or exhausted timeframe reports the trend of that move, not the forming run', () => {
        // A carried buy 13: the down move is exhausted while an up setup forms.
        const a = analysis('1h', bars, [], { summary: summary({ trend: 'up', setupStep: 3 }) });
        const carried = composed({ s9: 'down', s13: true, carry13: true, countdown: 13 }, newTrendOf(true, 'up', 3));
        expect(timeframeStructure(input(a, carried))).toMatchObject({
            trend: 'down',
            stage: 'exhausted',
            setupStep: 9,
            formingOpposite: { trend: 'up', step: 3 }
        });
        expect(timeframeStructure(input(a, composed({ s9: 'none' })))).toMatchObject({ trend: 'up', setupStep: 3 });
    });

    test('XAUUSDT 4h: a carried buy 13 reads as an exhausted down move', () => {
        const inputs = fixtureInputs('xauusdt');
        expect(inputs['4h'].composed.state).toMatchObject({ carry13: true, s9: 'down', s13: true });
        expect(inputs['4h'].analysis.summary?.trend).toBe('up');
        expect(timeframeStructure(inputs['4h'])).toMatchObject({
            interval: '4h',
            trend: 'down',
            stage: 'exhausted',
            setupStep: 9,
            countdown: 13,
            formingOpposite: { trend: 'up', step: 3 },
            lean: 'bullish'
        });
        expect(live13Of(inputs['4h'], currentPrice(inputs), timeframeStructure(inputs['4h']))).toMatchObject({
            side: 'buy',
            intact: true,
            oppositeSetup: 3
        });
    });

    // NVDAUSDT 15m: the sell 9 on bar 477 is held (retain_active) by an older countdown that reaches 13 on
    // bar 484, so the state still reads the held 9 (countdown 0) until the 13 is carried from bar 493.
    test('NVDAUSDT 15m: a 13 beside a held 9 reads as exhausted on the bar it qualifies, leaning bearish', () => {
        const inputs = fixtureInputs('nvdausdt', { '15m': 485 });
        expect(inputs['15m'].composed.state).toMatchObject({ s9: 'up', s13: false, countdown: 0 });
        expect(timeframeStructure(inputs['15m'])).toMatchObject({
            trend: 'up',
            stage: 'exhausted',
            countdown: 13,
            thirteenFailed: false,
            lean: 'bearish'
        });
    });

    test('NVDAUSDT 15m: the held-9 13 is failed once its risk level breaks, with no lean', () => {
        const inputs = fixtureInputs('nvdausdt', { '15m': 492 });
        expect(inputs['15m'].composed.state).toMatchObject({ s9: 'up', s13: false, countdown: 0 });
        expect(timeframeStructure(inputs['15m'])).toMatchObject({
            trend: 'up',
            stage: 'exhausted',
            countdown: 13,
            thirteenFailed: true,
            lean: null
        });
    });

    test('NVDAUSDT 15m: a carried 13 whose risk level broke is failed, with no lean', () => {
        const inputs = fixtureInputs('nvdausdt');
        expect(inputs['15m'].composed.state).toMatchObject({ s9: 'up', s13: true, carry13: true });
        expect(timeframeStructure(inputs['15m'])).toMatchObject({
            trend: 'up',
            stage: 'exhausted',
            countdown: 13,
            thirteenFailed: true,
            lean: null
        });
    });

    test('XAUUSDT 1d: a held 9 on the bar its 13 qualifies on still reads as exhausted, leaning bullish', () => {
        // The buy 13 and the buy 9 it holds both land on bar 139.
        const inputs = fixtureInputs('xauusdt', { '1d': 140 });
        expect(inputs['1d'].composed.state).toMatchObject({ s9: 'down', s13: false, countdown: 0 });
        expect(timeframeStructure(inputs['1d'])).toMatchObject({
            trend: 'down',
            stage: 'exhausted',
            countdown: 13,
            thirteenFailed: false,
            lean: 'bullish'
        });
    });

    test.each([
        ['nvdausdt', '4h', 'down', 'buy'],
        ['xauusdt', '15m', 'up', 'sell']
    ] as const)('%s %s: the %s move stays established when a new %s 9 follows its failed 13', (name, interval, trend, side) => {
        const { analysis, composed } = fixtureInputs(name)[interval];
        expect(newestThirteen(analysis, side)).toEqual({ side, riskStatus: 'invalidated', nineAfter: true });
        expect(composed.state?.s13).toBe(false);
        expect(timeframeStructure({ analysis, composed })).toMatchObject({
            trend,
            stage: 'established',
            countdown: composed.state?.countdown,
            thirteenFailed: false,
            lean: trend === 'up' ? 'bullish' : 'bearish'
        });
    });

    test.each([
        ['nvdausdt', '1h', 'up', 'buy'],
        ['xauusdt', '5m', 'down', 'sell']
    ] as const)('%s %s: the %s move stays established beside a newer %s 13', (name, interval, trend, other) => {
        const { analysis, composed } = fixtureInputs(name)[interval];
        // No 9 on its side came after it, so it would read as exhausting the move if sides were ignored.
        expect(newestThirteen(analysis)).toMatchObject({ side: other, nineAfter: false });
        expect(composed.state?.s13).toBe(false);
        expect(timeframeStructure({ analysis, composed })).toMatchObject({
            trend,
            stage: 'established',
            countdown: composed.state?.countdown,
            thirteenFailed: false
        });
    });

    test('BTCUSDC 1d: a failed buy 13 does not mark the up move failed', () => {
        const { analysis, composed } = fixtureInputs('btcusdc')['1d'];
        expect(newestThirteen(analysis)).toMatchObject({ side: 'buy', riskStatus: 'invalidated' });
        expect(newestThirteen(analysis, 'sell')).toBeUndefined();
        expect(timeframeStructure({ analysis, composed })).toMatchObject({
            trend: 'up',
            stage: 'established',
            countdown: composed.state?.countdown,
            thirteenFailed: false
        });
    });

    test.each([
        [newTrendOf(true, 'down', 4), { trend: 'down', step: 4 }],
        [newTrendOf(true, 'up', 4), null],
        [newTrendOf(false, 'down', 0), null],
        [null, null]
    ])('formingOpposite for %j is %j', (trend, expected) => {
        const a = analysis('1h', bars, [], { summary: summary({ trend: 'up' }) });
        expect(timeframeStructure(input(a, composed({}, trend)))?.formingOpposite).toEqual(expected);
    });

    test('timeline keeps the last three 9s and 13s, oldest first', () => {
        const priced = range(0, 59).map((i): Bar => {
            const close = (100 + i * 0.1).toFixed(2);
            return [close, close, close];
        });
        const forming: SequenceState = { ...nine(2, 'buy', 52, 'inactive'), setup: [50, 51, 52], setupStatus: 'forming' };
        const interrupted: SequenceState = { ...nine(4, 'sell', 58, 'inactive'), setup: [57, 58], setupStatus: 'interrupted' };
        const sequences = [
            nine(0, 'buy', 20, 'cancelled'),
            thirteen(1, 'sell', 43),
            forming,
            nine(3, 'buy', 55, 'active'),
            interrupted
        ];
        expect(timeframeStructure(input(analysis('1h', priced, sequences)))?.timeline).toEqual([
            { kind: 9, side: 'sell', barsAgo: 29, price: '103', status: 'reached13' },
            { kind: 13, side: 'sell', barsAgo: 16, price: '104.3', status: 'standing' },
            { kind: 9, side: 'buy', barsAgo: 4, price: '105.5', status: 'running' }
        ]);
    });

    test.each([
        ['qualified13', 'reached13'],
        ['active', 'running'],
        ['count13_unqualified', 'running'],
        ['cancelled', 'cancelled'],
        ['recycled', 'recycled'],
        ['inactive', 'held']
    ] as const)('a 9 whose countdown is %s is %s', (countdownStatus, status) => {
        const seq = countdownStatus === 'qualified13' ? thirteen(0, 'buy', 53) : nine(0, 'buy', 40, countdownStatus);
        const timeline = timeframeStructure(input(analysis('1h', bars, [seq])))?.timeline;
        expect(timeline?.find((e) => e.kind === 9)).toEqual({ kind: 9, side: 'buy', barsAgo: 19, price: '100.5', status });
    });

    test.each([
        ['valid', 'standing'],
        ['invalidated', 'failed']
    ] as const)('a 13 whose risk is %s is %s', (riskStatus, status) => {
        const seq = thirteen(0, 'buy', 50, 0n, riskStatus);
        const timeline = timeframeStructure(input(analysis('1h', bars, [seq])))?.timeline;
        expect(timeline?.find((e) => e.kind === 13)).toEqual({ kind: 13, side: 'buy', barsAgo: 9, price: '100.5', status });
    });
});

describe('live13Of', () => {
    /** The live 13 with the timeframe's own structure, as buildFacts passes it. */
    function liveOf(i: TimeframeInput, price: number): Live13 | null {
        return live13Of(i, price, timeframeStructure(i));
    }

    test('reports the newest qualified 13 with its risk room and move since', () => {
        const bars = flat(30, '82700.0');
        bars[25] = ['82700.0', '82600.0', '82648.0'];
        bars[29] = ['82700.0', '82600.0', '82638.10'];
        const a = analysis('5m', bars, [thirteen(0, 'sell', 25, 828315n)], { scale: 1 });
        expect(liveOf(input(a, composed({}, newTrendOf(true, 'down', 3))), 82638.1)).toEqual({
            interval: '5m',
            side: 'sell',
            barsAgo: 4,
            price: '82648',
            riskLevel: '82831.5',
            intact: true,
            roomPct: '0.23',
            sincePct: '-0.01',
            oppositeSetup: 3
        });
    });

    test('lists a 13 up to 12 bars ago while its structure is not exhausted by it', () => {
        const at12 = liveOf(input(analysis('5m', flat(40, '100'), [thirteen(0, 'buy', 27)])), 100);
        expect(at12?.barsAgo).toBe(12);
        expect(liveOf(input(analysis('5m', flat(40, '100'), [thirteen(0, 'buy', 26)])), 100)).toBeNull();
        expect(live13Of(input(analysis('5m', flat(40, '100'), [thirteen(0, 'buy', 26)])), 100, null)).toBeNull();
    });

    test('live13 keeps an intact 13 beyond 12 bars while its structure is exhausted', () => {
        // A sell 13 on bar 21 of 52 bars, 30 bars ago, exhausting the up move.
        const seq = thirteen(0, 'sell', 21);
        const up = composed({ s9: 'up' });
        const exhausted = input(analysis('5m', flat(52, '100'), [seq]), up);
        expect(timeframeStructure(exhausted)).toMatchObject({ stage: 'exhausted', thirteenFailed: false });
        expect(liveOf(exhausted, 100)).toMatchObject({ side: 'sell', barsAgo: 30, intact: true });

        // A new sell 9 after it: the up move counts again and its 13 drops out.
        const renewed = input(analysis('5m', flat(52, '100'), [seq, nine(1, 'sell', 40, 'active')]), up);
        expect(timeframeStructure(renewed)?.stage).toBe('established');
        expect(liveOf(renewed, 100)).toBeNull();

        // Its risk level broken: a failed 13 is listed only within 12 bars.
        const broken = thirteen(0, 'sell', 21, 0n, 'invalidated');
        const failed = input(analysis('5m', flat(52, '100'), [broken], { events: [invalidated(broken, 30)] }), up);
        expect(timeframeStructure(failed)).toMatchObject({ stage: 'exhausted', thirteenFailed: true });
        expect(liveOf(failed, 100)).toBeNull();
    });

    test('takes the newest 13 by bar, not by sequence order', () => {
        const live = liveOf(input(analysis('5m', flat(40, '100'), [thirteen(0, 'sell', 30), thirteen(1, 'buy', 22)])), 100);
        expect(live).toMatchObject({ side: 'sell', barsAgo: 9 });
    });

    test('is not intact once the risk level is invalidated', () => {
        const seq = thirteen(0, 'buy', 30, 90n, 'invalidated');
        const live = liveOf(input(analysis('5m', flat(40, '100'), [seq], { events: [invalidated(seq, 33)] })), 100);
        expect(live?.intact).toBe(false);
    });

    test('returns null without a qualified 13', () => {
        expect(liveOf(input(analysis('5m', flat(40, '100'), [nine(0, 'buy', 30, 'active')])), 100)).toBeNull();
    });

    test('measures room and move from the current price, not the timeframe close', () => {
        const bars = flat(30, '82700.0');
        bars[25] = ['82700.0', '82600.0', '82648.0'];
        bars[29] = ['82700.0', '82600.0', '82638.10'];
        const a = analysis('4h', bars, [thirteen(0, 'sell', 25, 828315n)], { scale: 1 });
        expect(liveOf(input(a), 82800)).toMatchObject({
            interval: '4h',
            price: '82648',
            riskLevel: '82831.5',
            roomPct: '0.04',
            sincePct: '0.18'
        });
    });

    test.each([
        ['buy', newTrendOf(true, 'up', 5), 5],
        ['buy', newTrendOf(true, 'down', 5), 0],
        ['buy', newTrendOf(false, 'up', 0), 0],
        ['sell', newTrendOf(true, 'down', 7), 7],
        ['buy', null, 0]
    ] as const)('a %s 13 with new trend %j has oppositeSetup %d', (side, trend, expected) => {
        const live = liveOf(input(analysis('5m', flat(40, '100'), [thirteen(0, side, 30)]), composed({}, trend)), 100);
        expect(live?.oppositeSetup).toBe(expected);
    });
});

describe('reviewOf', () => {
    function lastClose(a: WindowAnalysis): number {
        return Number(a.rows.at(-1)?.close);
    }

    /**
     * A 13 on bar 21 whose close is 100, followed by `after`; the risk level breaks `breakAfter` bars later.
     * The current price is the window's last close unless given.
     */
    function reviewed(side: DemarkSide, after: readonly Bar[], breakAfter?: number, now?: number): ReviewItem[] {
        const seq = thirteen(0, side, 21, 0n, breakAfter === undefined ? 'valid' : 'invalidated');
        const events = breakAfter === undefined ? [] : [invalidated(seq, 21 + breakAfter)];
        const a = analysis('1h', [...flat(22, '100.0'), ...after], [seq], { events });
        return reviewOf(input(a), now ?? lastClose(a)).filter((item) => item.kind === 13);
    }

    test('measures the move inside a window shorter than 12 bars, and judges it already (R34: no longer pending)', () => {
        const after: Bar[] = [
            [103, 99, 102],
            [105, 98, 104],
            [101, 97, 100]
        ];
        expect(reviewed('buy', after)).toEqual([
            {
                interval: '1h',
                kind: 13,
                side: 'buy',
                barsAgo: 3,
                price: '100',
                windowBars: 3,
                favorablePct: '5.00',
                adversePct: '3.00',
                afterPct: '0.00',
                sincePct: '0.00',
                verdict: 'unclear',
                settledBarsAgo: null
            }
        ]);
    });

    test('has no numbers on the 13 bar itself', () => {
        expect(reviewed('buy', [])).toEqual([
            {
                interval: '1h',
                kind: 13,
                side: 'buy',
                barsAgo: 0,
                price: '100',
                windowBars: 0,
                favorablePct: null,
                adversePct: null,
                afterPct: null,
                sincePct: '0.00',
                verdict: 'pending',
                settledBarsAgo: null
            }
        ]);
    });

    test('keeps the window numbers to 12 bars, but judges a buy 13 on its move since (R34: a later fall unconfirms it)', () => {
        const after: Bar[] = [...Array.from({ length: 12 }, (): Bar => [102, 99, 101]), ...flat(3, 80)];
        expect(reviewed('buy', after)).toEqual([
            {
                interval: '1h',
                kind: 13,
                side: 'buy',
                barsAgo: 15,
                price: '100',
                windowBars: 12,
                favorablePct: '2.00',
                adversePct: '1.00',
                afterPct: '1.00',
                sincePct: '-20.00',
                verdict: 'unconfirmed',
                settledBarsAgo: 3
            }
        ]);
        expect(reviewed('buy', after, undefined, 101)[0]).toMatchObject({ sincePct: '1.00', verdict: 'confirmed' });
    });

    test('calls a buy 13 that has not moved since unclear (R34: was unconfirmed)', () => {
        const after = Array.from({ length: 12 }, (): Bar => [102, 99, 100]);
        expect(reviewed('buy', after)[0]).toMatchObject({ afterPct: '0.00', sincePct: '0.00', verdict: 'unclear' });
    });

    test.each([
        ['buy', 100.2449, '0.24', 'unclear'],
        ['buy', 100.2451, '0.25', 'confirmed'],
        ['sell', 99.7551, '-0.24', 'unclear'],
        ['sell', 99.7549, '-0.25', 'confirmed']
    ] as const)('a %s 13 with the price now at %d is judged on the rounded sincePct %s: %s (R34: was afterPct)', (side, now, sincePct, verdict) => {
        const after = Array.from({ length: 12 }, (): Bar => [101, 99, 100]);
        expect(reviewed(side, after, undefined, now)[0]).toMatchObject({ afterPct: '0.00', sincePct, verdict });
    });

    test('review judges a signal on its move since, from the first bar after it', () => {
        // A 13 or a 9 on bar 30 at 100, three bars ago unless `barsAgo` says otherwise.
        function judged(kind: 9 | 13, side: DemarkSide, now: number, barsAgo = 3): ReviewItem | undefined {
            const seq = kind === 13 ? thirteen(0, side, 30) : nine(0, side, 30, 'active');
            const items = reviewOf(input(analysis('1h', flat(31 + barsAgo, '100'), [seq])), now);
            return items.find((item) => item.kind === kind && item.barsAgo === barsAgo);
        }

        // Inside the 12-bar window: under 0.25% either way is unclear.
        expect(judged(13, 'buy', 100.24)).toMatchObject({ windowBars: 3, sincePct: '0.24', verdict: 'unclear', settledBarsAgo: null });
        expect(judged(13, 'sell', 99.9)).toMatchObject({ sincePct: '-0.10', verdict: 'unclear' });
        expect(judged(9, 'sell', 100.24)).toMatchObject({ sincePct: '0.24', verdict: 'unclear' });
        expect(judged(9, 'buy', 99.9)).toMatchObject({ sincePct: '-0.10', verdict: 'unclear' });

        // 0.25% is a move: a 13 expects the reversal, a 9 its own move going on.
        expect(judged(13, 'buy', 100.25)).toMatchObject({ sincePct: '0.25', verdict: 'confirmed', settledBarsAgo: null });
        expect(judged(13, 'sell', 100.25)).toMatchObject({ sincePct: '0.25', verdict: 'unconfirmed' });
        expect(judged(9, 'sell', 100.25)).toMatchObject({ sincePct: '0.25', verdict: 'confirmed' });
        expect(judged(9, 'buy', 100.25)).toMatchObject({ sincePct: '0.25', verdict: 'unconfirmed' });
        expect(judged(13, 'sell', 99.75)).toMatchObject({ sincePct: '-0.25', verdict: 'confirmed' });

        // On the newest bar there is nothing after it yet, whatever the current price.
        expect(judged(13, 'buy', 101, 0)).toMatchObject({ windowBars: 0, sincePct: '1.00', verdict: 'pending', settledBarsAgo: null });
        expect(judged(9, 'sell', 101, 0)).toMatchObject({ windowBars: 0, verdict: 'pending' });

        // A risk level broken within 12 bars still fails the 13, whatever it moved since.
        const seq = thirteen(0, 'buy', 30, 0n, 'invalidated');
        const a = analysis('1h', flat(34, '100'), [seq], { events: [invalidated(seq, 32)] });
        expect(reviewOf(input(a), 101).find((item) => item.kind === 13)).toMatchObject({
            sincePct: '1.00',
            verdict: 'failed',
            settledBarsAgo: 1
        });
    });

    test('review sincePct is the move from the signal close to the newest 5m close, as live13 measures it', () => {
        const inputs = fixtureInputs('xauusdt');
        const now = currentPrice(inputs);
        const facts = buildFacts(inputs);
        expect(facts.review.length).toBeGreaterThan(0);
        for (const item of facts.review) {
            expect(item.sincePct).toBe(formatPct((now / Number(item.price) - 1) * 100));
        }
        const live = facts.live13.find((l) => l.interval === '4h');
        const same = facts.review.find((i) => i.interval === '4h' && i.kind === 13 && i.barsAgo === live?.barsAgo);
        expect(same?.sincePct).toBe(live?.sincePct);
    });

    test('fails a 13 whose risk level breaks within 12 bars, even before the window ends', () => {
        const after = Array.from({ length: 7 }, (): Bar => [99, 90, 92]);
        expect(reviewed('buy', after, 5)).toEqual([
            {
                interval: '1h',
                kind: 13,
                side: 'buy',
                barsAgo: 7,
                price: '100',
                windowBars: 7,
                favorablePct: '0.00',
                adversePct: '10.00',
                afterPct: '-8.00',
                sincePct: '-8.00',
                verdict: 'failed',
                settledBarsAgo: 2
            }
        ]);
    });

    test('a breach on the 12th bar fails the 13; one after the window does not', () => {
        const after = Array.from({ length: 20 }, (): Bar => [102, 99, 101]);
        expect(reviewed('buy', after, 12)[0]).toMatchObject({ verdict: 'failed', settledBarsAgo: 8 });
        expect(reviewed('buy', after, 13)[0]).toMatchObject({ verdict: 'confirmed', settledBarsAgo: 8 });
    });

    test('mirrors a sell 13', () => {
        const after = Array.from({ length: 12 }, (): Bar => [101, 96, 98]);
        expect(reviewed('sell', after)).toEqual([
            {
                interval: '1h',
                kind: 13,
                side: 'sell',
                barsAgo: 12,
                price: '100',
                windowBars: 12,
                favorablePct: '4.00',
                adversePct: '1.00',
                afterPct: '-2.00',
                sincePct: '-2.00',
                verdict: 'confirmed',
                settledBarsAgo: 0
            }
        ]);
    });

    test('keeps the last two 13s, oldest first', () => {
        const sequences = [thirteen(0, 'buy', 40), thirteen(1, 'sell', 21), thirteen(2, 'buy', 30)];
        const items = reviewOf(input(analysis('1h', flat(45, '100'), sequences)), 100).filter((i) => i.kind === 13);
        expect(items.map((i) => [i.side, i.barsAgo])).toEqual([
            ['buy', 14],
            ['buy', 4]
        ]);
    });

    test('reviews the last two 9s after the 13s, measured from the bar each 9 completed on', () => {
        // 9s complete on bars 10 (buy), 20 (sell) and 30 (buy); the price steps up 1 per bar after bar 30.
        // A 9 is expected to keep its move going: the sell 9 (up) is confirmed by the rise, the buy 9 (down) is not.
        const sequences = [nine(0, 'buy', 10, 'cancelled'), nine(1, 'sell', 20, 'cancelled'), nine(2, 'buy', 30, 'active')];
        const bars: Bar[] = [...flat(31, '100'), ...Array.from({ length: 14 }, (_, i): Bar => [101 + i, 100 + i, 101 + i])];
        const items = reviewOf(input(analysis('1h', bars, sequences)), 114);
        expect(items).toEqual([
            {
                interval: '1h',
                kind: 9,
                side: 'sell',
                barsAgo: 24,
                price: '100',
                windowBars: 12,
                favorablePct: '2.00',
                adversePct: '0.00',
                afterPct: '2.00',
                sincePct: '14.00',
                verdict: 'confirmed',
                settledBarsAgo: 12
            },
            {
                interval: '1h',
                kind: 9,
                side: 'buy',
                barsAgo: 14,
                price: '100',
                windowBars: 12,
                favorablePct: '0.00',
                adversePct: '12.00',
                afterPct: '12.00',
                sincePct: '14.00',
                verdict: 'unconfirmed',
                settledBarsAgo: 2
            }
        ]);
    });

    test('a buy 9 is confirmed when the price keeps falling, its window measured from the lowest low', () => {
        // The 9 completes on bar 10 at 100; the next 12 bars close one lower each, with lows one below the close.
        const falling = Array.from({ length: 12 }, (_, i): Bar => [99 - i, 98 - i, 99 - i]);
        const [item] = reviewOf(input(analysis('1h', [...flat(11, '100'), ...falling], [nine(0, 'buy', 10, 'cancelled')])), 88);
        expect(item).toMatchObject({
            kind: 9,
            side: 'buy',
            windowBars: 12,
            favorablePct: '13.00',
            adversePct: '0.00',
            afterPct: '-12.00',
            sincePct: '-12.00',
            verdict: 'confirmed'
        });
    });

    test('never fails a 9: only a 13 has a risk level (R34: the 9 is judged on its move since)', () => {
        const seq = thirteen(0, 'buy', 21, 0n, 'invalidated');
        const events = [invalidated(seq, 23)];
        const items = reviewOf(input(analysis('1h', [...flat(22, '100'), ...flat(14, '90')], [seq], { events })), 90);
        expect(items.map((i) => [i.kind, i.verdict])).toEqual([
            [13, 'failed'],
            [9, 'confirmed']
        ]);
    });
});

describe('pickReview', () => {
    function item(
        interval: InsightInterval,
        barsAgo: number,
        verdict: ReviewVerdict,
        settledBarsAgo: number | null = barsAgo >= 12 ? barsAgo - 12 : null,
        kind: 9 | 13 = 13,
        side: DemarkSide = 'buy'
    ): ReviewItem {
        return {
            interval,
            kind,
            side,
            barsAgo,
            price: '100',
            windowBars: Math.min(12, barsAgo),
            favorablePct: null,
            adversePct: null,
            afterPct: null,
            sincePct: '0.00',
            verdict,
            settledBarsAgo
        };
    }

    test('without a main line, picks the largest timeframe among recently settled outcomes', () => {
        const items = [
            item('5m', 14, 'confirmed'),
            item('1h', 17, 'unconfirmed'),
            item('15m', 13, 'failed', 1),
            item('4h', 2, 'unclear')
        ];
        expect(pickReview(items, null)).toBe(items[1]);
    });

    test('without a main line, prefers a 13 to a 9 on the same timeframe, then the newer outcome', () => {
        const nine = item('1h', 13, 'confirmed', 1, 9);
        const older = item('1h', 20, 'confirmed', 8);
        const newer = item('1h', 15, 'unconfirmed', 3);
        expect(pickReview([nine, older], null)).toBe(older);
        expect(pickReview([older, newer], null)).toBe(newer);
        expect(pickReview([nine, item('1h', 14, 'confirmed', 2, 9)], null)).toBe(nine);
    });

    test.each([
        ['5m', 12, true],
        ['5m', 13, false],
        ['1h', 12, true],
        ['1h', 13, false],
        ['4h', 6, true],
        ['4h', 7, false],
        ['1d', 1, true],
        ['1d', 2, false]
    ] as const)('without a main line, a %s outcome settled %d bars ago is fresh: %s', (interval, settled, fresh) => {
        const inWindow = item('5m', 3, 'unclear');
        const settledItem = item(interval, settled + 12, 'confirmed', settled);
        expect(pickReview([inWindow, settledItem], null)).toBe(fresh ? settledItem : inWindow);
    });

    test('without a main line, falls back to the newest signal still in its window, then to the newest settled one (R34: any verdict but failed, not only pending)', () => {
        const inWindow = [item('5m', 6, 'unclear'), item('15m', 1, 'confirmed'), item('1h', 3, 'unconfirmed')];
        expect(pickReview(inWindow, null)).toBe(inWindow[1]);
        // A signal on the newest bar has nothing to review yet.
        expect(pickReview([...inWindow, item('1d', 0, 'pending', null, 9)], null)).toBe(inWindow[1]);
        expect(pickReview([item('1d', 0, 'pending', null, 9)], null)).toBeNull();
        const stale = [item('5m', 40, 'confirmed'), item('15m', 40, 'unconfirmed')];
        expect(pickReview(stale, null)).toBe(stale[0]);
    });

    test('without a main line, a failed 13 settles on its breach bar', () => {
        // Breach at t+3 on a 13 five bars ago: settled 2 bars ago.
        const failed = item('5m', 5, 'failed', 2);
        const settledLater = item('5m', 13, 'confirmed');
        const settledEarlier = item('5m', 16, 'confirmed');
        expect(pickReview([failed, settledLater], null)).toBe(settledLater);
        expect(pickReview([settledEarlier, failed], null)).toBe(failed);
    });

    test('is null without items', () => {
        expect(pickReview([], null)).toBeNull();
        expect(pickReview([], structureOf('1h', 'up', 'exhausted', 13))).toBeNull();
    });

    test('pickReview takes the main line signal first', () => {
        // An exhausted 15m up move: the newest sell 13 on 15m, however a bigger timeframe settled since.
        const exhausted = [
            item('15m', 40, 'confirmed', 28, 13, 'sell'),
            item('15m', 20, 'unconfirmed', 8, 13, 'sell'),
            item('15m', 5, 'unclear', null, 13, 'buy'),
            item('15m', 4, 'unclear', null, 9, 'sell'),
            item('1h', 13, 'confirmed', 1)
        ];
        expect(pickReview(exhausted, null)).toBe(exhausted[4]);
        expect(pickReview(exhausted, structureOf('15m', 'up', 'exhausted', 13))).toBe(exhausted[1]);

        // A 1d up move at Countdown 12: the newest up (sell) 9 on 1d.
        const counting = [
            item('1d', 30, 'confirmed', 18, 9, 'sell'),
            item('1d', 14, 'unconfirmed', 2, 9, 'sell'),
            item('1d', 6, 'unclear', null, 9, 'buy'),
            item('1d', 3, 'unclear', null, 13, 'sell'),
            item('4h', 13, 'confirmed', 1)
        ];
        expect(pickReview(counting, null)).toBe(counting[4]);
        expect(pickReview(counting, structureOf('1d', 'up', 'established', 12))).toBe(counting[1]);

        // The main line's signal on the newest bar, or none in the review: the old rule.
        const onNewest = [item('15m', 0, 'pending', null, 13, 'sell'), item('1h', 13, 'confirmed', 1)];
        expect(pickReview(onNewest, structureOf('15m', 'up', 'exhausted', 13))).toBe(onNewest[1]);
        expect(pickReview(onNewest, structureOf('4h', 'down', 'established', 11))).toBe(onNewest[1]);

        // The main 13 sits on the newest bar but an older same-side 13 on that timeframe has bars after it: that one.
        const olderSame = [
            item('15m', 0, 'pending', null, 13, 'sell'),
            item('15m', 20, 'unconfirmed', 8, 13, 'sell'),
            item('1h', 13, 'confirmed', 1)
        ];
        expect(pickReview(olderSame, null)).toBe(olderSame[2]);
        expect(pickReview(olderSame, structureOf('15m', 'up', 'exhausted', 13))).toBe(olderSame[1]);
    });
});

describe('focusOf', () => {
    interface Frame {
        s9: 'up' | 'down' | 'none';
        countdown?: number;
        s13?: boolean;
        /** A held 9 whose older countdown reached 13: the structure reads exhausted while the state shows that 9 at countdown 0. */
        held?: boolean;
    }

    function live(interval: InsightInterval, side: DemarkSide, intact = true): Live13 {
        return {
            interval,
            side,
            barsAgo: 1,
            price: '100',
            riskLevel: '99',
            intact,
            roomPct: '1.00',
            sincePct: '0.00',
            oppositeSetup: 0
        };
    }

    function focus(frames: Partial<Record<InsightInterval, Frame>>, live13: Live13[]): FocusItem[] {
        const structures: TimeframeStructure[] = [];
        for (const interval of INSIGHT_INTERVALS) {
            const frame = frames[interval] ?? { s9: 'none' };
            const countdown = frame.countdown ?? 0;
            const s13 = frame.s13 ?? false;
            const trend = frame.s9 === 'down' ? 'down' : 'up';
            const stage = s13 || frame.held ? 'exhausted' : frame.s9 === 'none' ? 'forming' : 'established';
            structures.push({
                interval,
                close: '100',
                trend,
                stage,
                setupStep: 9,
                countdown: frame.held ? 13 : countdown,
                formingOpposite: null,
                timeline: [],
                thirteenFailed: false,
                lean: readingLean(trend, stage)
            });
        }
        return focusOf(structures, live13);
    }

    test('relay-exhaustion: a small 13 under a big trend at countdown 11 (R34: at countdown 10 it is a bounce-in-trend)', () => {
        expect(focus({ '1d': { s9: 'up', countdown: 11 } }, [live('5m', 'sell')])).toEqual([
            { pattern: 'relay-exhaustion', small: '5m', big: '1d', side: 'sell', bigCountdown: 11 }
        ]);
        expect(focus({ '1d': { s9: 'up', countdown: 10 } }, [live('5m', 'sell')])).toEqual([
            { pattern: 'bounce-in-trend', small: '5m', bigs: ['1d'], bigTrend: 'up' }
        ]);
    });

    test('relay-exhaustion pairs the largest qualifying small timeframe', () => {
        expect(focus({ '1h': { s9: 'down', countdown: 12 } }, [live('5m', 'buy'), live('15m', 'buy')])).toEqual([
            { pattern: 'relay-exhaustion', small: '15m', big: '1h', side: 'buy', bigCountdown: 12 },
            { pattern: 'resonance', side: 'buy', intervals: ['5m', '15m'] }
        ]);
    });

    test('relay-exhaustion needs an intact 13; the big timeframe then shows as near-exhaustion', () => {
        expect(focus({ '1d': { s9: 'up', countdown: 11 } }, [live('5m', 'sell', false)])).toEqual([
            { pattern: 'thirteen-failed', interval: '5m', side: 'sell' },
            { pattern: 'near-exhaustion', interval: '1d', trend: 'up', countdown: 11 }
        ]);
    });

    test('counter-move-ending: a small 13 against an established big trend', () => {
        expect(focus({ '4h': { s9: 'down', countdown: 4 } }, [live('5m', 'sell')])).toEqual([
            { pattern: 'counter-move-ending', small: '5m', big: '4h', bigTrend: 'down', bigCountdown: 4 }
        ]);
        expect(focus({ '4h': { s9: 'down', countdown: 6 } }, [live('5m', 'sell')])).toHaveLength(1);
        expect(focus({ '4h': { s9: 'down', countdown: 7 } }, [live('5m', 'sell')])).toEqual([]);
        expect(focus({ '4h': { s9: 'none' } }, [live('5m', 'sell')])).toEqual([]);
    });

    test('counter-move-ending needs the small 13 to exhaust a move against the big trend (R34: one with it is a bounce-in-trend)', () => {
        // A buy 13 exhausts a down move, the same direction as the 4h down trend.
        expect(focus({ '4h': { s9: 'down', countdown: 4 } }, [live('5m', 'buy')])).toEqual([
            { pattern: 'bounce-in-trend', small: '5m', bigs: ['4h'], bigTrend: 'down' }
        ]);
    });

    test('counter-move-ending skips a held 9: the structure reads it as its 13, not as an early Countdown', () => {
        expect(focus({ '4h': { s9: 'down', held: true } }, [live('5m', 'sell')])).toEqual([]);
    });

    test('bounce-in-trend: a small 13 inside bigger moves still counting the same way, up to Countdown 10', () => {
        const down = { s9: 'down', countdown: 10 } as const;
        expect(focus({ '4h': down, '1h': { s9: 'down', countdown: 8 } }, [live('5m', 'buy')])).toEqual([
            { pattern: 'bounce-in-trend', small: '5m', bigs: ['4h', '1h'], bigTrend: 'down' }
        ]);
        // Countdown 11 is a relay, not a bounce; a forming or exhausted big timeframe is neither.
        expect(focus({ '4h': { s9: 'down', countdown: 11 } }, [live('5m', 'buy')])).toEqual([
            { pattern: 'relay-exhaustion', small: '5m', big: '4h', side: 'buy', bigCountdown: 11 }
        ]);
        expect(focus({ '4h': { s9: 'down', held: true } }, [live('5m', 'buy')])).toEqual([]);
        // It needs an intact 13 exhausting the same move.
        expect(focus({ '4h': down }, [live('5m', 'sell')])).toEqual([]);
        expect(focus({ '4h': down }, [live('5m', 'buy', false)])).toEqual([
            { pattern: 'thirteen-failed', interval: '5m', side: 'buy' }
        ]);
    });

    test('bounce-in-trend takes the biggest 13 under the biggest move, paired with every bigger move', () => {
        // 1h is the biggest buy 13 under 4h; 15m counts down too but is not bigger than 1h.
        const frames: Partial<Record<InsightInterval, Frame>> = {
            '4h': { s9: 'down', countdown: 10 },
            '15m': { s9: 'down', countdown: 9 }
        };
        expect(focus(frames, [live('5m', 'buy'), live('1h', 'buy')])).toEqual([
            { pattern: 'bounce-in-trend', small: '1h', bigs: ['4h'], bigTrend: 'down' },
            { pattern: 'resonance', side: 'buy', intervals: ['5m', '1h'] }
        ]);
    });

    test('bounce-in-trend sits with counter-move-ending, ordered by its biggest timeframe, one per direction', () => {
        const frames: Partial<Record<InsightInterval, Frame>> = {
            '1d': { s9: 'up', countdown: 7 },
            '4h': { s9: 'down', countdown: 8 },
            '1h': { s9: 'up', countdown: 3 }
        };
        expect(focus(frames, [live('5m', 'sell'), live('15m', 'buy')])).toEqual([
            { pattern: 'bounce-in-trend', small: '5m', bigs: ['1d', '1h'], bigTrend: 'up' },
            { pattern: 'bounce-in-trend', small: '15m', bigs: ['4h'], bigTrend: 'down' },
            { pattern: 'counter-move-ending', small: '15m', big: '1h', bigTrend: 'up', bigCountdown: 3 }
        ]);
    });

    test('resonance: two intact 13s on the same side', () => {
        expect(focus({}, [live('5m', 'sell'), live('1h', 'sell')])).toEqual([
            { pattern: 'resonance', side: 'sell', intervals: ['5m', '1h'] }
        ]);
        expect(focus({}, [live('5m', 'sell'), live('1h', 'sell', false)])).toEqual([
            { pattern: 'thirteen-failed', interval: '1h', side: 'sell' }
        ]);
    });

    test('near-exhaustion: countdown 12', () => {
        expect(focus({ '15m': { s9: 'up', countdown: 12 } }, [])).toEqual([
            { pattern: 'near-exhaustion', interval: '15m', trend: 'up', countdown: 12 }
        ]);
    });

    test('orders by priority and caps the list at four', () => {
        const frames: Partial<Record<InsightInterval, Frame>> = {
            '1d': { s9: 'up', countdown: 12 },
            '4h': { s9: 'down', countdown: 3 },
            '15m': { s9: 'down', countdown: 11 }
        };
        expect(focus(frames, [live('5m', 'sell'), live('15m', 'sell'), live('1h', 'buy', false)])).toEqual([
            { pattern: 'relay-exhaustion', small: '15m', big: '1d', side: 'sell', bigCountdown: 12 },
            { pattern: 'counter-move-ending', small: '15m', big: '4h', bigTrend: 'down', bigCountdown: 3 },
            { pattern: 'resonance', side: 'sell', intervals: ['5m', '15m'] },
            { pattern: 'thirteen-failed', interval: '1h', side: 'buy' }
        ]);
    });

    test('puts the larger timeframe first within a priority', () => {
        expect(focus({ '1h': { s9: 'down', countdown: 2 }, '4h': { s9: 'down', countdown: 5 } }, [live('5m', 'sell')])).toEqual([
            { pattern: 'counter-move-ending', small: '5m', big: '4h', bigTrend: 'down', bigCountdown: 5 },
            { pattern: 'counter-move-ending', small: '5m', big: '1h', bigTrend: 'down', bigCountdown: 2 }
        ]);
        expect(focus({}, [live('5m', 'sell'), live('15m', 'sell'), live('1h', 'buy'), live('4h', 'buy')])).toEqual([
            { pattern: 'resonance', side: 'buy', intervals: ['1h', '4h'] },
            { pattern: 'resonance', side: 'sell', intervals: ['5m', '15m'] }
        ]);
        const frames: Partial<Record<InsightInterval, Frame>> = {
            '15m': { s9: 'up', countdown: 11 },
            '1h': { s9: 'down', countdown: 12 }
        };
        expect(focus(frames, [live('5m', 'buy', false), live('4h', 'sell', false)])).toEqual([
            { pattern: 'thirteen-failed', interval: '4h', side: 'sell' },
            { pattern: 'thirteen-failed', interval: '5m', side: 'buy' },
            { pattern: 'near-exhaustion', interval: '1h', trend: 'down', countdown: 12 },
            { pattern: 'near-exhaustion', interval: '15m', trend: 'up', countdown: 11 }
        ]);
    });
});

describe('mainLine', () => {
    test('mainLine prefers an intact 13 that relays into a bigger timeframe', () => {
        const facts = factsOf({
            '15m': { thirteen: 'sell', barsAgo: 3 },
            '1h': { thirteen: 'buy', barsAgo: 3 },
            '4h': { trend: 'up', countdown: 12 }
        });
        expect(facts.focus).toContainEqual({ pattern: 'relay-exhaustion', small: '15m', big: '4h', side: 'sell', bigCountdown: 12 });
        expect(facts.mainLine).toEqual({ interval: '15m', direction: 'bearish', leadInterval: '15m' });
        // R35: a short 13 leads even without the relay.
        expect(mainLineStructure(facts.structures, [])?.interval).toBe('15m');
    });

    test('R35: a short 13 leads over a long 13, whichever way each points', () => {
        expect(factsOf({ '15m': { thirteen: 'sell', barsAgo: 3 }, '4h': { thirteen: 'buy', barsAgo: 3 } }).mainLine).toEqual({
            interval: '15m',
            direction: 'bearish',
            leadInterval: '15m'
        });
        expect(factsOf({ '5m': { thirteen: 'buy', barsAgo: 3 }, '1h': { thirteen: 'sell', barsAgo: 3 } }).mainLine).toEqual({
            interval: '5m',
            direction: 'bullish',
            leadInterval: '5m'
        });
        // Both short timeframes at 13: 15m, the bigger one.
        const both = factsOf({
            '5m': { thirteen: 'sell', barsAgo: 3 },
            '15m': { thirteen: 'buy', barsAgo: 3 },
            '4h': { thirteen: 'buy', barsAgo: 3 }
        });
        expect(both.mainLine).toEqual({ interval: '15m', direction: 'bullish', leadInterval: '15m' });
        // A long 13 alone still leads.
        expect(factsOf({ '4h': { thirteen: 'buy', barsAgo: 3 } }).mainLine).toEqual({
            interval: '4h',
            direction: 'bullish',
            leadInterval: '4h'
        });
        expect(factsOf({ '15m': { trend: 'up', countdown: 12 }, '4h': { thirteen: 'buy', barsAgo: 3 } }).mainLine?.interval).toBe('4h');
    });

    test('R35: among the short 13s a relaying one still comes first', () => {
        const structures = [structureOf('5m', 'up', 'exhausted', 13), structureOf('15m', 'down', 'exhausted', 13), structureOf('4h', 'up', 'exhausted', 13)];
        const relay5m: FocusItem = { pattern: 'relay-exhaustion', small: '5m', big: '1d', side: 'sell', bigCountdown: 12 };
        expect(mainLineStructure(structures, [relay5m])?.interval).toBe('5m');
        expect(mainLineStructure(structures, [])?.interval).toBe('15m');
    });

    test('mainLineStructure takes the biggest relaying 13 among several, and skips a failed 13', () => {
        const structures = [
            structureOf('5m', 'up', 'exhausted', 13),
            structureOf('15m', 'down', 'exhausted', 13),
            structureOf('1h', 'up', 'exhausted', 13),
            { ...structureOf('4h', 'down', 'exhausted', 13), thirteenFailed: true, lean: null }
        ];
        const focus: FocusItem[] = [
            { pattern: 'relay-exhaustion', small: '5m', big: '1d', side: 'sell', bigCountdown: 12 },
            { pattern: 'relay-exhaustion', small: '15m', big: '4h', side: 'buy', bigCountdown: 11 }
        ];
        expect(mainLineStructure(structures, focus)?.interval).toBe('15m');
        expect(mainLineStructure(structures, [])?.interval).toBe('15m');
        const long = structures.filter((s) => s.interval !== '5m' && s.interval !== '15m');
        expect(mainLineStructure(long, [])?.interval).toBe('1h');
    });

    test('mainLine is the biggest intact 13 with no bar limit, else the biggest Countdown 11/12', () => {
        const fourHour = { trend: 'up', countdown: 12 } as const;
        const old13 = factsOf({ '5m': { thirteen: 'buy', barsAgo: 40 }, '4h': fourHour });
        expect(old13.live13).toEqual([expect.objectContaining({ interval: '5m', barsAgo: 40, intact: true })]);
        const fiveMinute = old13.structures.find((s) => s.interval === '5m');
        expect(fiveMinute).toMatchObject({ stage: 'exhausted', lean: 'bullish' });
        expect(old13.mainLine).toEqual({ interval: '5m', direction: fiveMinute?.lean, leadInterval: '5m' });

        expect(factsOf({ '4h': fourHour }).mainLine).toEqual({ interval: '4h', direction: 'bullish', leadInterval: '4h' });
        expect(factsOf({ '1h': { trend: 'down', countdown: 11 }, '4h': fourHour }).mainLine).toEqual({
            interval: '4h',
            direction: 'bullish',
            leadInterval: '4h'
        });
        expect(factsOf({ '1h': { trend: 'down', countdown: 11 } }).mainLine).toEqual({ interval: '1h', direction: 'bearish', leadInterval: '1h' });
        expect(factsOf({ '4h': { trend: 'up', countdown: 10 } }).mainLine).toBeNull();
        expect(factsOf({}).mainLine).toBeNull();
    });

    test('R36: reads 5m to 4h only, the timeframes the panel lists, never 1d', () => {
        expect(factsOf({ '1d': { trend: 'up', countdown: 12 } }).mainLine).toBeNull();
        const daily13 = factsOf({ '1d': { thirteen: 'sell', barsAgo: 3 } });
        expect(daily13.structures.map((s) => s.interval)).toEqual(['5m', '15m', '1h', '4h']);
        expect(daily13.live13).toEqual([]);
        expect(daily13.review.map((r) => r.interval)).not.toContain('1d');
        expect(daily13.mainLine).toBeNull();
        // A 15m 13 is no bounce inside a 1d move: it leads itself.
        const bounce = factsOf({ '15m': { thirteen: 'sell', barsAgo: 3 }, '1d': { trend: 'up', countdown: 4 } });
        expect(bounce.focus).toEqual([]);
        expect(bounce.mainLine).toEqual({ interval: '15m', direction: 'bearish', leadInterval: '15m' });
    });

    test('bounce-in-trend pairs a small 13 with every bigger timeframe still counting the same move', () => {
        const facts = factsOf({
            '5m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { trend: 'down', countdown: 8 },
            '4h': { trend: 'down', countdown: 10 }
        });
        expect(facts.focus).toEqual([{ pattern: 'bounce-in-trend', small: '5m', bigs: ['4h', '1h'], bigTrend: 'down' }]);
        // R35: the 5m 13 is only a bounce inside the down moves, but a short main line keeps its own way.
        expect(facts.structures.find((s) => s.interval === '5m')?.lean).toBe('bullish');
        expect(facts.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
    });

    test('a 1h 13 that is only a bounce inside a bigger move still points the bigger way', () => {
        const facts = factsOf({ '1h': { thirteen: 'buy', barsAgo: 3 }, '4h': { trend: 'down', countdown: 10 } });
        expect(facts.focus).toEqual([{ pattern: 'bounce-in-trend', small: '1h', bigs: ['4h'], bigTrend: 'down' }]);
        expect(facts.mainLine).toEqual({ interval: '1h', direction: 'bearish', leadInterval: '4h' });
    });

    test('R35: a short main line names its resonance with a long 13 over a bounce', () => {
        const facts = factsOf({
            '15m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { trend: 'down', countdown: 7 },
            '4h': { thirteen: 'buy', barsAgo: 3 }
        });
        const resonance: FocusItem = { pattern: 'resonance', side: 'buy', intervals: ['15m', '4h'] };
        expect(facts.focus).toEqual([{ pattern: 'bounce-in-trend', small: '15m', bigs: ['1h'], bigTrend: 'down' }, resonance]);
        expect(relationItemOf(facts.focus, '15m')).toEqual(resonance);
        expect(facts.mainLine).toEqual({ interval: '15m', direction: 'bullish', leadInterval: '15m' });
    });

    test('a relay on the main line wins over a bounce', () => {
        const facts = factsOf({
            '5m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { trend: 'down', countdown: 9 },
            '4h': { trend: 'down', countdown: 11 }
        });
        const relay: FocusItem = { pattern: 'relay-exhaustion', small: '5m', big: '4h', side: 'buy', bigCountdown: 11 };
        expect(facts.focus).toEqual([relay, { pattern: 'bounce-in-trend', small: '5m', bigs: ['1h'], bigTrend: 'down' }]);
        expect(relationItemOf(facts.focus, '5m')).toEqual(relay);
        expect(facts.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
    });

    test('a resonance on the main line wins over its relay, as TS at 22:25 on 2026-10-14, and the direction stays', () => {
        const facts = factsOf({
            '5m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { thirteen: 'buy', barsAgo: 3 },
            '4h': { trend: 'down', countdown: 12 }
        });
        const resonance: FocusItem = { pattern: 'resonance', side: 'buy', intervals: ['5m', '1h'] };
        expect(facts.focus).toEqual([
            { pattern: 'relay-exhaustion', small: '1h', big: '4h', side: 'buy', bigCountdown: 12 },
            resonance
        ]);
        expect(relationItemOf(facts.focus, '1h')).toEqual(resonance);
        // R35: the 5m 13 leads over the 1h one; the same resonance names both.
        expect(relationItemOf(facts.focus, '5m')).toEqual(resonance);
        expect(facts.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
    });

    test('an intact 13 beyond 12 bars is the live 13, the main line and the relation until a new 9 or a broken risk level', () => {
        const big = { trend: 'down', countdown: 10 } as const;
        const held = factsOf({ '5m': { thirteen: 'buy', barsAgo: 30 }, '4h': big });
        expect(held.live13).toEqual([expect.objectContaining({ interval: '5m', barsAgo: 30, intact: true })]);
        expect(held.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
        expect(held.focus).toEqual([{ pattern: 'bounce-in-trend', small: '5m', bigs: ['4h'], bigTrend: 'down' }]);
        for (const gone of [{ nineAfter: true }, { broken: true }]) {
            const facts = factsOf({ '5m': { thirteen: 'buy', barsAgo: 30, ...gone }, '4h': big });
            expect(facts.live13).toEqual([]);
            expect(facts.mainLine).toBeNull();
            expect(facts.focus).toEqual([]);
        }
    });

    test('leadInterval is the main line, or for a 1h bounce the biggest timeframe it sits inside', () => {
        // R35: a short bounce leads itself.
        const bounce = factsOf({
            '5m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { trend: 'down', countdown: 8 },
            '4h': { trend: 'down', countdown: 10 }
        });
        expect(bounce.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
        const short = factsOf({ '15m': { thirteen: 'sell', barsAgo: 3 }, '4h': { trend: 'up', countdown: 4 } });
        expect(short.focus).toEqual([{ pattern: 'bounce-in-trend', small: '15m', bigs: ['4h'], bigTrend: 'up' }]);
        expect(short.mainLine).toEqual({ interval: '15m', direction: 'bearish', leadInterval: '15m' });
        // A 1h bounce inside a 4h move leads from 4h.
        const hourly = factsOf({ '1h': { thirteen: 'sell', barsAgo: 3 }, '4h': { trend: 'up', countdown: 4 } });
        expect(hourly.mainLine).toEqual({ interval: '1h', direction: 'bullish', leadInterval: '4h' });
        expect(hourly.structures.find((s) => s.interval === '4h')?.lean).toBe(hourly.mainLine?.direction);
        // The relay: the main line leads itself.
        const relay = factsOf({
            '5m': { thirteen: 'buy', barsAgo: 3 },
            '1h': { trend: 'down', countdown: 9 },
            '4h': { trend: 'down', countdown: 11 }
        });
        expect(relay.mainLine).toEqual({ interval: '5m', direction: 'bullish', leadInterval: '5m' });
    });
});

describe('relationItemOf', () => {
    const relay: FocusItem = { pattern: 'relay-exhaustion', small: '15m', big: '1d', side: 'sell', bigCountdown: 12 };
    const counter: FocusItem = { pattern: 'counter-move-ending', small: '5m', big: '4h', bigTrend: 'down', bigCountdown: 3 };
    const bounce: FocusItem = { pattern: 'bounce-in-trend', small: '5m', bigs: ['4h', '1h'], bigTrend: 'down' };
    const resonance: FocusItem = { pattern: 'resonance', side: 'buy', intervals: ['5m', '1h'] };
    const failed: FocusItem = { pattern: 'thirteen-failed', interval: '1h', side: 'buy' };
    const near: FocusItem = { pattern: 'near-exhaustion', interval: '1d', trend: 'up', countdown: 12 };

    test('relationItemOf prefers an item that involves the main line', () => {
        expect(relationItemOf([relay, counter], '5m')).toBe(counter);
        expect(relationItemOf([relay, counter], '4h')).toBe(counter);
        expect(relationItemOf([counter, relay], '1d')).toBe(relay);
        expect(relationItemOf([relay, bounce], '5m')).toBe(bounce);
        expect(relationItemOf([relay, resonance], '1h')).toBe(resonance);
    });

    test('takes a resonance on the main line over a relay on it, and only then', () => {
        const relay5m: FocusItem = { pattern: 'relay-exhaustion', small: '5m', big: '4h', side: 'buy', bigCountdown: 12 };
        expect(relationItemOf([relay5m, resonance], '5m')).toBe(resonance);
        expect(relationItemOf([relay5m, bounce, resonance], '5m')).toBe(resonance);
        expect(relationItemOf([relay5m], '5m')).toBe(relay5m);
        // A resonance that leaves out the main line does not displace its relay.
        expect(relationItemOf([relay5m, { pattern: 'resonance', side: 'buy', intervals: ['15m', '1h'] }], '5m')).toBe(relay5m);
        // R35: on a short main line the resonance beats a bounce or counter-move too; on 1h a bounce first stays first.
        expect(relationItemOf([bounce, resonance], '5m')).toBe(resonance);
        expect(relationItemOf([counter, resonance], '5m')).toBe(resonance);
        const bounce1h: FocusItem = { pattern: 'bounce-in-trend', small: '1h', bigs: ['4h'], bigTrend: 'down' };
        expect(relationItemOf([bounce1h, resonance], '1h')).toBe(bounce1h);
    });

    test('falls back to the first relation; a bounce involves only its small timeframe', () => {
        expect(relationItemOf([relay, bounce], '4h')).toBe(relay);
        expect(relationItemOf([near, failed, counter, relay], null)).toBe(counter);
        expect(relationItemOf([near, failed, resonance], '15m')).toBe(resonance);
    });

    test('is null without a relation pattern', () => {
        expect(relationItemOf([near, failed], '1d')).toBeNull();
        expect(relationItemOf([], null)).toBeNull();
    });
});

describe('buildFacts', () => {
    test('builds every block from the BTCUSDC compose windows', () => {
        const facts = buildFacts(fixtureInputs('btcusdc'));
        expect(Object.keys(facts).sort()).toEqual(['focus', 'live13', 'mainLine', 'review', 'reviewPick', 'structures']);
        expect(facts.structures.map((s) => s.interval)).toEqual(['5m', '15m', '1h', '4h']);
        expect(facts).toMatchSnapshot();
    });

    test('measures live 13s from the newest 5m close; structures keep their own close', () => {
        const inputs = fixtureInputs('xauusdt');
        expect(inputs['5m'].analysis.rows.at(-1)?.close).toBe('4185.02');
        expect(inputs['4h'].analysis.rows.at(-1)?.close).toBe('4198.84');
        const facts = buildFacts(inputs);
        expect(facts.live13).toEqual([
            {
                interval: '4h',
                side: 'buy',
                barsAgo: 4,
                price: '4116.72',
                riskLevel: '4017.16',
                intact: true,
                roomPct: '4.01',
                sincePct: '1.66',
                oppositeSetup: 3
            }
        ]);
        expect(facts.structures.find((s) => s.interval === '4h')?.close).toBe('4198.84');
    });
});
