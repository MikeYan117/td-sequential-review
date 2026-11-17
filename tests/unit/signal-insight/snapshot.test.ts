import { buildFacts, TimeframeInput } from '../../../src/services/manager/demark/insight-facts';
import { cardProtection } from '../../../src/services/manager/demark/protection';
import { composeRegime } from '../../../src/services/manager/demark/regime';
import { SCORED_INTERVALS, cardStrength, scoreTimeframe } from '../../../src/services/manager/demark/strength';
import { WindowAnalysis, analyzeWindow } from '../../../src/services/manager/demark/summary';
import { DemarkSide } from '../../../src/services/manager/types/demark-types';
import {
    CardDirection,
    DemarkSummary,
    INSIGHT_INTERVALS,
    InsightInterval,
    InsightSnapshot,
    InsightText,
    Lean,
    ScoredInterval,
    TimeframeScore
} from '../../../src/services/manager/types/insight-types';
import { TICK_OFFSET_MS } from '../../../src/services/sync/signal-push/signal-push-task';
import { SIGNAL_SYMBOLS, SignalSymbol } from '../../../src/services/sync/signal-push/symbols';
import { cardPhase } from '../../../src/services/sync/signal-insight/card-phase';
import { assembleSnapshot, attachInsight } from '../../../src/services/sync/signal-insight/snapshot';
import { loadJson, toRows } from '../demark/helpers';

function symbolOf(klineSymbol: string): SignalSymbol {
    const symbol = SIGNAL_SYMBOLS.find((s) => s.klineSymbol === klineSymbol);
    if (symbol === undefined) {
        throw new Error(`${klineSymbol} is not a signal symbol`);
    }
    return symbol;
}

/** `bars` keeps only the first bars of a window, replaying that timeframe as of an earlier close. */
function fixtureWindows(name: string, bars: Partial<Record<InsightInterval, number>> = {}): Record<InsightInterval, WindowAnalysis> {
    const f = loadJson(`insight-compose-${name}.json`);
    const windows = {} as Record<InsightInterval, WindowAnalysis>;
    for (const interval of INSIGHT_INTERVALS) {
        windows[interval] = analyzeWindow(toRows(f.windows[interval]).slice(0, bars[interval]), interval);
    }
    return windows;
}

const SIDE_LEAN: Record<DemarkSide, Lean> = { buy: 'bullish', sell: 'bearish' };

/** Each scored timeframe's score side, as a lean, next to its facts lean. */
function sidesAndLeans(snapshot: InsightSnapshot): { interval: InsightInterval; side: Lean | null; lean: Lean | null }[] {
    return snapshot.timeframes
        .filter((t) => t.interval !== '1d')
        .map((t) => ({
            interval: t.interval,
            side: t.score === null ? null : SIDE_LEAN[t.score.side],
            lean: snapshot.facts.structures.find((s) => s.interval === t.interval)?.lean ?? null
        }));
}

function lastOpen(analysis: WindowAnalysis): number {
    return analysis.rows[analysis.rows.length - 1]?.openTime ?? NaN;
}

function text(direction: CardDirection, asOf: number): InsightText {
    const sections = { conclusion: 'c', timeframes: 't', review: 'r', watch: 'w' };
    return { asOf, generatedAt: asOf + 40_000, model: 'gpt-6.1-sol', direction, sections: { en: sections, zhCN: sections, zhTW: sections, ko: sections, ja: sections } };
}

