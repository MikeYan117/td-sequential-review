import { structureLean } from '../../../src/services/sync/signal-insight/lean';
import { templateSections, watchItemsOf } from '../../../src/services/sync/signal-insight/insight-template';
import {
    InsightFacts,
    InsightInterval,
    MainLineFact,
    ReviewItem,
    TimeframeStructure,
} from '../../../src/services/manager/types/insight-types';
import { mainLineStructure } from '../../../src/services/manager/demark/insight-facts';
import { readingLean } from '../demark/helpers';

function structure(
    interval: InsightInterval,
    trend: 'up' | 'down',
    stage: TimeframeStructure['stage'],
    setupStep: number,
    countdown: number,
    formingOpposite: TimeframeStructure['formingOpposite'] = null,
    thirteenFailed = false,
): TimeframeStructure {
    const lean = readingLean(trend, stage, thirteenFailed);
    return { interval, close: '100', trend, stage, setupStep, countdown, formingOpposite, timeline: [], thirteenFailed, lean };
}

/** The main line the facts carry for these structures: picked by rule, pointing the way it leans. */
function mainLineFactOf(structures: TimeframeStructure[]): MainLineFact | null {
    const s = mainLineStructure(structures, []);
    return s === null || s.lean === null ? null : { interval: s.interval, direction: s.lean, leadInterval: s.interval };
}

function factsOf(structures: TimeframeStructure[], reviewPick: ReviewItem | null = null): InsightFacts {
    return { structures, live13: [], review: [], reviewPick, focus: [], mainLine: mainLineFactOf(structures) };
}

function pick(over: Partial<ReviewItem> = {}): ReviewItem {
    return {
        interval: '1h',
        kind: 13,
        side: 'buy',
        barsAgo: 17,
        price: '80664.7',
        windowBars: 12,
        favorablePct: '2.31',
        adversePct: '0.26',
        afterPct: '1.09',
        sincePct: '1.09',
        verdict: 'confirmed',
        settledBarsAgo: 5,
        ...over,
    };
}

const btc = [
    structure('5m', 'down', 'established', 9, 7),
    structure('15m', 'down', 'established', 9, 3),
    structure('1h', 'up', 'exhausted', 9, 13),
    structure('4h', 'down', 'established', 9, 6),
    structure('1d', 'up', 'established', 9, 12),
];

describe('structureLean', () => {
    it("reads the facts' lean as it is", () => {
        const s = structure('5m', 'up', 'established', 9, 2);
        expect(structureLean(s)).toBe('bullish');
        expect(structureLean({ ...s, lean: 'bearish' })).toBe('bearish');
        expect(structureLean({ ...s, lean: null })).toBeNull();
    });
});

