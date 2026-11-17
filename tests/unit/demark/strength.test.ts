import { INTERVAL_MS } from '../../../src/services/manager/demark/binance-klines';
import { regimeSignals } from '../../../src/services/manager/demark/regime';
import {
    STRENGTH_V1,
    cardStrength,
    scoreTimeframe,
    strengthLabel
} from '../../../src/services/manager/demark/strength';
import {
    DemarkSummary,
    DemarkTrend,
    InsightInterval,
    Lean,
    Regime,
    RegimeSignal,
    ScoredInterval,
    TimeframeRegimeState,
    TimeframeScore,
    TimeframeStructure
} from '../../../src/services/manager/types/insight-types';
import { DemarkSide } from '../../../src/services/manager/types/demark-types';
import { readingLean } from './helpers';

function s(side: DemarkSide, e: number): TimeframeScore {
    return { side, level: e, ageBars: 0, fresh: 1, e };
}

function scores(partial: Partial<Record<ScoredInterval, TimeframeScore>>) {
    return { '5m': null, '15m': null, '1h': null, '4h': null, ...partial };
}

describe('cardStrength without a lead keeps v1.2', () => {
    it('scores a single signal', () => {
        const r = cardStrength(scores({ '15m': s('buy', 2) }), null);
        expect(r).toMatchObject({ direction: 'bullish', strength: 24, strengthLabel: 'weak', anchorInterval: '15m' });
        expect(cardStrength(scores({ '15m': s('buy', 3) }), null).strength).toBe(36);
        const r4 = cardStrength(scores({ '15m': s('buy', 4) }), null);
        expect(r4.strength).toBe(48);
        expect(r4.strengthLabel).toBe('moderate');
    });

    it('adds confluence and breaks anchor ties toward the larger timeframe', () => {
        const r = cardStrength(scores({ '5m': s('buy', 4), '15m': s('buy', 4) }), null);
        expect(r).toMatchObject({ strength: 64, strengthLabel: 'moderate', anchorInterval: '15m' });
        expect(r.confluentIntervals).toEqual(['5m', '15m']);
        const r3 = cardStrength(scores({ '5m': s('buy', 4), '15m': s('buy', 4), '1h': s('buy', 4) }), null);
        expect(r3).toMatchObject({ strength: 80, strengthLabel: 'strong', anchorInterval: '1h' });
    });

    it('subtracts conflicts', () => {
        const r = cardStrength(scores({ '15m': s('buy', 4), '4h': s('sell', 2) }), null);
        expect(r).toMatchObject({ direction: 'bullish', strength: 32 });
        expect(r.conflictingIntervals).toEqual(['4h']);
    });

    it('is neutral on a tie', () => {
        expect(cardStrength(scores({ '5m': s('buy', 3), '15m': s('sell', 3) }), null)).toEqual({
            direction: 'neutral',
            strength: 0,
            strengthLabel: 'weak',
            anchorInterval: null,
            confluentIntervals: [],
            conflictingIntervals: []
        });
        expect(cardStrength(scores({}), null)).toMatchObject({ direction: 'neutral', strength: 0 });
    });

    it('clamps to 100 and handles bearish', () => {
        const all = { '5m': s('buy', 5), '15m': s('buy', 5), '1h': s('buy', 5), '4h': s('buy', 5) };
        expect(cardStrength(all, null)).toMatchObject({ strength: 100, strengthLabel: 'strong' });
        expect(cardStrength(scores({ '1h': s('sell', 2.5) }), null)).toMatchObject({ direction: 'bearish', strength: 30 });
    });
});

describe('cardStrength with a lead (strength-v1.3)', () => {
    it('cardStrength with a lead adds confluence and never subtracts conflicts', () => {
        const input = scores({ '5m': s('buy', 1), '15m': s('buy', 2), '1h': s('sell', 2), '4h': s('sell', 2) });
        const r = cardStrength(input, { direction: 'bullish', interval: '5m', score: input['5m'] as TimeframeScore });
        // 12 x 1 for the 5m lead + 4 x 2 for 15m; 1h and 4h are listed, not subtracted.
        expect(r).toEqual({
            direction: 'bullish',
            strength: 20,
            strengthLabel: 'weak',
            anchorInterval: '5m',
            confluentIntervals: ['5m', '15m'],
            conflictingIntervals: ['1h', '4h']
        });
        expect(cardStrength(input, null).direction).toBe('bearish');
    });

    it('a lead without confluence scores twelve times its evidence', () => {
        const lead = s('sell', 1.5);
        const r = cardStrength(scores({ '15m': s('buy', 3), '4h': lead }), { direction: 'bearish', interval: '4h', score: lead });
        // The lead is a scored timeframe, so it is in confluentIntervals and is counted once, at 12.
        expect(r).toEqual({
            direction: 'bearish',
            strength: 18,
            strengthLabel: 'weak',
            anchorInterval: '4h',
            confluentIntervals: ['4h'],
            conflictingIntervals: ['15m']
        });
    });

    it('a lead whose score side contradicts its direction throws', () => {
        expect(() => cardStrength(scores({}), { direction: 'bullish', interval: '4h', score: s('sell', 1) })).toThrow('4h');
    });
});

