import { INTERVAL_MS } from '../../../src/services/manager/demark/binance-klines';
import { SequenceState } from '../../../src/services/manager/demark/engine';
import { TimeframeInput, timeframeStructure } from '../../../src/services/manager/demark/insight-facts';
import { cardProtection, durationFitting } from '../../../src/services/manager/demark/protection';
import { DemarkSide } from '../../../src/services/manager/types/demark-types';
import {
    CardDirection,
    CardStrength,
    DemarkSummary,
    DemarkTrend,
    INSIGHT_INTERVALS,
    InsightInterval,
    ScoredInterval,
    TimeframeRegimeState,
    TimeframeStructure
} from '../../../src/services/manager/types/insight-types';

const BARS = 40;

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function card(direction: CardDirection, anchorInterval: ScoredInterval | null): CardStrength {
    return {
        direction,
        strength: direction === 'neutral' ? 0 : 30,
        strengthLabel: 'weak',
        anchorInterval,
        confluentIntervals: anchorInterval === null ? [] : [anchorInterval],
        conflictingIntervals: []
    };
}

function summary(side: DemarkSide, tdst: string | null): DemarkSummary {
    return {
        side,
        trend: side === 'buy' ? 'down' : 'up',
        phase: 'countdown',
        step: 3,
        target: 13,
        setupStep: 9,
        countdownStep: 3,
        rounds: [],
        lastSignal: null,
        prev: null,
        second: null,
        barsSinceQualified13: null,
        setupRun: { start: 0, side, count: 9, active: false, completed: true },
        risk: {
            risk9: null,
            risk9At: null,
            setupClose: null,
            riskLevel: null,
            risk13At: null,
            provisional: true,
            close13: null,
            tdst,
            nextBarNeeds: null
        },
        asOf: 0,
        close: '100'
    };
}