describe('assembleSnapshot', () => {
    const windows = fixtureWindows('btcusdc');
    const { snapshot, input } = assembleSnapshot(symbolOf('BTCUSDC'), windows);

    const summaries = {} as Record<InsightInterval, DemarkSummary | null>;
    for (const interval of INSIGHT_INTERVALS) {
        summaries[interval] = windows[interval].summary;
    }
    const composed = composeRegime(summaries);
    const inputs = {} as Record<InsightInterval, TimeframeInput>;
    for (const interval of INSIGHT_INTERVALS) {
        inputs[interval] = { analysis: windows[interval], composed: composed.timeframes[interval] };
    }
    const facts = buildFacts(inputs);
    const scores = {} as Record<ScoredInterval, TimeframeScore | null>;
    for (const interval of SCORED_INTERVALS) {
        const tf = composed.timeframes[interval];
        const structure = facts.structures.find((s) => s.interval === interval) ?? null;
        scores[interval] = scoreTimeframe(interval, tf.state, tf.signals, lastOpen(windows[interval]), structure);
    }

    it('describes the symbol and rulesets', () => {
        expect(snapshot).toMatchObject({
            symbol: 'BTCUSDC',
            source: 'binance-usdm',
            ruleset: 'td-sequential-v2',
            strengthRuleset: 'strength-v1.5'
        });
    });

    it('lists the five timeframes in order and never scores 1d', () => {
        expect(snapshot.timeframes.map((t) => t.interval)).toEqual(['5m', '15m', '1h', '4h', '1d']);
        const daily = snapshot.timeframes[4];
        expect(daily?.score).toBeNull();
        expect(daily?.summary).toEqual(windows['1d'].summary);
        for (const tf of snapshot.timeframes) {
            const c = composed.timeframes[tf.interval];
            expect(tf.lastClosedBarTime).toBe(lastOpen(windows[tf.interval]));
            expect(tf.summary).toEqual(summaries[tf.interval]);
            expect(tf.state).toEqual(c.state);
            expect(tf.signals).toEqual(c.signals);
            expect(tf.newTrend).toEqual(c.newTrend);
            if (tf.interval !== '1d') {
                expect(tf.score).toEqual(scores[tf.interval]);
            }
        }
    });

    it('scores the card from its lead and the four scored timeframes, with its protection and no insight yet', () => {
        // The 15m up 13, the bigger of the two short 13s, is the main line and leads: its sell 13 (level 3, 22 bars old, e 1.5)
        // scores 12 x 1.5, plus 4 x e for 5m's sell 13 (19 bars old, e 1.5) and 4h's down 9 (5 bars old, e 2 x 19/24).
        // 1h's up 9 is listed against it, not subtracted: 18 + 6 + 6.33 = 30.
        expect(snapshot.facts.mainLine).toEqual({ interval: '15m', direction: 'bearish', leadInterval: '15m' });
        const strength = cardStrength(scores, { direction: 'bearish', interval: '15m', score: scores['15m'] as TimeframeScore });
        expect(strength).toEqual({
            direction: 'bearish',
            strength: 30,
            strengthLabel: 'weak',
            anchorInterval: '15m',
            confluentIntervals: ['5m', '15m', '4h'],
            conflictingIntervals: ['1h']
        });
        expect(snapshot.card).toEqual({
            ...strength,
            phase: cardPhase(strength, snapshot.facts.structures),
            protection: cardProtection(strength, inputs, snapshot.facts.structures),
            insight: null
        });
        expect(snapshot.card.direction).not.toBe('neutral');
        expect(snapshot.card.protection).not.toBeNull();
        expect(snapshot.regime).toEqual(composed.regime);
    });

    it('sets the card direction from facts.mainLine', () => {
        const lead = snapshot.facts.mainLine?.direction ?? null;
        expect(snapshot.card.direction).toBe(lead ?? cardStrength(scores, null).direction);
        expect(snapshot.strengthRuleset).toBe('strength-v1.5');
    });

    it('carries the rule-computed facts', () => {
        expect(snapshot.facts).toEqual(facts);
    });

    it('is as of the newest 5m close and due again 10s after the next one', () => {
        expect(snapshot.asOf).toBe(lastOpen(windows['5m']) + 300_000);
        expect(snapshot.nextUpdateAt).toBe(snapshot.asOf + 300_000 + TICK_OFFSET_MS);
    });

    it('gives the LLM the display name, the card direction with its anchor, and the facts', () => {
        expect(input).toEqual({
            symbol: 'BTC',
            card: { direction: snapshot.card.direction, anchorInterval: snapshot.card.anchorInterval },
            facts: snapshot.facts
        });
    });

    it('accepts a window shorter than 500 bars', () => {
        const nvda = fixtureWindows('nvdausdt');
        expect(nvda['1d'].rows.length).toBeLessThan(500);
        const result = assembleSnapshot(symbolOf('NVDAUSDT'), nvda);
        expect(result.snapshot.timeframes[4]?.lastClosedBarTime).toBe(lastOpen(nvda['1d']));
        expect(result.input.symbol).toBe('NVDA');
    });
});

