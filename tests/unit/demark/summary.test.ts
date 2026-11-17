import { analyzeWindow } from '../../../src/services/manager/demark/summary';
import { DemarkSummary, INSIGHT_INTERVALS, InsightInterval } from '../../../src/services/manager/types/insight-types';
import { flatRows, loadJson, toRows } from './helpers';

type Kline = [number, string, string, string];

interface SummaryCase {
    symbol: string;
    interval: InsightInterval;
    covers: string[];
    klines: Kline[];
    expected: { summary: DemarkSummary };
}

interface ComposeFixture {
    windows: Record<InsightInterval, Kline[]>;
    expected: { timeframes: Record<InsightInterval, { summary: DemarkSummary | null }> };
}

/** Branches of the Python summary / regime state that the single-window cases must exercise. */
const ALL_FEATURES = [
    'carry13',
    'second',
    'firmRisk13',
    'provisionalRisk13',
    'prevQualified',
    'prevUnqualified',
    'setupCloseDropped',
    'countdownNeeds',
    'setupNeeds',
    'beyondRisk9True',
    'beyondRisk9False',
    'countdownStepOnQualifyBar',
    'newTrendConfirmed',
    's9None',
    'risk9Tie',
    'prevQualifiedBarsAgo1'
];

describe('analyzeWindow summary parity with the Python reference summarize', () => {
    const cases: SummaryCase[] = loadJson('insight-summary-cases.json');

    test.each(cases)('$symbol $interval $covers', (c) => {
        expect(analyzeWindow(toRows(c.klines), c.interval).summary).toEqual(c.expected.summary);
    });

    test.each(['btcusdc', 'nvdausdt', 'xauusdt'])('compose window summaries match Python for %s', (s) => {
        const f: ComposeFixture = loadJson(`insight-compose-${s}.json`);
        for (const interval of INSIGHT_INTERVALS) {
            expect(analyzeWindow(toRows(f.windows[interval]), interval).summary).toEqual(
                f.expected.timeframes[interval].summary
            );
        }
    });

    test('fixtures cover every branch', () => {
        expect([...new Set(cases.flatMap((c) => c.covers))].sort()).toEqual([...ALL_FEATURES].sort());
    });

    test('returns a null summary when the window has no sequence', () => {
        expect(analyzeWindow(flatRows(8, '100'), '5m').summary).toBeNull();
    });
});