describe('templateSections timeframes', () => {
    it('groups the timeframes by trend stage, never by bull or bear', () => {
        const out = templateSections(factsOf(btc));
        expect(out.zhCN.timeframes).toBe(
            '反转确立：1h 上涨。衰减中、反转倒计时：5m 下跌还差 6 步；15m 下跌还差 10 步；4h 下跌还差 7 步；1d 上涨只差 1 步。',
        );
        expect(out.en.timeframes).toBe(
            'Reversal confirmed: 1h up move. Fading, counting down to a reversal: 5m down move, 6 steps to go; 15m down move, 10 steps to go; 4h down move, 7 steps to go; 1d up move, only 1 step to go.',
        );
    });

    it('writes BTC at 04:30 on 2026-10-16: a reversal with a new setup, two near 13, a new trend and a failed 13', () => {
        const out = templateSections(
            factsOf([
                structure('5m', 'down', 'exhausted', 9, 13, null, true),
                structure('15m', 'up', 'exhausted', 9, 13, { trend: 'down', step: 5 }),
                structure('1h', 'down', 'forming', 4, 0),
                structure('4h', 'down', 'established', 9, 12),
                structure('1d', 'up', 'established', 9, 12),
            ]),
        );
        expect(out.zhCN.timeframes).toBe(
            '反转确立：15m 上涨，新的下跌还差 4 步确立。衰减中、反转倒计时：4h 下跌只差 1 步；1d 上涨只差 1 步。新趋势：1h 下跌还差 5 步确立。已失效：5m 下跌的反转信号失效（收盘越过了风险位）。',
        );
        expect(out.en.timeframes).toBe(
            "Reversal confirmed: 15m up move, new down move, 4 steps from being established. Fading, counting down to a reversal: 4h down move, only 1 step to go; 1d up move, only 1 step to go. New trend: 1h down move, 5 steps from being established. Failed: 5m down move's reversal signal failed (a close went past its risk level).",
        );
        expect(out.ko.timeframes).toBe(
            '반전 확정: 15m 상승, 새로운 하락, 확립까지 4단계. 약화 중, 반전까지 남은 단계: 4h 하락, 단 1단계 남음; 1d 상승, 단 1단계 남음. 새 추세: 1h 하락, 확립까지 5단계. 무효: 5m 하락 반전 신호 무효(종가가 위험선을 넘음).',
        );
        expect(out.ja.timeframes).toBe(
            '反転確定：15m 上昇、新たな下落、確立まであと 4 ステップ。減速中・反転までの残り：4h 下落、わずか 1 ステップ／1d 上昇、わずか 1 ステップ。新トレンド：1h 下落、確立まであと 5 ステップ。失効：5m 下落の反転シグナルは失効（終値がリスクラインを越えた）。',
        );
    });

    it('writes not-started countdowns, forming setups, failed 13s and new setups after a reversal', () => {
        const facts = factsOf([
            structure('5m', 'down', 'forming', 4, 0),
            structure('15m', 'down', 'exhausted', 9, 13, null, true),
            structure('1h', 'up', 'exhausted', 9, 13, { trend: 'down', step: 3 }),
            structure('4h', 'up', 'established', 9, 0),
            structure('1d', 'up', 'forming', 0, 0),
        ]);
        const out = templateSections(facts);
        expect(out.zhCN.timeframes).toBe(
            '反转确立：1h 上涨，新的下跌还差 6 步确立。衰减中、反转倒计时：4h 上涨还差 13 步。新趋势：5m 下跌还差 5 步确立。已失效：15m 下跌的反转信号失效（收盘越过了风险位）。',
        );
        expect(out.en.timeframes).toBe(
            "Reversal confirmed: 1h up move, new down move, 6 steps from being established. Fading, counting down to a reversal: 4h up move, 13 steps to go. New trend: 5m down move, 5 steps from being established. Failed: 15m down move's reversal signal failed (a close went past its risk level).",
        );
    });

    it('does not append a new setup to an established 9, and adds no direction summary', () => {
        const facts = factsOf([structure('1h', 'up', 'established', 9, 4, { trend: 'down', step: 6 })]);
        expect(templateSections(facts).zhCN.timeframes).toBe('衰减中、反转倒计时：1h 上涨还差 9 步。');
        expect(templateSections(facts).en.timeframes).toBe('Fading, counting down to a reversal: 1h up move, 9 steps to go.');
    });

    it('appends the new setup to a failed 13 too, and handles an empty card', () => {
        const failed = factsOf([structure('15m', 'down', 'exhausted', 9, 13, { trend: 'up', step: 2 }, true)]);
        expect(templateSections(failed).zhCN.timeframes).toBe('已失效：15m 下跌的反转信号失效（收盘越过了风险位），新的上涨还差 7 步确立。');
        expect(templateSections(failed).en.timeframes).toBe(
            "Failed: 15m down move's reversal signal failed (a close went past its risk level), new up move, 7 steps from being established.",
        );
        const empty = templateSections(factsOf([structure('5m', 'up', 'forming', 0, 0)]));
        expect(empty.zhCN.timeframes).toBe('各周期暂无明显趋势。');
        expect(empty.en.timeframes).toBe('No timeframe shows a clear trend yet.');
    });
});