describe('a timeframe whose 13 has failed', () => {
    // NVDAUSDT 15m carries a sell 13 whose risk level has broken.
    const { snapshot } = assembleSnapshot(symbolOf('NVDAUSDT'), fixtureWindows('nvdausdt'));

    it('is not scored and sits on neither side of the card', () => {
        expect(snapshot.strengthRuleset).toBe('strength-v1.5');
        expect(snapshot.facts.structures.find((s) => s.interval === '15m')).toMatchObject({
            stage: 'exhausted',
            thirteenFailed: true,
            lean: null
        });
        expect(snapshot.timeframes.find((t) => t.interval === '15m')?.score).toBeNull();
        expect(snapshot.card.confluentIntervals).not.toContain('15m');
        expect(snapshot.card.conflictingIntervals).not.toContain('15m');
        // R35: the main line is the 5m up 13. It is only a pullback inside the 1h up move, but a short main
        // line leads the card itself: bearish from 5m, with 4h's down 9 on its side and 1h's up 9 listed against it.
        expect(snapshot.facts.mainLine).toEqual({ interval: '5m', direction: 'bearish', leadInterval: '5m' });
        expect(snapshot.card).toMatchObject({
            direction: 'bearish',
            strength: 24,
            anchorInterval: '5m',
            confluentIntervals: ['5m', '4h'],
            conflictingIntervals: ['1h']
        });
    });
});

describe('each scored timeframe counts on the side of its facts lean', () => {
    test.each(['btcusdc', 'nvdausdt', 'xauusdt'])('%s, as of each of the last 100 closes of every scored timeframe', (name) => {
        const symbol = symbolOf(name.toUpperCase());
        const klines = loadJson(`insight-compose-${name}.json`).windows;
        const full = fixtureWindows(name);
        for (const interval of SCORED_INTERVALS) {
            const rows = toRows(klines[interval]);
            for (let bars = rows.length - 99; bars <= rows.length; bars++) {
                const windows = { ...full, [interval]: analyzeWindow(rows.slice(0, bars), interval) };
                const { snapshot } = assembleSnapshot(symbol, windows);
                for (const { side, lean } of sidesAndLeans(snapshot)) {
                    expect(side).toBe(lean);
                }
            }
        }
    });

    test.each([
        // NVDAUSDT 15m: a sell 9 held by an older countdown that reaches 13 on the last bar.
        ['nvdausdt', '15m', 485],
        // BTCUSDC 5m: the same, with the held 9 two bars before the 13.
        ['btcusdc', '5m', 418]
    ] as const)('%s %s at %d bars: a condition (b) 13 counts on the reversal side', (name, interval, bars) => {
        const { snapshot } = assembleSnapshot(symbolOf(name.toUpperCase()), fixtureWindows(name, { [interval]: bars }));
        const tf = snapshot.timeframes.find((t) => t.interval === interval);
        expect(tf?.state).toMatchObject({ s9: 'up', s13: false, countdown: 0 });
        expect(snapshot.facts.structures.find((s) => s.interval === interval)).toMatchObject({ stage: 'exhausted', lean: 'bearish' });
        // Only signal 1 is active, already on the sell side; the intraday regime is decay, so its level stays 2.
        expect(tf?.score).toMatchObject({ side: 'sell', level: 2 });
    });
});

describe('every directional card scores above 0 from a lead', () => {
    test.each(['btcusdc', 'nvdausdt', 'xauusdt'])('%s, as of each of the last 100 closes of every timeframe', (name) => {
        const symbol = symbolOf(name.toUpperCase());
        const klines = loadJson(`insight-compose-${name}.json`).windows;
        const full = fixtureWindows(name);
        for (const interval of INSIGHT_INTERVALS) {
            const rows = toRows(klines[interval]);
            for (let bars = rows.length - 99; bars <= rows.length; bars++) {
                const windows = { ...full, [interval]: analyzeWindow(rows.slice(0, bars), interval) };
                const { card, facts } = assembleSnapshot(symbol, windows).snapshot;
                if (card.direction === 'neutral') {
                    expect(card).toMatchObject({ strength: 0, anchorInterval: null, protection: null });
                    expect(card.phase.stage).toBe('forming');
                    continue;
                }
                expect(card.strength).toBeGreaterThan(0);
                expect(card.anchorInterval).not.toBeNull();
                expect(card.phase.stage).toBe(facts.structures.find((s) => s.interval === card.anchorInterval)?.stage);
                expect(card.phase.stage).not.toBe('forming');
                if (facts.mainLine !== null) {
                    expect(card.anchorInterval).toBe(facts.mainLine.leadInterval);
                }
            }
        }
    });
});