const T = 10_000_000_000;

function state(over: Partial<TimeframeRegimeState> = {}): TimeframeRegimeState {
    return {
        s9: 'up',
        s13: false,
        carry13: false,
        countdown: 0,
        setup9At: T,
        qualified13At: null,
        setup9SecondsAgo: null,
        qualified13SecondsAgo: null,
        beyondRisk9: null,
        ...over
    };
}

/** regimeSignals reads only the two prices off the summary. */
const SUMMARY: DemarkSummary = {
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
    asOf: T,
    close: '100'
};

/** AlphaBTC's signals for `st` under one regime, as composeRegime builds them. */
function signalsOf(st: TimeframeRegimeState, regime: Regime): RegimeSignal[] {
    return regimeSignals(st, SUMMARY, regime, regime);
}

/** A move counting from 9 toward 13 (`established`), or one exhausted by an intact 13. */
function counting(trend: DemarkTrend): TimeframeRegimeState {
    return state({ s9: trend, countdown: 4 });
}
function carried13(trend: DemarkTrend, over: Partial<TimeframeRegimeState> = {}): TimeframeRegimeState {
    return state({ s9: trend, s13: true, carry13: true, countdown: 13, qualified13At: T, setup9At: T - 20 * INTERVAL_MS['15m'], ...over });
}
function structureOf(trend: DemarkTrend, stage: TimeframeStructure['stage'], thirteenFailed = false): Pick<TimeframeStructure, 'stage' | 'lean'> {
    return { stage, lean: readingLean(trend, stage, thirteenFailed) };
}

const REGIMES: readonly Regime[] = ['none', 'rev', 'pump', 'decay'];