describe('templateSections timeframes summary', () => {
    it('timeframes ends with the near-13 resonance', () => {
        const facts = factsOf([
            structure('15m', 'up', 'established', 9, 12),
            structure('4h', 'down', 'established', 9, 10),
            structure('1d', 'up', 'established', 9, 12),
        ]);
        const out = templateSections(facts);
        expect(out.zhCN.timeframes.endsWith('。1d、15m 上涨离反转都只差一步，可能同步反转。')).toBe(true);
        expect(out.en.timeframes.endsWith(' The 1d and 15m up moves are all one step from a reversal and may reverse together.')).toBe(true);
        const mixed = factsOf([structure('15m', 'up', 'established', 9, 11), structure('1d', 'up', 'established', 9, 12)]);
        const m = templateSections(mixed);
        expect(m.zhCN.timeframes.endsWith('。1d、15m 上涨离反转都只差一两步，可能同步反转。')).toBe(true);
        expect(m.en.timeframes.endsWith(' The 1d and 15m up moves are all one or two steps from a reversal and may reverse together.')).toBe(true);
    });

    it('writes 5m and 1d both one step from 13 as a possible reversal together', () => {
        const out = templateSections(factsOf([structure('5m', 'up', 'established', 9, 12), structure('1d', 'up', 'established', 9, 12)]));
        expect(out.zhCN.timeframes.endsWith('1d、5m 上涨离反转都只差一步，可能同步反转。')).toBe(true);
        expect(out.en.timeframes.endsWith('The 1d and 5m up moves are all one step from a reversal and may reverse together.')).toBe(true);
    });

    it('timeframes adds no summary without a near-13 resonance', () => {
        const agree = factsOf([structure('5m', 'down', 'established', 9, 3), structure('1h', 'down', 'established', 9, 5)]);
        expect(templateSections(agree).zhCN.timeframes).toBe('衰减中、反转倒计时：5m 下跌还差 10 步；1h 下跌还差 8 步。');
        expect(templateSections(agree).en.timeframes).toBe('Fading, counting down to a reversal: 5m down move, 10 steps to go; 1h down move, 8 steps to go.');
        const facts = factsOf([structure('5m', 'up', 'forming', 6, 0), structure('15m', 'down', 'exhausted', 9, 13, null, true)]);
        const out = templateSections(facts);
        expect(out.zhCN.timeframes).toBe('新趋势：5m 上涨还差 3 步确立。已失效：15m 下跌的反转信号失效（收盘越过了风险位）。');
        expect(out.en.timeframes.endsWith('went past its risk level).')).toBe(true);
    });
});