function state(partial: Partial<TimeframeRegimeState>): TimeframeRegimeState {
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

/** A qualified 13 on bar `at` with a scaled risk level. */
function thirteen(side: DemarkSide, at: number, risk: bigint): SequenceState {
    return {
        id: at,
        side,
        setup: range(at - 21, at - 13),
        setupStatus: 'completed',
        perfected: false,
        countdown: range(at - 12, at),
        countdownStatus: 'qualified13',
        tdst: null,
        risk,
        riskStatus: 'valid'
    };
}

function structure(
    interval: InsightInterval,
    trend: DemarkTrend,
    stage: TimeframeStructure['stage']
): TimeframeStructure {
    return {
        interval,
        close: '100',
        trend,
        stage,
        setupStep: 9,
        countdown: stage === 'exhausted' ? 13 : 3,
        formingOpposite: null,
        timeline: [],
        thirteenFailed: false,
        lean: null
    };
}

interface Frame {
    summary?: DemarkSummary;
    state?: TimeframeRegimeState;
    sequences?: SequenceState[];
    scale?: number;
}

/** Every timeframe flat at `price` (the newest 5m close), with `frame` on `interval`. */
function inputs(interval: InsightInterval, frame: Frame, price = '100'): Record<InsightInterval, TimeframeInput> {
    const result = {} as Record<InsightInterval, TimeframeInput>;
    for (const each of INSIGHT_INTERVALS) {
        const own = each === interval ? frame : {};
        result[each] = {
            analysis: {
                interval: each,
                rows: Array.from({ length: BARS }, (_, i) => ({
                    openTime: i * INTERVAL_MS[each],
                    high: price,
                    low: price,
                    close: price
                })),
                scale: own.scale ?? 0,
                engine: { sequences: own.sequences ?? [], events: [] },
                summary: own.summary ?? summary('buy', null)
            },
            composed: { state: own.state ?? state({}), signals: [], newTrend: null }
        };
    }
    return result;
}

/** A sell 9 counting toward 13 (an up move) with its TDST below price. */
const UP_COUNTING = { summary: summary('sell', '98'), state: state({ s9: 'up', countdown: 3 }) };
/** A buy 9 counting toward 13 (a down move) with its TDST above price. */
const DOWN_COUNTING = { summary: summary('buy', '102'), state: state({ s9: 'down', countdown: 3 }) };

describe('cardProtection', () => {
    test('is null for a neutral card', () => {
        expect(cardProtection(card('neutral', null), inputs('15m', {}), [])).toBeNull();
    });

    test('throws when a directional card has no anchor timeframe', () => {
        expect(() => cardProtection(card('bullish', null), inputs('15m', {}), [])).toThrow('anchor');
        expect(() => cardProtection(card('bearish', null), inputs('15m', {}), [])).toThrow('anchor');
    });

    test('throws when the anchor timeframe has no structure', () => {
        expect(() => cardProtection(card('bullish', '15m'), inputs('15m', UP_COUNTING), [])).toThrow('structure');
    });

    test('protects a bullish card anchored on an up 9 with a put at its TDST below price', () => {
        const found = cardProtection(card('bullish', '15m'), inputs('15m', UP_COUNTING), [structure('15m', 'up', 'established')]);
        expect(found).toEqual({
            optionType: 'put',
            interval: '15m',
            durationSeconds: 7_200,
            stop: { signal: 9, price: '98', distancePct: '2.00' }
        });
    });

    test('protects a bearish card anchored on a down 9 with a call at its TDST above price', () => {
        const found = cardProtection(card('bearish', '15m'), inputs('15m', DOWN_COUNTING), [structure('15m', 'down', 'established')]);
        expect(found).toEqual({
            optionType: 'call',
            interval: '15m',
            durationSeconds: 7_200,
            stop: { signal: 9, price: '102', distancePct: '2.00' }
        });
    });

    // Stops 0.40% away (3.00% on 4h) sit inside the target duration's strike band (8 bars of 5m/15m/1h/4h).
    test.each([
        ['5m', 3_600],
        ['15m', 7_200],
        ['1h', 28_800],
        ['4h', 86_400]
    ] as const)('uses the target duration (8 %s bars) when the stop fits its strike band', (interval, seconds) => {
        const tdst = interval === '4h' ? '97' : '99.6';
        const frame = { summary: summary('sell', tdst), state: state({ s9: 'up', countdown: 3 }) };
        const found = cardProtection(card('bullish', interval), inputs(interval, frame), [structure(interval, 'up', 'established')]);
        expect(found?.durationSeconds).toBe(seconds);
    });

    test('has no 9 stop when the summary is on the other side of the move', () => {
        // Defensive guard: an established structure does not produce this state. In setup phase the summary's tdst
        // is the last completed setup of either side, so the side is checked before it is used.
        const frame = { summary: summary('buy', '97'), state: state({ s9: 'up', countdown: 0 }) };
        expect(cardProtection(card('bullish', '15m'), inputs('15m', frame), [structure('15m', 'up', 'established')])?.stop).toBeNull();
    });

    test('has no 9 stop without a TDST, or on a forming structure', () => {
        const noTdst = { summary: summary('sell', null), state: state({ s9: 'up', countdown: 3 }) };
        expect(cardProtection(card('bullish', '15m'), inputs('15m', noTdst), [structure('15m', 'up', 'established')])?.stop).toBeNull();
        expect(cardProtection(card('bullish', '15m'), inputs('15m', UP_COUNTING), [structure('15m', 'up', 'forming')])?.stop).toBeNull();
    });

    test('protects a bearish card with a call from the risk level of the 13 its state points to', () => {
        const frame = {
            summary: summary('sell', '110'),
            state: state({ s9: 'up', s13: true, carry13: true, countdown: 13, qualified13At: 30 * INTERVAL_MS['1h'] }),
            sequences: [thirteen('sell', 20, 120n), thirteen('sell', 30, 105n)]
        };
        expect(cardProtection(card('bearish', '1h'), inputs('1h', frame), [structure('1h', 'up', 'exhausted')])).toEqual({
            optionType: 'call',
            interval: '1h',
            durationSeconds: 28_800,
            stop: { signal: 13, price: '105', distancePct: '5.00' }
        });
    });

    test('finds a carried 13 although the summary describes the new opposite setup', () => {
        const frame = {
            summary: summary('buy', '96'),
            state: state({ s9: 'up', s13: true, carry13: true, countdown: 13, qualified13At: 25 * INTERVAL_MS['5m'] }),
            sequences: [thirteen('sell', 25, 1015n)],
            scale: 1
        };
        expect(cardProtection(card('bearish', '5m'), inputs('5m', frame), [structure('5m', 'up', 'exhausted')])?.stop).toEqual({
            signal: 13,
            price: '101.5',
            distancePct: '1.50'
        });
    });

    test('stops at the 13 risk level when a held new 9 leaves the move exhausted through condition (b)', () => {
        // The state reads the held new sell 9 (s13 false, countdown 0); the older sell 13 qualified on the 9's own bar.
        const heldNine: SequenceState = {
            ...thirteen('sell', 30, 0n),
            id: 31,
            setup: range(22, 30),
            countdown: [],
            countdownStatus: 'active',
            risk: null
        };
        const frame = {
            summary: summary('sell', '98'),
            state: state({ s9: 'up', countdown: 0 }),
            sequences: [thirteen('sell', 30, 105n), heldNine]
        };
        const all = inputs('1h', frame);
        const built = timeframeStructure(all['1h']);
        expect(built).toMatchObject({ trend: 'up', stage: 'exhausted', thirteenFailed: false });
        expect(cardProtection(card('bearish', '1h'), all, [built as TimeframeStructure])?.stop).toEqual({
            signal: 13,
            price: '105',
            distancePct: '5.00'
        });
    });

    test('has no stop once the 13 risk level was broken', () => {
        const frame = {
            summary: summary('sell', '103'),
            state: state({ s9: 'up', s13: true, carry13: true, countdown: 13, qualified13At: 30 * INTERVAL_MS['15m'] }),
            sequences: [{ ...thirteen('sell', 30, 105n), riskStatus: 'invalidated' as const }]
        };
        expect(cardProtection(card('bearish', '15m'), inputs('15m', frame), [structure('15m', 'up', 'exhausted')])?.stop).toBeNull();
    });

    test('reports a negative distance once price is through the stop and 0.00 on it', () => {
        const through = { summary: summary('sell', '101'), state: UP_COUNTING.state };
        const established = [structure('15m', 'up', 'established')];
        expect(cardProtection(card('bullish', '15m'), inputs('15m', through), established)?.stop?.distancePct).toBe('-1.00');
        const on = { summary: summary('sell', '100'), state: UP_COUNTING.state };
        expect(cardProtection(card('bullish', '15m'), inputs('15m', on), established)?.stop?.distancePct).toBe('0.00');
    });

    test('measures the distance from the newest 5m close, not the anchor close', () => {
        const all = inputs('1h', UP_COUNTING);
        all['1h'].analysis.rows.forEach((row) => (row.close = '120'));
        expect(cardProtection(card('bullish', '1h'), all, [structure('1h', 'up', 'established')])?.stop?.distancePct).toBe('2.00');
    });
});

describe('durationFitting', () => {
    const H = 3_600;
    test.each([
        [H, 20, H],
        [7_200, 50, 7_200],
        [28_800, 100, 28_800],
        [86_400, 200, 86_400],
        // a stop beyond the deepest strike keeps the target
        [H, 80, H],
        [H, 180, H],
        [7_200, 120, 7_200],
        [7_200, 250, 7_200],
        [28_800, 200, 28_800],
        [28_800, 400, 28_800],
        // shift shorter
        [28_800, 25, 14_400],
        [28_800, 15, 7_200],
        [86_400, 50, 43_200],
        [86_400, 35, 28_800],
        [86_400, 25, 14_400]
    ])('target %d at %dbp -> %d', (target, bps, expected) => {
        expect(durationFitting(target, bps)).toBe(expected);
    });

    test.each([
        [10, 3_600],
        [50, 3_600],
        [375, 3_600],
        [376, 3_600],
        [5, 3_600],
        [0, 3_600],
        [-30, 3_600],
        [null, 3_600]
    ])('boundary %s with target 1H -> %s', (bps, expected) => {
        expect(durationFitting(3_600, bps)).toBe(expected);
    });

    test('steps shorter only from 10bp up; nearer, not positive or no stop keeps the target', () => {
        expect(durationFitting(86_400, 10)).toBe(7_200);
        expect(durationFitting(86_400, 9)).toBe(86_400);
        expect(durationFitting(86_400, 0)).toBe(86_400);
        expect(durationFitting(86_400, -30)).toBe(86_400);
        expect(durationFitting(86_400, null)).toBe(86_400);
        expect(durationFitting(28_800, 10)).toBe(7_200);
        expect(durationFitting(28_800, 9)).toBe(28_800);
    });

    test('exact band edges count as fitting', () => {
        expect(durationFitting(86_400, 75)).toBe(86_400);
        expect(durationFitting(28_800, 30)).toBe(28_800);
        expect(durationFitting(28_800, 150)).toBe(28_800);
        expect(durationFitting(86_400, 74)).toBe(43_200);
        expect(durationFitting(28_800, 29)).toBe(14_400);
        expect(durationFitting(3_600, 51)).toBe(3_600);
    });

    test('rejects a duration that is not offered', () => {
        expect(() => durationFitting(5_400, 40)).toThrow('5400');
    });

    // [timeframe target, [representative bp per column]] -> duration, from the shared 11-column table.
    const COLS = [5, 15, 25, 35, 45, 60, 90, 130, 180, 300, 400];
    const TABLE: Record<string, number[]> = {
        '3600': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        '7200': [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        '28800': [8, 2, 4, 8, 8, 8, 8, 8, 8, 8, 8],
        '86400': [24, 2, 4, 8, 12, 12, 24, 24, 24, 24, 24]
    };
    test.each(Object.keys(TABLE))('matches the reference table for target %s', (target) => {
        const got = COLS.map((bps) => durationFitting(Number(target), bps) / 3_600);
        expect(got).toEqual(TABLE[target]);
    });
});
