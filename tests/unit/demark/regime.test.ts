import {
    adjustLevel,
    composeRegime,
    deriveState,
    newTrend,
    regimeOf
} from '../../../src/services/manager/demark/regime';
import { analyzeWindow } from '../../../src/services/manager/demark/summary';
import {
    DemarkSummary,
    INSIGHT_INTERVALS,
    InsightInterval,
    NewTrend,
    TimeframeRegimeState
} from '../../../src/services/manager/types/insight-types';
import { loadJson, toRows } from './helpers';

type Kline = [number, string, string, string];

interface SummaryCase {
    symbol: string;
    interval: InsightInterval;
    covers: string[];
    expected: { summary: DemarkSummary; state: TimeframeRegimeState; newTrend: NewTrend };
}

describe('regime parity with the Python reference alphabtc', () => {
    const cases: SummaryCase[] = loadJson('insight-summary-cases.json');

    test.each(cases)('deriveState and newTrend $symbol $interval $covers', (c) => {
        expect(deriveState(c.expected.summary)).toEqual(c.expected.state);
        expect(newTrend(c.expected.summary)).toEqual(c.expected.newTrend);
    });

    test.each(['btcusdc', 'nvdausdt', 'xauusdt'])('composeRegime matches Python for %s', (s) => {
        const f = loadJson(`insight-compose-${s}.json`);
        const summaries = {} as Record<InsightInterval, DemarkSummary | null>;
        for (const interval of INSIGHT_INTERVALS) {
            summaries[interval] = analyzeWindow(toRows(f.windows[interval] as Kline[]), interval).summary;
        }
        const composed = composeRegime(summaries);
        expect(composed.regime).toEqual(f.expected.regime);
        for (const interval of INSIGHT_INTERVALS) {
            const { summary: _summary, ...expected } = f.expected.timeframes[interval];
            expect(composed.timeframes[interval]).toEqual(expected);
        }
    });

    test('a missing summary yields no state, signals or new trend', () => {
        const none = { '5m': null, '15m': null, '1h': null, '4h': null, '1d': null };
        const composed = composeRegime(none);
        expect(composed.regime).toEqual({ intraday: 'unavailable', swing: 'unavailable' });
        expect(composed.timeframes['1h']).toEqual({ state: null, signals: [], newTrend: null });
    });
});

describe('adjustLevel', () => {
    test.each([
        [2, 'buy', 'pump', 3],
        [2, 'sell', 'pump', 1],
        [3, 'buy', 'rev', 2],
        [3, 'sell', 'rev', 4],
        [5, 'buy', 'pump', 5],
        [1, 'sell', 'pump', 1],
        [3, 'buy', 'decay', 3]
    ] as const)('adjustLevel(%d, %s, %s) = %d', (level, side, regime, expected) => {
        expect(adjustLevel(level, side, regime)).toBe(expected);
    });
});

describe('regimeOf', () => {
    const state = (s9: 'up' | 'down' | 'none', s13: boolean): TimeframeRegimeState => ({
        s9,
        s13,
        carry13: false,
        countdown: 0,
        setup9At: null,
        qualified13At: null,
        setup9SecondsAgo: null,
        qualified13SecondsAgo: null,
        beyondRisk9: null
    });

    test.each([
        [null, 'unavailable'],
        [state('none', false), 'none'],
        [state('down', true), 'pump'],
        [state('down', false), 'rev'],
        [state('up', true), 'rev'],
        [state('up', false), 'decay']
    ] as const)('regimeOf(%j) = %s', (input, expected) => {
        expect(regimeOf(input)).toBe(expected);
    });
});