describe('scoreTimeframe', () => {
    const sig = (n: 1 | 2, intradayLevel: number | null, swingLevel: number | null, active = true): RegimeSignal => ({
        n,
        side: 'buy',
        active,
        price: null,
        baseLevel: null,
        intradayLevel,
        swingLevel
    });

    it('returns null without a state, a structure or a lean', () => {
        const st = counting('up');
        expect(scoreTimeframe('5m', null, signalsOf(st, 'none'), T, structureOf('up', 'established'))).toBeNull();
        expect(scoreTimeframe('5m', st, signalsOf(st, 'none'), T, null)).toBeNull();
        expect(scoreTimeframe('5m', state({ s9: 'none' }), [], T, structureOf('up', 'forming'))).toBeNull();
        const failed = carried13('up');
        expect(scoreTimeframe('15m', failed, signalsOf(failed, 'none'), T, structureOf('up', 'exhausted', true))).toBeNull();
    });

    test.each([
        ['down', 'sell'],
        ['up', 'buy']
    ] as const)('scores a %s move counting toward 13 on the %s side at level 2, whatever the regime', (trend, side) => {
        const st = counting(trend);
        for (const regime of REGIMES) {
            const signals = signalsOf(st, regime);
            for (const interval of ['5m', '4h'] as const) {
                expect(scoreTimeframe(interval, st, signals, T, structureOf(trend, 'established'))).toEqual({
                    side,
                    level: 2,
                    ageBars: 0,
                    fresh: 1,
                    e: 2
                });
            }
        }
        // AlphaBTC's own signal stays on the reversal side and moves with the regime; the score ignores it.
        expect(signalsOf(st, 'rev')[0]?.side).not.toBe(side);
        expect(new Set(REGIMES.map((regime) => signalsOf(st, regime)[0]?.intradayLevel))).toEqual(new Set([1, 2, 3]));
        expect(STRENGTH_V1.nineLevel).toBe(2);
    });

    test.each([
        ['none', 3],
        ['pump', 4],
        ['rev', 2]
    ] as const)('scores an exhausted down move on the buy side at its 13 level under %s: %d', (regime, level) => {
        const st = carried13('down');
        expect(scoreTimeframe('15m', st, signalsOf(st, regime), T, structureOf('down', 'exhausted'))).toEqual({
            side: 'buy',
            level,
            ageBars: 0,
            fresh: 1,
            e: level
        });
    });

    // Condition (b): the structure is exhausted while the state still reads the 9 at countdown 0, so only
    // signal 1 is active; it sits on the reversal side already.
    test.each([
        ['up', 'sell'],
        ['down', 'buy']
    ] as const)('scores a condition (b) exhausted %s move on the reversal side, %s', (trend, side) => {
        const st = state({ s9: trend, countdown: 0, setup9At: null, qualified13At: T - 2 * INTERVAL_MS['15m'] });
        expect(scoreTimeframe('15m', st, signalsOf(st, 'none'), T, structureOf(trend, 'exhausted'))).toEqual({
            side,
            level: 2,
            ageBars: 2,
            fresh: 1 - 2 / 24,
            e: 2 * (1 - 2 / 24)
        });
    });

    it('takes the max active level of an exhausted move, swing level on 4h', () => {
        const st = carried13('down');
        const exhausted = structureOf('down', 'exhausted');
        expect(scoreTimeframe('5m', st, [sig(1, 2, 1), sig(2, 4, 1)], T, exhausted)?.level).toBe(4);
        expect(scoreTimeframe('4h', st, [sig(1, 5, 3), sig(2, 1, 1, false)], T, exhausted)?.level).toBe(3);
    });

    it('throws for an exhausted move without an active signal level', () => {
        expect(() => scoreTimeframe('5m', carried13('down'), [sig(1, 2, 2, false)], T, structureOf('down', 'exhausted'))).toThrow(
            'Exhausted 5m timeframe has no active signal level'
        );
    });

    it('ages an exhausted move from its 13, else its 9, and a counting 9 from its 9', () => {
        const nine = T - 20 * INTERVAL_MS['15m'];
        const thirteen = T - 3 * INTERVAL_MS['15m'];
        const st = carried13('up', { setup9At: nine, qualified13At: thirteen });
        expect(scoreTimeframe('15m', st, signalsOf(st, 'none'), T, structureOf('up', 'exhausted'))?.ageBars).toBe(3);
        const no13 = state({ s9: 'up', setup9At: nine, qualified13At: null });
        expect(scoreTimeframe('15m', no13, signalsOf(no13, 'none'), T, structureOf('up', 'exhausted'))?.ageBars).toBe(20);
        const nineOnly = state({ s9: 'up', countdown: 6, setup9At: T - 5 * INTERVAL_MS['15m'], qualified13At: thirteen });
        expect(scoreTimeframe('15m', nineOnly, [], T, structureOf('up', 'established'))?.ageBars).toBe(5);
    });

    it('decays freshness down to 0.5', () => {
        const fresh = (bars: number) =>
            scoreTimeframe('5m', state({ setup9At: T - bars * INTERVAL_MS['5m'] }), [], T, structureOf('up', 'established'))?.fresh;
        expect([0, 6, 12, 30].map(fresh)).toEqual([1, 0.75, 0.5, 0.5]);
    });

    it('treats a missing time as old', () => {
        const r = scoreTimeframe('5m', state({ setup9At: null }), [], T, structureOf('up', 'established'));
        expect(r?.ageBars).toBeNull();
        expect(r?.fresh).toBe(0.5);
    });

    it('does not dampen a 9 or a 13 past its risk level', () => {
        const nine = (beyondRisk9: boolean | null) => {
            const st = state({ s9: 'down', countdown: 3, beyondRisk9 });
            return scoreTimeframe('5m', st, signalsOf(st, 'none'), T, structureOf('down', 'established'))?.e;
        };
        expect([true, false, null].map(nine)).toEqual([2, 2, 2]);
        const thirteen = (beyondRisk9: boolean | null) => {
            const st = carried13('down', { beyondRisk9 });
            return scoreTimeframe('15m', st, signalsOf(st, 'pump'), T, structureOf('down', 'exhausted'))?.e;
        };
        expect([true, false, null].map(thirteen)).toEqual([4, 4, 4]);
    });

    it('scores on the side of the lean, or not at all without one, for every stage, trend and regime', () => {
        const sideOf: Record<Lean, DemarkSide> = { bullish: 'buy', bearish: 'sell' };
        const cases: [TimeframeRegimeState, DemarkTrend, TimeframeStructure['stage'], boolean][] = [];
        for (const trend of ['up', 'down'] as const) {
            cases.push([state({ s9: 'none' }), trend, 'forming', false]);
            cases.push([counting(trend), trend, 'established', false]);
            cases.push([state({ s9: trend, countdown: 0 }), trend, 'established', false]);
            for (const failed of [false, true]) {
                cases.push([carried13(trend), trend, 'exhausted', failed]);
                cases.push([state({ s9: trend, countdown: 0, qualified13At: T }), trend, 'exhausted', failed]);
            }
        }
        for (const [st, trend, stage, failed] of cases) {
            const structure = structureOf(trend, stage, failed);
            for (const regime of REGIMES) {
                for (const interval of ['5m', '15m', '1h', '4h'] as const) {
                    const score = scoreTimeframe(interval, st, signalsOf(st, regime), T, structure);
                    expect(score === null ? null : score.side).toBe(structure.lean === null ? null : sideOf[structure.lean]);
                }
            }
        }
    });
});