describe('templateSections review', () => {
    it('review says the move since the signal', () => {
        const p = pick({ interval: '15m', side: 'sell', barsAgo: 11, price: '83826', sincePct: '-0.30', verdict: 'confirmed' });
        const out = templateSections(factsOf([], p));
        expect(out.zhCN.review).toBe('15m 上涨的反转信号，11 根K线前，价格 83826，至今 -0.30%，按预期回落。');
        expect(out.en.review).toBe("The 15m up move's reversal signal, 11 bars ago at 83826, -0.30% since: pulled back as expected.");
        const pending = templateSections(factsOf([], pick({ barsAgo: 0, windowBars: 0, sincePct: '0.00', verdict: 'pending' })));
        expect(pending.zhCN.review).toBe('1h 下跌的反转信号，0 根K线前，价格 80664.7，仍在观察期。');
        expect(pending.en.review).toBe("The 1h down move's reversal signal, 0 bars ago at 80664.7: still in its window.");
    });

    it('review says no clear move under 0.25%', () => {
        for (const kind of [13, 9] as const) {
            const out = templateSections(factsOf([], pick({ kind, sincePct: '0.10', verdict: 'unclear' })));
            expect(out.zhCN.review.endsWith('至今 +0.10%，没走出明确结果。')).toBe(true);
            expect(out.en.review.endsWith('+0.10% since: no clear move either way.')).toBe(true);
        }
        const zero = templateSections(factsOf([], pick({ sincePct: '-0.00', verdict: 'unclear' })));
        expect(zero.zhCN.review).toContain('至今 0.00%，');
    });

    it('writes a confirmed buy 13 with a positive move', () => {
        const out = templateSections(factsOf([], pick()));
        expect(out.zhCN.review).toBe('1h 下跌的反转信号，17 根K线前，价格 80664.7，至今 +1.09%，按预期反弹。');
        expect(out.en.review).toBe("The 1h down move's reversal signal, 17 bars ago at 80664.7, +1.09% since: rebounded as expected.");
        expect(out.ko.review).toBe('1h 하락 반전 신호, 17봉 전, 가격 80664.7, 이후 +1.09%, 예상대로 반등.');
        expect(out.ja.review).toBe('1h 下落の反転シグナル、17 本前、価格 80664.7、以降 +1.09%、想定どおり反発。');
    });

    it('writes a confirmed sell 9 as the up move continuing', () => {
        const out = templateSections(factsOf([], pick({ side: 'sell', kind: 9, sincePct: '0.59', verdict: 'confirmed' })));
        expect(out.zhCN.review).toBe('1h 上涨的确立信号，17 根K线前，价格 80664.7，至今 +0.59%，按预期继续上涨。');
        expect(out.en.review).toBe("The 1h up move's trend-established signal, 17 bars ago at 80664.7, +0.59% since: kept rising as expected.");
    });

    it('writes a confirmed buy 9 as the down move continuing', () => {
        const out = templateSections(factsOf([], pick({ side: 'buy', kind: 9, sincePct: '-0.59', verdict: 'confirmed' })));
        expect(out.zhCN.review).toBe('1h 下跌的确立信号，17 根K线前，价格 80664.7，至今 -0.59%，按预期继续下跌。');
        expect(out.en.review).toBe("The 1h down move's trend-established signal, 17 bars ago at 80664.7, -0.59% since: kept falling as expected.");
    });

    it('writes an unconfirmed 9 for both sides', () => {
        const zh = (side: 'buy' | 'sell') =>
            templateSections(factsOf([], pick({ side, kind: 9, verdict: 'unconfirmed' }))).zhCN.review.split('，').pop();
        const en = (side: 'buy' | 'sell') =>
            templateSections(factsOf([], pick({ side, kind: 9, verdict: 'unconfirmed' }))).en.review.split(': ').pop();
        expect([zh('buy'), zh('sell')]).toEqual(['未见继续下跌。', '未见继续上涨。']);
        expect([en('buy'), en('sell')]).toEqual(['did not keep falling.', 'did not keep rising.']);
    });

    it('covers the four verdicts for both sides', () => {
        const zh = (side: 'buy' | 'sell', verdict: ReviewItem['verdict']) =>
            templateSections(factsOf([], pick({ side, verdict }))).zhCN.review.split('，').pop();
        const en = (side: 'buy' | 'sell', verdict: ReviewItem['verdict']) =>
            templateSections(factsOf([], pick({ side, verdict }))).en.review.split(': ').pop();
        expect([zh('buy', 'unconfirmed'), zh('sell', 'unconfirmed')]).toEqual(['未见反弹。', '未见回落。']);
        expect([en('buy', 'unconfirmed'), en('sell', 'unconfirmed')]).toEqual(['no rebound.', 'no pullback.']);
        expect([zh('buy', 'failed'), zh('sell', 'failed')]).toEqual(['风险位被突破。', '风险位被突破。']);
        expect([en('buy', 'failed'), en('sell', 'failed')]).toEqual(['risk level broken.', 'risk level broken.']);
        expect([zh('buy', 'pending'), zh('sell', 'pending')]).toEqual(['仍在观察期。', '仍在观察期。']);
        expect([en('buy', 'pending'), en('sell', 'pending')]).toEqual(['still in its window.', 'still in its window.']);
    });

    it('drops the move when pending, keeps 0.00 unsigned and uses the singular bar', () => {
        const none = templateSections(factsOf([], pick({ windowBars: 0, verdict: 'pending' })));
        expect(none.zhCN.review).toBe('1h 下跌的反转信号，17 根K线前，价格 80664.7，仍在观察期。');
        expect(none.en.review).toBe("The 1h down move's reversal signal, 17 bars ago at 80664.7: still in its window.");
        const zero = templateSections(factsOf([], pick({ sincePct: '0.00', barsAgo: 1, windowBars: 1, verdict: 'unconfirmed' })));
        expect(zero.zhCN.review).toBe('1h 下跌的反转信号，1 根K线前，价格 80664.7，至今 0.00%，未见反弹。');
        expect(zero.en.review).toBe("The 1h down move's reversal signal, 1 bar ago at 80664.7, 0.00% since: no rebound.");
    });

    it('says so when there is nothing to review', () => {
        const out = templateSections(factsOf([]));
        expect(out.zhCN.review).toBe('近期没有可复盘的信号。');
        expect(out.en.review).toBe('No recent signal to review.');
    });
});