describe('card phase on real windows', () => {
    test.each([
        // The 15m up 13 leads the bearish card.
        ['btcusdc', 'BTCUSDC', 'exhausted', '短趋势上涨反转'],
        // R35: the 5m up 13 leads the bearish card, though it is only a pullback inside the 1h up move.
        ['nvdausdt', 'NVDAUSDT', 'exhausted', '短趋势上涨反转'],
        // R36: the 4h down 13 leads the bullish card; the 1d down move it bounces in is no longer read.
        ['xauusdt', 'XAUUSDT', 'exhausted', '长趋势下跌反转']
    ] as const)('%s', (name, klineSymbol, stage, zhCN) => {
        expect(assembleSnapshot(symbolOf(klineSymbol), fixtureWindows(name)).snapshot.card.phase).toMatchObject({
            stage,
            title: { zhCN }
        });
    });
});

describe('card protection on real windows', () => {
    test.each([
        // The 15m up 13 leads the bearish card; the stop is its risk level (82694.5), 0.29% above the newest 5m close,
        // over 8 15m bars (2H); 29bp sits in the 2H band (10-50bp), so the target stays.
        ['btcusdc', 'BTCUSDC', { optionType: 'call', interval: '15m', durationSeconds: 7_200, stop: { signal: 13, price: '82694.5', distancePct: '0.29' } }],
        // Durations (8 bars, shorter only): NVDA 26bp and XAU 44bp are inside the 1H band (10-50bp), the 5m target.
        // R35: the 5m up 13 leads the bearish card, so 5m is protected with a call at the 13's risk level.
        ['nvdausdt', 'NVDAUSDT', { optionType: 'call', interval: '5m', durationSeconds: 3_600, stop: { signal: 13, price: '235.6', distancePct: '0.26' } }],
        // R36: the 4h down 13 leads the bullish card, so 4h is protected with a put at the 13's risk level, 4.01% below:
        // beyond the 24H band (75-375bp), so the 24H target stays and the frontend picks its deepest strike.
        ['xauusdt', 'XAUUSDT', { optionType: 'put', interval: '4h', durationSeconds: 86_400, stop: { signal: 13, price: '4017.16', distancePct: '4.01' } }]
    ])('%s', (name, klineSymbol, expected) => {
        expect(assembleSnapshot(symbolOf(klineSymbol), fixtureWindows(name)).snapshot.card.protection).toEqual(expected);
    });
});

describe('attachInsight', () => {
    const { snapshot } = assembleSnapshot(symbolOf('BTCUSDC'), fixtureWindows('btcusdc'));
    const direction = snapshot.card.direction;
    const opposite: CardDirection = direction === 'bullish' ? 'bearish' : 'bullish';
    const MAX_AGE_MS = 15 * 60_000;

    it('attaches a text written in the card direction', () => {
        const same = text(direction, snapshot.asOf - 300_000);
        const attached = attachInsight(snapshot, same, MAX_AGE_MS);
        expect(attached.card.insight).toEqual(same);
        expect({ ...attached, card: { ...attached.card, insight: null } }).toEqual(snapshot);
        expect(snapshot.card.insight).toBeNull();
    });

    it('hides a text written in another direction', () => {
        expect(attachInsight(snapshot, text(opposite, snapshot.asOf), MAX_AGE_MS).card.insight).toBeNull();
        expect(attachInsight(snapshot, null, MAX_AGE_MS).card.insight).toBeNull();
    });

    it('hides a text more than maxAgeMs behind the card', () => {
        const atLimit = text(direction, snapshot.asOf - MAX_AGE_MS);
        expect(attachInsight(snapshot, atLimit, MAX_AGE_MS).card.insight).toEqual(atLimit);
        expect(attachInsight(snapshot, text(direction, snapshot.asOf - MAX_AGE_MS - 1), MAX_AGE_MS).card.insight).toBeNull();
    });
});