describe('typical values (spec 5.6)', () => {
    type Scores = Record<ScoredInterval, TimeframeScore | null>;
    const none: Scores = { '5m': null, '15m': null, '1h': null, '4h': null };
    /** A fresh 13 that exhausted a down move, under the given intraday regime. */
    const thirteen = (interval: ScoredInterval, regime: Regime) => {
        const st = carried13('down', { qualified13At: T });
        return scoreTimeframe(interval, st, signalsOf(st, regime), T, structureOf('down', 'exhausted'));
    };
    /** A 9 counting toward 13 at `countdown`, `bars` old. */
    const nine = (interval: ScoredInterval, trend: DemarkTrend, regime: Regime, bars = 0, countdown = 0) => {
        const st = state({ s9: trend, countdown, setup9At: T - bars * INTERVAL_MS[interval] });
        return scoreTimeframe(interval, st, signalsOf(st, regime), T, structureOf(trend, 'established'));
    };
    /** The lead assembleSnapshot passes: facts.mainLine's direction and lead timeframe, with that timeframe's score. */
    const lead = (direction: Lean, interval: ScoredInterval, score: TimeframeScore | null) => {
        if (score === null) throw new Error(`No ${interval} score`);
        return { direction, interval, score };
    };

    it('a single fresh 9, in any regime: 24, weak', () => {
        // No main line (no 13, Countdown 0), so the v1.2 path scores it as the anchor.
        for (const regime of REGIMES) {
            expect(cardStrength({ ...none, '15m': nine('15m', 'down', regime) }, null)).toMatchObject({
                direction: 'bearish',
                strength: 24,
                strengthLabel: 'weak'
            });
            expect(cardStrength({ ...none, '1h': nine('1h', 'up', regime) }, null)).toMatchObject({ direction: 'bullish', strength: 24 });
        }
    });

    it('a single fresh 13, regime neutral: 36, weak', () => {
        const scores = { ...none, '15m': thirteen('15m', 'none') };
        expect(cardStrength(scores, lead('bullish', '15m', scores['15m']))).toMatchObject({ strength: 36, strengthLabel: 'weak' });
    });

    it('a single fresh 13, regime favouring it: 48, moderate', () => {
        const scores = { ...none, '15m': thirteen('15m', 'pump') };
        expect(cardStrength(scores, lead('bullish', '15m', scores['15m']))).toMatchObject({ strength: 48, strengthLabel: 'moderate' });
    });

    it('fresh 13s on 5m and 15m, regime favouring them: 64, moderate', () => {
        // The main line is the bigger 13.
        const scores = { ...none, '5m': thirteen('5m', 'pump'), '15m': thirteen('15m', 'pump') };
        expect(cardStrength(scores, lead('bullish', '15m', scores['15m']))).toMatchObject({ strength: 64, strengthLabel: 'moderate' });
    });

    it('plus a fresh 1h 13, three in a row: 80, strong', () => {
        const scores = { ...none, '5m': thirteen('5m', 'pump'), '15m': thirteen('15m', 'pump'), '1h': thirteen('1h', 'pump') };
        expect(cardStrength(scores, lead('bullish', '1h', scores['1h']))).toMatchObject({ strength: 80, strengthLabel: 'strong' });
    });

    it('a 15m 13 with the regime inside a fresh 4h down 9: a bounce led by 4h, bearish 24, weak', () => {
        // The 15m buy 13 exhausts a down move the 4h is still counting (bounce-in-trend), so 4h leads.
        const scores = { ...none, '15m': thirteen('15m', 'pump'), '4h': nine('4h', 'down', 'rev') };
        expect(cardStrength(scores, lead('bearish', '4h', scores['4h']))).toEqual({
            direction: 'bearish',
            strength: 24,
            strengthLabel: 'weak',
            anchorInterval: '4h',
            confluentIntervals: ['4h'],
            conflictingIntervals: ['15m']
        });
    });

    it('a bounce of a 5m 13 led by a 4h down 9 (fresh 0.5), with 1h counting down too (fresh 0.5): 16, weak', () => {
        const scores = { ...none, '5m': thirteen('5m', 'none'), '1h': nine('1h', 'down', 'none', 12), '4h': nine('4h', 'down', 'none', 12) };
        expect(cardStrength(scores, lead('bearish', '4h', scores['4h']))).toEqual({
            direction: 'bearish',
            strength: 16,
            strengthLabel: 'weak',
            anchorInterval: '4h',
            confluentIntervals: ['1h', '4h'],
            conflictingIntervals: ['5m']
        });
    });
});

describe('strengthLabel', () => {
    it('has the right boundaries', () => {
        expect([44, 45, 74, 75].map(strengthLabel)).toEqual(['weak', 'moderate', 'moderate', 'strong']);
    });
});