describe('templateSections watch', () => {
    it('writes risk, countdown and setup items', () => {
        const facts = factsOf([structure('1d', 'up', 'established', 9, 12), structure('1h', 'down', 'forming', 6, 0)]);
        facts.live13 = [
            {
                interval: '1h',
                side: 'sell',
                barsAgo: 3,
                price: '84000',
                riskLevel: '84602.7',
                intact: true,
                roomPct: '0.50',
                sincePct: '-0.10',
                oppositeSetup: 0,
            },
        ];
        // The main line (the 1d at Countdown 12) comes first; only two items are kept.
        const two = templateSections(facts);
        expect(two.zhCN.watch).toBe('关注 1d 上涨离反转只差 1 步，看能否走完；84602.7：1h 收盘涨过这个价，反转信号就失效。');
        expect(two.en.watch).toBe('Watch whether the 1d up move, only 1 step from a reversal, gets there; 84602.7: a 1h close above it cancels the reversal signal.');
        expect(two.ko.watch).toBe('주목 1d 상승 반전까지 단 1단계, 도달 여부; 84602.7: 1h 종가가 이 가격을 상회하면 반전 신호 무효.');
        expect(two.ja.watch).toBe('注目 1d 上昇は反転までわずか 1 ステップ、到達するか／84602.7：1h の終値がこの価格を上回ると反転シグナルは失効。');
        facts.live13 = [];
        const setup = templateSections(facts);
        expect(setup.zhCN.watch).toBe('关注 1d 上涨离反转只差 1 步，看能否走完；1h 下跌还差 3 步确立，看能否走完。');
        expect(setup.en.watch).toBe('Watch whether the 1d up move, only 1 step from a reversal, gets there; whether the 1h down move, 3 steps from being established, gets there.');
    });

    it('says so when nothing is near', () => {
        const out = templateSections(factsOf([structure('5m', 'up', 'forming', 4, 0)]));
        expect(out.zhCN.watch).toBe('暂无接近确立或反转的周期。');
        expect(out.en.watch).toBe('No timeframe is close to being established or reversing.');
    });
});

function tmplInput(): { facts: InsightFacts } {
    return {
        facts: {
            structures: [],
            live13: [
                {
                    interval: '5m',
                    side: 'sell',
                    barsAgo: 3,
                    price: '82800',
                    riskLevel: '82831.5',
                    intact: true,
                    roomPct: '0.23',
                    sincePct: '-0.01',
                    oppositeSetup: 2,
                },
            ],
            review: [],
            reviewPick: null,
            focus: [],
            mainLine: null,
        },
    };
}

describe('watchItemsOf', () => {
    it('lists the largest intact risk level first, then the countdown nearest 13', () => {
        const input = tmplInput();
        input.facts.live13 = [
            { ...input.facts.live13[0]!, interval: '1h', riskLevel: '81000', intact: false },
            input.facts.live13[0]!,
        ];
        input.facts.structures = [
            structure('15m', 'up', 'established', 9, 10),
            structure('1h', 'down', 'established', 9, 10),
            structure('4h', 'down', 'exhausted', 9, 13),
            structure('5m', 'up', 'forming', 8, 0),
        ];
        expect(watchItemsOf(input.facts)).toEqual([
            { kind: 'risk', interval: '5m', side: 'sell', riskLevel: '82831.5', roomPct: '0.23' },
            { kind: 'countdown', interval: '1h', trend: 'down', countdown: 10 },
        ]);
    });

    it('adds the setup nearest 9, forming or opposite, when there is no risk level', () => {
        const input = tmplInput();
        input.facts.live13 = [];
        input.facts.structures = [
            structure('5m', 'up', 'forming', 4, 0),
            structure('15m', 'down', 'established', 9, 0, { trend: 'up', step: 6 }),
            structure('1h', 'up', 'forming', 6, 0),
            structure('4h', 'down', 'established', 9, 2),
        ];
        expect(watchItemsOf(input.facts)).toEqual([
            { kind: 'countdown', interval: '4h', trend: 'down', countdown: 2 },
            { kind: 'setup', interval: '1h', trend: 'up', step: 6 },
        ]);
    });

    it('skips setups below 5 and is empty without anything to watch', () => {
        const input = tmplInput();
        input.facts.live13 = [];
        input.facts.structures = [structure('5m', 'up', 'forming', 4, 0), structure('15m', 'down', 'established', 9, 0)];
        expect(watchItemsOf(input.facts)).toEqual([]);
    });
});


describe('watch — a second countdown near 13', () => {
    const facts = (structures: TimeframeStructure[]): InsightFacts => factsOf(structures);

    it('lists both countdowns when the second is at 11 or 12', () => {
        const t = templateSections(
            facts([structure('15m', 'down', 'established', 9, 12), structure('1d', 'up', 'established', 9, 12)]),
        );
        expect(t.zhCN.watch).toBe('关注 1d 上涨离反转只差 1 步，看能否走完；15m 下跌离反转只差 1 步，看能否走完。');
        expect(t.en.watch).toBe(
            'Watch whether the 1d up move, only 1 step from a reversal, gets there; whether the 15m down move, only 1 step from a reversal, gets there.',
        );
    });

    it('keeps the setup slot when the second countdown is still far from 13', () => {
        const t = templateSections(
            facts([
                structure('15m', 'down', 'established', 9, 5, { trend: 'up', step: 6 }),
                structure('1d', 'up', 'established', 9, 12),
            ]),
        );
        expect(t.zhCN.watch).toBe('关注 1d 上涨离反转只差 1 步，看能否走完；15m 上涨还差 3 步确立，看能否走完。');
    });
});

describe('watch puts the main line first', () => {
    const live = (interval: InsightInterval, side: 'buy' | 'sell') => ({
        interval,
        side,
        barsAgo: 3,
        price: '84000',
        riskLevel: '84602.7',
        intact: true,
        roomPct: '0.50',
        sincePct: '-0.10',
        oppositeSetup: 0,
    });

    it('writes the main 13 risk item first, then the 1d countdown', () => {
        const facts = factsOf([structure('15m', 'up', 'exhausted', 9, 13), structure('1d', 'up', 'established', 9, 12)]);
        facts.live13 = [live('5m', 'sell'), live('15m', 'sell')];
        expect(facts.mainLine?.interval).toBe('15m');
        expect(watchItemsOf(facts)).toEqual([
            { kind: 'risk', interval: '15m', side: 'sell', riskLevel: '84602.7', roomPct: '0.50' },
            { kind: 'countdown', interval: '1d', trend: 'up', countdown: 12 },
        ]);
    });

    it('writes the main 9 countdown first and drops a second item of the same interval and kind', () => {
        const facts = factsOf([
            structure('1h', 'down', 'established', 9, 5),
            structure('4h', 'down', 'established', 9, 11),
            structure('1d', 'up', 'established', 9, 12),
        ]);
        facts.live13 = [live('1h', 'buy')];
        expect(facts.mainLine?.interval).toBe('1d');
        expect(watchItemsOf(facts)).toEqual([
            { kind: 'countdown', interval: '1d', trend: 'up', countdown: 12 },
            { kind: 'risk', interval: '1h', side: 'buy', riskLevel: '84602.7', roomPct: '0.50' },
        ]);
        facts.live13 = [];
        expect(watchItemsOf(facts)).toEqual([
            { kind: 'countdown', interval: '1d', trend: 'up', countdown: 12 },
            { kind: 'countdown', interval: '4h', trend: 'down', countdown: 11 },
        ]);
    });

    it('gives no main risk item when the main interval 13 is on the wrong side', () => {
        const facts = factsOf([structure('15m', 'up', 'exhausted', 9, 13)]);
        facts.live13 = [live('15m', 'buy'), live('1h', 'sell')];
        expect(facts.mainLine?.interval).toBe('15m');
        expect(watchItemsOf(facts)).toEqual([{ kind: 'risk', interval: '1h', side: 'sell', riskLevel: '84602.7', roomPct: '0.50' }]);
    });

    it('keeps the old order without a main line', () => {
        const facts = factsOf([structure('1d', 'up', 'established', 9, 6), structure('1h', 'down', 'established', 9, 2)]);
        facts.live13 = [live('1h', 'buy')];
        expect(facts.mainLine).toBeNull();
        expect(watchItemsOf(facts).map((i) => i.kind)).toEqual(['risk', 'countdown']);
    });
});
