import {
    allowedNumbers,
    conclusionClauses,
    DIRECTION_WORDS,
    llmPayload,
    LlmInput,
    ruleConclusion,
    toTraditional,
    validateConclusion,
} from '../../../src/services/sync/signal-insight/insight-text';
import {
    CardDirection,
    FocusItem,
    InsightInterval,
    Live13,
    MainLineFact,
    ScoredInterval,
    TimeframeStructure,
} from '../../../src/services/manager/types/insight-types';
import {
    bounceLabel,
    establishedLabel,
    failedLabel,
    formingLabel,
    noCountLabel,
    relayLabel,
    resonanceLabel,
} from '../../../src/services/sync/signal-insight/wording';
import { focusOf, mainLineStructure } from '../../../src/services/manager/demark/insight-facts';
import { readingLean } from '../demark/helpers';

function structure(
    interval: InsightInterval,
    trend: 'up' | 'down',
    stage: TimeframeStructure['stage'],
    countdown: number,
    thirteenFailed = false,
): TimeframeStructure {
    const setupStep = stage === 'forming' ? 5 : 9;
    const lean = readingLean(trend, stage, thirteenFailed);
    return { interval, close: '100', trend, stage, setupStep, countdown, formingOpposite: null, timeline: [], thirteenFailed, lean };
}

/** A timeframe whose new trend is forming at Setup `step`. */
function forming(interval: InsightInterval, trend: 'up' | 'down', step: number): TimeframeStructure {
    return { ...structure(interval, trend, 'forming', 0), setupStep: step };
}

function live(interval: InsightInterval, side: 'buy' | 'sell', intact = true, sincePct = '-0.01'): Live13 {
    return { interval, side, barsAgo: 3, price: '82800', riskLevel: '82831.5', intact, roomPct: '0.23', sincePct, oppositeSetup: 0 };
}

/** The main line the facts carry for these structures: picked by rule, pointing the way it leans. */
function mainLineFactOf(structures: TimeframeStructure[], focus: FocusItem[]): MainLineFact | null {
    const s = mainLineStructure(structures, focus);
    return s === null || s.lean === null ? null : { interval: s.interval, direction: s.lean, leadInterval: s.interval };
}

function input(
    direction: CardDirection,
    anchorInterval: ScoredInterval | null,
    structures: TimeframeStructure[],
    live13: Live13[] = [],
    focus: FocusItem[] = [],
): LlmInput {
    const mainLine = mainLineFactOf(structures, focus);
    return { symbol: 'BTCUSDC', card: { direction, anchorInterval }, facts: { structures, live13, review: [], reviewPick: null, focus, mainLine } };
}

/** The input with its focus found by rule. */
function factsInput(direction: CardDirection, anchorInterval: ScoredInterval | null, structures: TimeframeStructure[], live13: Live13[] = []): LlmInput {
    return input(direction, anchorInterval, structures, live13, focusOf(structures, live13));
}

/** 1h's 13 is the main line, with the card; 4h one step from 13 relays it. */
function bearishInput(): LlmInput {
    return input(
        'bearish',
        '1h',
        [structure('1h', 'up', 'exhausted', 13), structure('4h', 'up', 'established', 12)],
        [live('1h', 'sell')],
        [{ pattern: 'relay-exhaustion', small: '1h', big: '4h', side: 'sell', bigCountdown: 12 }],
    );
}

const MAIN_ZH = '1h 上涨趋势反转确立，信号仍有效';
const MAIN_EN = 'the 1h uptrend has reversed, still valid';
const RELAY_ZH = '4h 离反转只差 1 步，大小级别接力反转';
const RELAY_EN = 'the 4h is only 1 step from a reversal: a relay of reversals across timeframes';
const ZH_OK = `${MAIN_ZH}；${RELAY_ZH}。`;
// en opens sentences with a capital; labels are matched without regard to case.
const EN_OK = 'The 1h uptrend has reversed, still valid. The 4h is only 1 step from a reversal: a relay of reversals across timeframes.';

/** TS at 22:25 on 2026-10-14: the 5m and 1h down moves exhausted together while 4h is one step from 13. */
function resonanceInput(): LlmInput {
    const structures = [
        structure('5m', 'down', 'exhausted', 13),
        structure('1h', 'down', 'exhausted', 13),
        structure('4h', 'down', 'established', 12),
    ];
    return factsInput('bullish', '1h', structures, [live('5m', 'buy'), live('1h', 'buy')]);
}

const RESONANCE_ZH = '1h 与 5m 下跌趋势同步反转确立，信号都还有效';
const RESONANCE_EN = 'the 1h and 5m downtrends have reversed together, all still valid';
const FOUR_HOUR_ZH = '4h 下跌趋势正在衰减，离反转只差 1 步';
const FOUR_HOUR_EN = 'the 4h downtrend is fading, only 1 step from a reversal';

const out = (en: string, zhCN: string) => ({ en: { conclusion: en }, zhCN: { conclusion: zhCN } });

/** The clauses in zhCN, the way the model is told to join them. */
const zhOf = (i: LlmInput) => `${conclusionClauses(i).map((c) => c.zhCN).join('；')}。`;
/** The clauses in en, each its own sentence. */
const enOf = (i: LlmInput) => conclusionClauses(i).map((c) => `${c.en.charAt(0).toUpperCase()}${c.en.slice(1)}.`).join(' ');

describe('conclusionClauses (R36): a summary of every timeframe from 5m to 4h', () => {
    it('opens with the anchor when there is no main line, then the rest from 5m to 4h', () => {
        // BTCUSDC at 2026-10-26: 5m and 15m count up, 1h has just counted down to 9, 4h forms a new down move.
        const i = input('bullish', '15m', [
            structure('5m', 'up', 'established', 6),
            structure('15m', 'up', 'established', 1),
            structure('1h', 'down', 'established', 0),
            forming('4h', 'down', 4),
        ]);
        expect(i.facts.mainLine).toBeNull();
        expect(conclusionClauses(i)).toEqual([
            {
                en: 'the 5m and 15m uptrends are fading, 7 steps from a reversal on the 5m, 12 steps on the 15m',
                zhCN: '5m 与 15m 上涨趋势正在衰减，离反转 5m 还差 7 步，15m 还差 12 步',
                ko: '5m·15m 상승 추세 약화 중, 반전까지 5m 7단계, 15m 12단계',
                ja: '5m・15m 上昇トレンドは弱まりつつあり、反転まで 5m はあと 7 ステップ、15m はあと 12 ステップ',
            },
            {
                en: 'the 1h downtrend has just been established and starts to fade, 13 steps from a reversal',
                zhCN: '1h 下跌趋势刚确立、开始衰减，离反转还差 13 步',
                ko: '1h 하락 추세 막 확립, 약화 시작, 반전까지 13단계',
                ja: '1h 下落トレンドは確立したばかりで弱まり始め、反転まであと 13 ステップ',
            },
            {
                en: 'a new 4h downtrend is forming, 5 steps from being established',
                zhCN: '4h 新的下跌趋势形成中，还差 5 步确立',
                ko: '4h 새로운 하락 추세 형성 중, 확립까지 5단계',
                ja: '4h 新たな下落トレンドが形成中、確立まであと 5 ステップ',
            },
        ]);
        const zh = '5m 与 15m 上涨趋势正在衰减，离反转 5m 还差 7 步，15m 还差 12 步；1h 下跌趋势刚确立、开始衰减，离反转还差 13 步；4h 新的下跌趋势形成中，还差 5 步确立。';
        expect(zhOf(i)).toBe(zh);
        expect(validateConclusion(out(enOf(i), zh), i)).toEqual({ ok: true, en: enOf(i), zhCN: zh });
    });

    it('puts the main line first, ahead of smaller timeframes', () => {
        const i = factsInput('bullish', '4h', [forming('5m', 'up', 3), structure('15m', 'down', 'established', 4), structure('4h', 'down', 'exhausted', 13)], [live('4h', 'buy')]);
        expect(i.facts.mainLine?.interval).toBe('4h');
        expect(conclusionClauses(i).map((c) => c.zhCN)).toEqual([
            '4h 下跌趋势反转确立，信号仍有效',
            '5m 新的上涨趋势形成中，还差 6 步确立',
            '15m 下跌趋势正在衰减，离反转还差 9 步',
        ]);
    });

    it('takes the timeframes in table order on a neutral card', () => {
        const i = input('neutral', null, [structure('4h', 'down', 'established', 2), structure('1h', 'up', 'established', 3)]);
        expect(conclusionClauses(i).map((c) => c.zhCN)).toEqual([
            '1h 上涨趋势正在衰减，离反转还差 10 步',
            '4h 下跌趋势正在衰减，离反转还差 11 步',
        ]);
    });

    it('merges timeframes in the same stage and trend, never across trends', () => {
        const zh = (structures: TimeframeStructure[]) => conclusionClauses(input('neutral', null, structures)).map((c) => c.zhCN);
        expect(zh([structure('1h', 'down', 'established', 0), structure('4h', 'down', 'established', 12)])).toEqual([
            '1h 与 4h 下跌趋势正在衰减，离反转 1h 还差 13 步，4h 只差 1 步',
        ]);
        expect(zh([structure('5m', 'up', 'established', 2), structure('15m', 'up', 'established', 11), structure('1h', 'up', 'established', 7)])).toEqual([
            '5m、15m、1h 上涨趋势正在衰减，离反转 5m 还差 11 步，15m 只差 2 步，1h 还差 6 步',
        ]);
        expect(zh([forming('5m', 'down', 3), forming('15m', 'up', 6), forming('1h', 'down', 2)])).toEqual([
            '5m 与 1h 新的下跌趋势形成中，5m 还差 6 步确立，1h 还差 7 步确立',
            '15m 新的上涨趋势形成中，还差 3 步确立',
        ]);
        expect(zh([forming('1h', 'down', 0), forming('4h', 'up', 0)])).toEqual(['1h 与 4h 暂无明显趋势']);
        expect(zh([structure('5m', 'up', 'exhausted', 13, true), structure('15m', 'up', 'exhausted', 13, true), structure('1h', 'down', 'exhausted', 13, true)])).toEqual([
            '5m 与 15m 上涨的反转信号已失效',
            '1h 下跌的反转信号已失效',
        ]);
    });

    it('words the merged groups in en', () => {
        const en = (structures: TimeframeStructure[]) => conclusionClauses(input('neutral', null, structures)).map((c) => c.en);
        expect(en([structure('1h', 'down', 'established', 0), structure('4h', 'down', 'established', 12)])).toEqual([
            'the 1h and 4h downtrends are fading, 13 steps from a reversal on the 1h, only 1 step on the 4h',
        ]);
        expect(en([forming('5m', 'down', 3), forming('1h', 'down', 2)])).toEqual([
            'new 5m and 1h downtrends are forming, 6 steps from being established on the 5m, 7 steps on the 1h',
        ]);
        expect(en([forming('4h', 'up', 0)])).toEqual(['the 4h has no clear trend yet']);
        expect(en([forming('1h', 'up', 0), forming('4h', 'up', 0)])).toEqual(['the 1h and 4h have no clear trend yet']);
        expect(en([structure('5m', 'up', 'exhausted', 13, true)])).toEqual(["the 5m up move's reversal signal has failed"]);
        expect(en([structure('5m', 'up', 'exhausted', 13, true), structure('15m', 'up', 'exhausted', 13, true)])).toEqual([
            "the 5m and 15m up moves' reversal signals have failed",
        ]);
    });

    it('says a 13 failed, after the anchor', () => {
        const i = input(
            'bearish',
            '4h',
            [structure('15m', 'down', 'exhausted', 13, true), structure('1h', 'down', 'established', 3), structure('4h', 'down', 'established', 8)],
            [live('5m', 'buy', false), live('15m', 'buy', false)],
        );
        expect(conclusionClauses(i).map((c) => c.zhCN)).toEqual([
            '1h 与 4h 下跌趋势正在衰减，离反转 1h 还差 10 步，4h 还差 5 步',
            '15m 下跌的反转信号已失效',
        ]);
    });

    it('says a panel without any timeframe structure has no valid count', () => {
        expect(conclusionClauses(input('neutral', null, []))).toEqual([
            {
                en: 'no timeframe from 5m to 4h shows a clear trend yet',
                zhCN: '5m 到 4h 暂无明显趋势',
                ko: '5m~4h 모두 아직 뚜렷한 추세 없음',
                ja: '5m〜4h いずれも明確なトレンドなし',
            },
        ]);
    });

    it('never adds the move since a 13, nor still valid to a 9', () => {
        const structures = [structure('15m', 'down', 'exhausted', 13), structure('1h', 'down', 'established', 12)];
        const clauses = conclusionClauses(input('bullish', '15m', structures, [live('15m', 'buy', true, '2.00')])).map((c) => c.zhCN);
        expect(clauses).toEqual(['15m 下跌趋势反转确立，信号仍有效', '1h 下跌趋势正在衰减，离反转只差 1 步']);
        expect(clauses.join()).not.toMatch(/价格|反转进行中/);
    });
});

describe('trend wording', () => {
    const first = (s: TimeframeStructure, live13: Live13[] = []) => conclusionClauses(input('bearish', s.interval as ScoredInterval, [s], live13))[0];

    it('says a 13 reverses its trend and is still valid', () => {
        expect(first(structure('1h', 'up', 'exhausted', 13), [live('1h', 'sell')])).toEqual({
            en: 'the 1h uptrend has reversed, still valid',
            zhCN: '1h 上涨趋势反转确立，信号仍有效',
            ko: '1h 상승 추세 반전 확정, 신호 유효',
            ja: '1h 上昇トレンド反転確定、シグナルは有効',
        });
        expect(first(structure('1h', 'down', 'exhausted', 13), [live('1h', 'buy')])).toEqual({
            en: 'the 1h downtrend has reversed, still valid',
            zhCN: '1h 下跌趋势反转确立，信号仍有效',
            ko: '1h 하락 추세 반전 확정, 신호 유효',
            ja: '1h 下落トレンド反転確定、シグナルは有効',
        });
    });

    it.each([
        ['1h', 'up', 12, 'the 1h uptrend is fading, only 1 step from a reversal', '1h 上涨趋势正在衰减，离反转只差 1 步', '1h 상승 추세 약화 중, 반전까지 단 1단계', '1h 上昇トレンドは弱まりつつあり、反転までわずか 1 ステップ'],
        ['4h', 'down', 12, 'the 4h downtrend is fading, only 1 step from a reversal', '4h 下跌趋势正在衰减，离反转只差 1 步', '4h 하락 추세 약화 중, 반전까지 단 1단계', '4h 下落トレンドは弱まりつつあり、反転までわずか 1 ステップ'],
        ['1h', 'up', 11, 'the 1h uptrend is fading, only 2 steps from a reversal', '1h 上涨趋势正在衰减，离反转只差 2 步', '1h 상승 추세 약화 중, 반전까지 단 2단계', '1h 上昇トレンドは弱まりつつあり、反転までわずか 2 ステップ'],
        ['4h', 'down', 11, 'the 4h downtrend is fading, only 2 steps from a reversal', '4h 下跌趋势正在衰减，离反转只差 2 步', '4h 하락 추세 약화 중, 반전까지 단 2단계', '4h 下落トレンドは弱まりつつあり、反転までわずか 2 ステップ'],
    ] as const)('says a %s %s trend at Countdown %d is one or two steps from 13', (interval, trend, countdown, en, zhCN, ko, ja) => {
        expect(first(structure(interval, trend, 'established', countdown))).toEqual({ en, zhCN, ko, ja });
    });

    it('gives the Countdown below 11, and says a Countdown 0 trend has just been established', () => {
        expect(first(structure('1h', 'down', 'established', 10))).toEqual({
            en: 'the 1h downtrend is fading, 3 steps from a reversal',
            zhCN: '1h 下跌趋势正在衰减，离反转还差 3 步',
            ko: '1h 하락 추세 약화 중, 반전까지 3단계',
            ja: '1h 下落トレンドは弱まりつつあり、反転まであと 3 ステップ',
        });
        expect(first(structure('4h', 'down', 'established', 0))).toEqual({
            en: 'the 4h downtrend has just been established and starts to fade, 13 steps from a reversal',
            zhCN: '4h 下跌趋势刚确立、开始衰减，离反转还差 13 步',
            ko: '4h 하락 추세 막 확립, 약화 시작, 반전까지 13단계',
            ja: '4h 下落トレンドは確立したばかりで弱まり始め、反転まであと 13 ステップ',
        });
    });

    it('names a relay by its bigger timeframe, one or two steps from 13', () => {
        expect(relayLabel('4h', 12)).toMatchObject({ en: RELAY_EN, zhCN: RELAY_ZH });
        expect(relayLabel('4h', 11)).toEqual({
            en: 'the 4h is only 2 steps from a reversal: a relay of reversals across timeframes',
            zhCN: '4h 离反转只差 2 步，大小级别接力反转',
            ko: '4h 반전까지 단 2단계, 상하위 주기 연쇄 반전',
            ja: '4h は反転までわずか 2 ステップ、時間軸をまたいだ連鎖反転',
        });
    });

    it('calls a 13 a rebound inside a bigger downtrend and a pullback inside a bigger uptrend', () => {
        expect(bounceLabel('down')).toEqual({
            en: 'but this is only a rebound inside the bigger downtrend, which has not reversed',
            zhCN: '但这只是大级别下跌趋势里的反弹，大趋势没有反转',
            ko: '다만 이는 상위 하락 추세 속 반등일 뿐, 큰 추세는 반전되지 않음',
            ja: 'ただし上位の下落トレンド内の反発にすぎず、大きなトレンドは反転していない',
        });
        expect(bounceLabel('up')).toEqual({
            en: 'but this is only a pullback inside the bigger uptrend, which has not reversed',
            zhCN: '但这只是大级别上涨趋势里的回调，大趋势没有反转',
            ko: '다만 이는 상위 상승 추세 속 조정일 뿐, 큰 추세는 반전되지 않음',
            ja: 'ただし上位の上昇トレンド内の調整にすぎず、大きなトレンドは反転していない',
        });
    });

    it('names a resonance the biggest timeframe first, two joined with 与 and more with 、', () => {
        expect(resonanceLabel(['15m', '1h'], 'buy')).toEqual({
            en: 'the 1h and 15m downtrends have reversed together, all still valid',
            zhCN: '1h 与 15m 下跌趋势同步反转确立，信号都还有效',
            ko: '1h·15m 하락 추세 동시 반전 확정, 신호 모두 유효',
            ja: '1h・15m 下落トレンドが同時に反転確定、シグナルはいずれも有効',
        });
        expect(resonanceLabel(['5m', '15m', '1h', '4h'], 'sell')).toEqual({
            en: 'the 4h, 1h, 15m and 5m uptrends have reversed together, all still valid',
            zhCN: '4h、1h、15m、5m 上涨趋势同步反转确立，信号都还有效',
            ko: '4h·1h·15m·5m 상승 추세 동시 반전 확정, 신호 모두 유효',
            ja: '4h・1h・15m・5m 上昇トレンドが同時に反転確定、シグナルはいずれも有効',
        });
    });

    it('never says 还差 in any label', () => {
        const labels = [relayLabel('4h', 11), relayLabel('4h', 12), first(structure('4h', 'up', 'established', 11)), first(structure('4h', 'up', 'established', 12))];
        for (const label of labels) expect(label?.zhCN).not.toContain('还差');
    });

    it('carries no direction word in any label', () => {
        const labels = [
            relayLabel('4h', 12),
            bounceLabel('down'),
            bounceLabel('up'),
            resonanceLabel(['15m', '1h'], 'buy'),
            first(structure('1h', 'up', 'exhausted', 13), [live('1h', 'sell', true, '-1.00')]),
            first(structure('4h', 'up', 'established', 12)),
            first(structure('4h', 'down', 'established', 0)),
            establishedLabel([structure('1h', 'down', 'established', 0), structure('4h', 'down', 'established', 12)]),
            failedLabel([structure('5m', 'up', 'exhausted', 13, true)]),
            formingLabel([forming('5m', 'down', 3), forming('1h', 'down', 2)]),
            noCountLabel(['1h', '4h']),
        ];
        for (const label of labels) {
            expect(label?.zhCN).not.toMatch(DIRECTION_WORDS.zhCN);
            expect(label?.en).not.toMatch(DIRECTION_WORDS.en);
        }
    });
});

describe('llmPayload', () => {
    it('sends the clauses, and neither the card direction nor a closing', () => {
        const p = llmPayload(bearishInput());
        expect(p).toEqual({
            symbol: 'BTCUSDC',
            clauses: [
                { en: MAIN_EN, zhCN: MAIN_ZH },
                { en: RELAY_EN, zhCN: RELAY_ZH },
            ],
        });
    });
});

describe('ruleConclusion (ko, ja)', () => {
    it('writes every clause in order, each its own sentence', () => {
        const i = input('bullish', '15m', [
            structure('5m', 'up', 'established', 6),
            structure('15m', 'up', 'established', 1),
            structure('1h', 'down', 'established', 0),
            forming('4h', 'down', 4),
        ]);
        expect(ruleConclusion('ko', i)).toBe(
            '5m·15m 상승 추세 약화 중, 반전까지 5m 7단계, 15m 12단계. 1h 하락 추세 막 확립, 약화 시작, 반전까지 13단계. 4h 새로운 하락 추세 형성 중, 확립까지 5단계.',
        );
        expect(ruleConclusion('ja', i)).toBe(
            '5m・15m 上昇トレンドは弱まりつつあり、反転まで 5m はあと 7 ステップ、15m はあと 12 ステップ。1h 下落トレンドは確立したばかりで弱まり始め、反転まであと 13 ステップ。4h 新たな下落トレンドが形成中、確立まであと 5 ステップ。',
        );
    });

    it('carries the relation after the main line, as the en and zhCN conclusions do', () => {
        const i = bearishInput();
        expect(ruleConclusion('ko', i).split('. ')).toHaveLength(conclusionClauses(i).length);
        expect(ruleConclusion('ja', i)).toBe(conclusionClauses(i).map((c) => `${c.ja}。`).join(''));
    });

    it('uses no step name or indicator word', () => {
        const texts = [ruleConclusion('ko', bearishInput()), ruleConclusion('ja', bearishInput())];
        for (const text of texts) expect(text).not.toMatch(/setup|countdown|risk level|demark|\bTD\b|セットアップ|カウントダウン|셋업|카운트다운/i);
    });
});

describe('relation', () => {
    const zh = (i: LlmInput) => conclusionClauses(i).map((c) => c.zhCN);

    it('writes a relay after the main line, and the relay’s bigger timeframe gets no sentence of its own', () => {
        expect(zh(bearishInput())).toEqual([MAIN_ZH, RELAY_ZH]);
        const two = bearishInput();
        two.facts.structures[1] = structure('4h', 'up', 'established', 11);
        two.facts.focus = [{ pattern: 'relay-exhaustion', small: '1h', big: '4h', side: 'sell', bigCountdown: 11 }];
        expect(zh(two)).toEqual([MAIN_ZH, '4h 离反转只差 2 步，大小级别接力反转']);
        // 15m counts up with 4h: it keeps its own sentence.
        const withFifteen = bearishInput();
        withFifteen.facts.structures.push(structure('15m', 'up', 'established', 3));
        expect(zh(withFifteen)).toEqual([MAIN_ZH, RELAY_ZH, '15m 上涨趋势正在衰减，离反转还差 10 步']);
    });

    it('writes no relay when the main line is its bigger timeframe', () => {
        // The 4h up move one step from 13 is the main line; the relay's small 13 is on 1h.
        const i = input('bullish', '1h', [structure('4h', 'up', 'established', 12), structure('1h', 'up', 'established', 5)], [], [
            { pattern: 'relay-exhaustion', small: '1h', big: '4h', side: 'sell', bigCountdown: 12 },
        ]);
        expect(i.facts.mainLine?.interval).toBe('4h');
        expect(zh(i)).toEqual(['1h 与 4h 上涨趋势正在衰减，离反转 1h 还差 8 步，4h 只差 1 步']);
    });

    it('never writes a counter-move', () => {
        const small = input('bearish', '15m', [structure('15m', 'up', 'exhausted', 13), structure('4h', 'down', 'established', 3)], [live('15m', 'sell')], [
            { pattern: 'counter-move-ending', small: '15m', big: '4h', bigTrend: 'down', bigCountdown: 3 },
        ]);
        expect(zh(small)).toEqual(['15m 上涨趋势反转确立，信号仍有效', '4h 下跌趋势正在衰减，离反转还差 10 步']);
    });

    it('says the main 13 is only a rebound or pullback inside a bigger trend', () => {
        const structures = [structure('5m', 'down', 'exhausted', 13), structure('1h', 'down', 'established', 4), structure('4h', 'down', 'established', 6)];
        const i = factsInput('bullish', '5m', structures, [live('5m', 'buy')]);
        expect(i.facts.focus).toEqual([{ pattern: 'bounce-in-trend', small: '5m', bigs: ['4h', '1h'], bigTrend: 'down' }]);
        expect(zh(i)).toEqual([
            '5m 下跌趋势反转确立，信号仍有效',
            '但这只是大级别下跌趋势里的反弹，大趋势没有反转',
            '1h 与 4h 下跌趋势正在衰减，离反转 1h 还差 9 步，4h 还差 7 步',
        ]);
        const up = input('bullish', null, [structure('15m', 'up', 'exhausted', 13)], [live('15m', 'sell')], [
            { pattern: 'bounce-in-trend', small: '15m', bigs: ['4h'], bigTrend: 'up' },
        ]);
        expect(zh(up)).toEqual(['15m 上涨趋势反转确立，信号仍有效', '但这只是大级别上涨趋势里的回调，大趋势没有反转']);
    });

    it('pins no other timeframe’s rebound on the main line', () => {
        // The 15m 13 is the main line; the 1h 13 is a pullback inside the 4h up move.
        const structures = [structure('15m', 'down', 'exhausted', 13), structure('1h', 'up', 'exhausted', 13), structure('4h', 'up', 'established', 5)];
        const i = factsInput('bullish', '15m', structures, [live('15m', 'buy'), live('1h', 'sell')]);
        expect(i.facts.focus).toContainEqual({ pattern: 'bounce-in-trend', small: '1h', bigs: ['4h'], bigTrend: 'up' });
        expect(zh(i)).toEqual(['15m 下跌趋势反转确立，信号仍有效', '1h 上涨趋势反转确立，信号仍有效', '4h 上涨趋势正在衰减，离反转还差 8 步']);
    });

    it('R35: a short main 13 keeps its rebound, and the long 13 the other way has its own sentence', () => {
        // The 15m sell 13 leads over the 4h buy 13 and is a pullback inside the 1h up move.
        const structures = [structure('15m', 'up', 'exhausted', 13), structure('1h', 'up', 'established', 5), structure('4h', 'down', 'exhausted', 13)];
        const i = factsInput('bearish', '15m', structures, [live('15m', 'sell'), live('4h', 'buy')]);
        expect(i.facts.mainLine?.interval).toBe('15m');
        expect(zh(i)).toEqual([
            '15m 上涨趋势反转确立，信号仍有效',
            bounceLabel('up').zhCN,
            '1h 上涨趋势正在衰减，离反转还差 8 步',
            '4h 下跌趋势反转确立，信号仍有效',
        ]);
        expect(validateConclusion(out(enOf(i), zhOf(i)), i)).toMatchObject({ ok: true });
        // Leaving the 4h 13 out fails validation.
        const short = `15m 上涨趋势反转确立，信号仍有效；${bounceLabel('up').zhCN}；1h 上涨趋势正在衰减，离反转还差 8 步。`;
        expect(validateConclusion(out(enOf(i), short), i)).toEqual({ ok: false, reason: 'zhCN.conclusion misses 4h 下跌趋势反转确立，信号仍有效' });
    });

    it('R35: keeps the rebound when the long 13 a short main line reverses with sits inside a bigger move', () => {
        // 15m and 1h down 13s, 4h still counting down.
        const structures = [structure('5m', 'down', 'established', 8), structure('15m', 'down', 'exhausted', 13), structure('1h', 'down', 'exhausted', 13), structure('4h', 'down', 'established', 3)];
        const i = factsInput('bullish', '15m', structures, [live('15m', 'buy'), live('1h', 'buy')]);
        expect(i.facts.focus).toContainEqual({ pattern: 'bounce-in-trend', small: '1h', bigs: ['4h'], bigTrend: 'down' });
        expect(zh(i)).toEqual([
            '1h 与 15m 下跌趋势同步反转确立，信号都还有效',
            bounceLabel('down').zhCN,
            '5m 与 4h 下跌趋势正在衰减，离反转 5m 还差 5 步，4h 还差 10 步',
        ]);
        // BTC at 09:25 on 2026-10-20: the 15m 13 is a rebound inside 1h only, and 4h has reversed: no rebound is said.
        const btc = [structure('15m', 'down', 'exhausted', 13), structure('1h', 'down', 'established', 7), structure('4h', 'down', 'exhausted', 13)];
        const b = factsInput('bullish', '15m', btc, [live('15m', 'buy'), live('4h', 'buy')]);
        expect(b.facts.focus).toContainEqual({ pattern: 'bounce-in-trend', small: '15m', bigs: ['1h'], bigTrend: 'down' });
        expect(zh(b)).toEqual(['4h 与 15m 下跌趋势同步反转确立，信号都还有效', '1h 下跌趋势正在衰减，离反转还差 6 步']);
    });

    it('says the long 13s that reverse together the other way in one sentence', () => {
        const structures = [structure('5m', 'down', 'exhausted', 13), structure('1h', 'up', 'exhausted', 13), structure('4h', 'up', 'exhausted', 13)];
        const i = factsInput('bullish', '5m', structures, [live('5m', 'buy'), live('1h', 'sell'), live('4h', 'sell')]);
        expect(i.facts.mainLine?.interval).toBe('5m');
        expect(zh(i)).toEqual(['5m 下跌趋势反转确立，信号仍有效', '4h 与 1h 上涨趋势同步反转确立，信号都还有效']);
    });

    it('says a resonance that holds the main 13 once, in place of the main line', () => {
        const structures = [structure('15m', 'down', 'exhausted', 13), structure('1h', 'down', 'exhausted', 13)];
        const i = factsInput('bullish', '15m', structures, [live('15m', 'buy', true, '2.00'), live('1h', 'buy')]);
        expect(zh(i)).toEqual(['1h 与 15m 下跌趋势同步反转确立，信号都还有效']);
    });

    it('takes the resonance over the relay of the main 13, as the reference product did at 22:25 on 2026-10-14', () => {
        const i = resonanceInput();
        expect(i.facts.focus.map((item) => item.pattern)).toEqual(['relay-exhaustion', 'resonance']);
        // R35: the 5m 13 leads; the resonance names the 1h one with it.
        expect(conclusionClauses(i).map(({ en, zhCN }) => ({ en, zhCN }))).toEqual([
            { en: RESONANCE_EN, zhCN: RESONANCE_ZH },
            { en: FOUR_HOUR_EN, zhCN: FOUR_HOUR_ZH },
        ]);
    });

    it('reads a timeframe counting again after its 13 the way the table shows it', () => {
        // The 1h and 15m down moves count again after their 13s, which still hold: both read as established.
        const structures = [structure('15m', 'down', 'established', 2), structure('1h', 'down', 'established', 3)];
        const i = factsInput('bearish', '1h', structures, [live('15m', 'buy'), live('1h', 'buy')]);
        expect(i.facts.mainLine).toBeNull();
        expect(zh(i)).toEqual(['15m 与 1h 下跌趋势正在衰减，离反转 15m 还差 11 步，1h 还差 10 步']);
    });

    it('says the main 13 and its rebound first, and the timeframes counting with the bigger move after', () => {
        // The main 1h 13 is a rebound inside the 4h down move; 5m counts down to 8/13 too.
        const structures = [structure('5m', 'down', 'established', 8), structure('1h', 'down', 'exhausted', 13), structure('4h', 'down', 'established', 6)];
        const i = factsInput('bearish', '4h', structures, [live('1h', 'buy')]);
        const zhText =
            '1h 下跌趋势反转确立，信号仍有效；但这只是大级别下跌趋势里的反弹，大趋势没有反转；5m 与 4h 下跌趋势正在衰减，离反转 5m 还差 5 步，4h 还差 7 步。';
        const en =
            'The 1h downtrend has reversed, still valid. But this is only a rebound inside the bigger downtrend, which has not reversed. The 5m and 4h downtrends are fading, 5 steps from a reversal on the 5m, 7 steps on the 4h.';
        expect(zhOf(i)).toBe(zhText);
        expect(enOf(i)).toBe(en);
        expect(validateConclusion(out(en, zhText), i)).toEqual({ ok: true, en, zhCN: zhText });
    });
});

describe('allowedNumbers', () => {
    it('allows only what the labels carry: counts within 0-13, no prices or percentages', () => {
        const allowed = allowedNumbers(bearishInput());
        expect([...allowed].filter((n) => !(Number.isInteger(Number(n)) && Number(n) <= 13))).toEqual([]);
        expect(allowed.has('82831.5')).toBe(false);
    });
});

describe('validateConclusion', () => {
    it('accepts the clauses joined with ； in zhCN and as sentences in en', () => {
        expect(validateConclusion(out(EN_OK, ZH_OK), bearishInput())).toEqual({ ok: true, en: EN_OK, zhCN: ZH_OK });
    });

    it('accepts a bearish card whose 5m up move reached 13 while the 4h up move is one step from 13', () => {
        const structures = [
            structure('5m', 'up', 'exhausted', 13),
            structure('15m', 'up', 'established', 3),
            structure('1h', 'up', 'established', 5),
            structure('4h', 'up', 'established', 12),
        ];
        const i = factsInput('bearish', '5m', structures, [live('5m', 'sell')]);
        const zh =
            '5m 上涨趋势反转确立，信号仍有效；4h 离反转只差 1 步，大小级别接力反转；15m 与 1h 上涨趋势正在衰减，离反转 15m 还差 10 步，1h 还差 8 步。';
        const en =
            'The 5m uptrend has reversed, still valid. The 4h is only 1 step from a reversal: a relay of reversals across timeframes. The 15m and 1h uptrends are fading, 10 steps from a reversal on the 15m, 8 steps on the 1h.';
        expect(validateConclusion(out(en, zh), i)).toEqual({ ok: true, en, zhCN: zh });
    });

    it('accepts a resonance conclusion', () => {
        const en = `The 1h and 5m downtrends have reversed together, all still valid. The 4h downtrend is fading, only 1 step from a reversal.`;
        const zh = `${RESONANCE_ZH}；${FOUR_HOUR_ZH}。`;
        expect(validateConclusion(out(en, zh), resonanceInput())).toEqual({ ok: true, en, zhCN: zh });
    });

    it('accepts a card whose only timeframe has a failed 13', () => {
        const i = input('bullish', null, [structure('1h', 'down', 'exhausted', 13, true)]);
        expect(validateConclusion(out("The 1h down move's reversal signal has failed.", '1h 下跌的反转信号已失效。'), i)).toMatchObject({ ok: true });
    });

    it('capitalises every en sentence start after validation, leaving zhCN unchanged', () => {
        const en = EN_OK.replace(/(^|\. )(The)/g, (_, p: string, c: string) => p + c.toLowerCase());
        expect(en).not.toBe(EN_OK);
        expect(validateConclusion(out(en, ZH_OK), bearishInput())).toEqual({ ok: true, en: EN_OK, zhCN: ZH_OK });
    });

    it('removes spaces after full-width punctuation but keeps the ones inside labels', () => {
        const zh = `${MAIN_ZH}； ${RELAY_ZH}。`;
        expect(zh).not.toBe(ZH_OK);
        expect(validateConclusion(out(EN_OK, zh), bearishInput())).toEqual({ ok: true, en: EN_OK, zhCN: ZH_OK });
    });

    it('trims surrounding whitespace before checking the end', () => {
        expect(validateConclusion(out(`${EN_OK}\n`, `${ZH_OK}  `), bearishInput())).toEqual({ ok: true, en: EN_OK, zhCN: ZH_OK });
    });

    it('rejects a missing or empty conclusion', () => {
        expect(validateConclusion(null, bearishInput())).toEqual({ ok: false, reason: 'en.conclusion missing or empty' });
        expect(validateConclusion(out(EN_OK, '  '), bearishInput())).toEqual({ ok: false, reason: 'zhCN.conclusion missing or empty' });
    });

    it('rejects a conclusion that does not end its sentence', () => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace(/。$/, '')), bearishInput())).toEqual({
            ok: false,
            reason: 'zhCN.conclusion must end with 。',
        });
        expect(validateConclusion(out(EN_OK.replace(/\.$/, ''), ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: 'en.conclusion must end with .',
        });
    });

    it('rejects 整体', () => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace(/。$/, '，整体如此。')), bearishInput())).toEqual({
            ok: false,
            reason: 'zhCN.conclusion contains 整体',
        });
    });

    it('requires every clause word for word: the main line and the relation', () => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace(`；${RELAY_ZH}`, '')), bearishInput())).toEqual({
            ok: false,
            reason: `zhCN.conclusion misses ${RELAY_ZH}`,
        });
        expect(validateConclusion(out(EN_OK, ZH_OK.replace('只差 1 步', '还差 1 步')), bearishInput())).toEqual({
            ok: false,
            reason: `zhCN.conclusion misses ${RELAY_ZH}`,
        });
        expect(validateConclusion(out(EN_OK.replace('still valid', 'holding'), ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: `en.conclusion misses ${MAIN_EN}`,
        });
    });

    it('does not take a 15m label for a 5m one', () => {
        const i = input('bearish', '5m', [structure('5m', 'up', 'exhausted', 13)], [live('5m', 'sell')]);
        const zh = '15m 上涨趋势反转确立，信号仍有效。';
        const en = 'The 5m uptrend has reversed, still valid.';
        expect(validateConclusion(out(en, zh), i)).toEqual({
            ok: false,
            reason: 'zhCN.conclusion misses 5m 上涨趋势反转确立，信号仍有效',
        });
    });

    it.each([
        ['zhCN', '顶部'],
        ['zhCN', '底部'],
        ['en', 'top'],
        ['en', 'Bottom'],
    ])('rejects the push word %s %s', (lang, word) => {
        const r = validateConclusion(lang === 'en' ? out(`${word} 13. ${EN_OK}`, ZH_OK) : out(EN_OK, `${word}13。${ZH_OK}`), bearishInput());
        expect(r).toEqual({ ok: false, reason: `${lang}.conclusion contains push word ${word}` });
    });

    it('rejects the old strength-grade opener', () => {
        expect(validateConclusion(out(EN_OK, `偏空，弱：${ZH_OK}`), bearishInput()).ok).toBe(false);
    });

    it.each(['偏多', '偏空', '中性', '看涨', '多空'])('rejects the zhCN direction word %s on any card', (word) => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace(/。$/, `，${word}。`)), bearishInput())).toEqual({
            ok: false,
            reason: `zhCN.conclusion contains direction word ${word}`,
        });
        const neutral = input('neutral', null, [structure('1h', 'down', 'established', 2)]);
        expect(validateConclusion(out(enOf(neutral), `1h 下跌趋势正在衰减，离反转还差 11 步，${word}。`), neutral)).toEqual({
            ok: false,
            reason: `zhCN.conclusion contains direction word ${word}`,
        });
    });

    it.each([
        [' Overall bullish.', 'bullish'],
        [' It is bearish.', 'bearish'],
        [' Neutral.', 'Neutral'],
        [' Go long.', 'long'],
    ])('rejects the en direction word in %s', (sentence, word) => {
        expect(validateConclusion(out(`${EN_OK}${sentence}`, ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: `en.conclusion contains direction word ${word}`,
        });
    });

    it.each(['转空', '开多', '唱多', '多仓', '翻多', '追空'])('rejects the zhCN position word %s', (word) => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace(/。$/, `，短线${word}。`)), bearishInput())).toEqual({
            ok: false,
            reason: `zhCN.conclusion contains direction word ${word}`,
        });
    });

    it.each([
        [' Shorting is favoured.', 'Shorting'],
        [' It shorted.', 'shorted'],
        [' Bearishly so.', 'Bearishly'],
    ])('rejects the en position word in %s', (sentence, word) => {
        expect(validateConclusion(out(`${EN_OK}${sentence}`, ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: `en.conclusion contains direction word ${word}`,
        });
    });

    it('requires every timeframe’s clause, and the no-count sentence on an empty panel', () => {
        const neutral = input('neutral', null, [structure('1h', 'down', 'established', 2), forming('4h', 'up', 3)]);
        expect(validateConclusion(out('The 1h downtrend is fading, 11 steps from a reversal.', zhOf(neutral)), neutral)).toEqual({
            ok: false,
            reason: 'en.conclusion misses a new 4h uptrend is forming, 6 steps from being established',
        });
        const none = input('neutral', null, []);
        expect(validateConclusion(out('No timeframe from 5m to 4h shows a clear trend yet.', '没有补充。'), none)).toEqual({
            ok: false,
            reason: 'zhCN.conclusion misses 5m 到 4h 暂无明显趋势',
        });
    });

    it('takes short-term as a time window, not a direction', () => {
        expect(validateConclusion(out(EN_OK.replace(/\.$/, ' in the short-term.'), ZH_OK), bearishInput())).toMatchObject({ ok: true });
    });

    it('rejects Latin letters in zhCN beyond timeframe labels and K线', () => {
        expect(validateConclusion(out(EN_OK, ZH_OK.replace('接力反转。', '接力反转 relay。')), bearishInput())).toEqual({
            ok: false,
            reason: 'zhCN.conclusion contains Latin letters',
        });
    });

    // Plain words for beginners (2026-10-27): the labels say how many steps are left instead.
    it.each(['Countdown 6/13', 'Setup 4/9', 'Risk Level'])('rejects the term %s in either language', (term) => {
        const rejected = { ok: false, reason: expect.stringContaining('contains banned word') };
        expect(validateConclusion(out(`${term} noted. ${EN_OK}`, ZH_OK), bearishInput())).toMatchObject(rejected);
        expect(validateConclusion(out(EN_OK, `${term}；${ZH_OK}`), bearishInput())).toMatchObject(rejected);
    });

    it.each(['near-exhaustion', 'relay-exhaustion', 'counter-move-ending', 'bounce-in-trend', 'thirteen-failed'])('rejects the pattern name %s', (name) => {
        expect(validateConclusion(out(`${name}. ${EN_OK}`, ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: `en.conclusion contains pattern name ${name}`,
        });
    });

    it.each([
        ['zhCN', '主线：'],
        ['zhCN', '重点：'],
        ['en', 'Main line: '],
        ['en', 'Focus: '],
    ])('rejects the %s step label %s', (lang, label) => {
        const r = validateConclusion(lang === 'en' ? out(`${label}${EN_OK}`, ZH_OK) : out(EN_OK, `${label}${ZH_OK}`), bearishInput());
        expect(r).toEqual({ ok: false, reason: `${lang}.conclusion contains step label ${label.trim()}` });
    });

    it.each(['clauses', 'mainLine', 'neutralReason', 'closing', 'thirteenFailed', 'live13', 'reviewPick', 'riskLevel', 'barsAgo'])(
        'rejects the field name %s',
        (name) => {
            expect(validateConclusion(out(`${name}. ${EN_OK}`, ZH_OK), bearishInput())).toEqual({
                ok: false,
                reason: `en.conclusion contains field name ${name}`,
            });
        },
    );

    it.each(['DeMark', 'TD', 'Sequential', '九转', 'win rate', '胜率', 'probability', 'confidence', '置信度', 'guarantee', '倒计时'])(
        'rejects banned word %s',
        (word) => {
            expect(validateConclusion(out(`${word} noted. ${EN_OK}`, ZH_OK), bearishInput()).ok).toBe(false);
        },
    );

    it('enforces length limits of 1000 en characters and 400 zhCN characters', () => {
        const pad = (n: number, text: string, ch: string) => ch.repeat(n - [...text].length) + text;
        expect(validateConclusion(out(pad(1000, EN_OK, '-'), pad(400, ZH_OK, '关')), bearishInput())).toMatchObject({ ok: true });
        expect(validateConclusion(out(pad(1001, EN_OK, '-'), ZH_OK), bearishInput())).toEqual({ ok: false, reason: 'en.conclusion too long' });
        expect(validateConclusion(out(EN_OK, pad(401, ZH_OK, '关')), bearishInput())).toEqual({ ok: false, reason: 'zhCN.conclusion too long' });
    });

    it('applies the number whitelist, and rejects clock times', () => {
        expect(validateConclusion(out(`Price 82831.5. ${EN_OK}`, ZH_OK), bearishInput())).toEqual({
            ok: false,
            reason: 'en.conclusion has non-whitelisted number 82831.5',
        });
        expect(validateConclusion(out(EN_OK, `17：50 ${ZH_OK}`), bearishInput())).toEqual({
            ok: false,
            reason: 'zhCN.conclusion has non-whitelisted time-like value',
        });
    });
});

describe('toTraditional', () => {
    it('converts all four sections', () => {
        const converted = toTraditional({ conclusion: '软件信息', timeframes: '软件信息', review: '软件信息', watch: '软件信息' });
        expect(converted).toEqual({ conclusion: '軟體資訊', timeframes: '軟體資訊', review: '軟體資訊', watch: '軟體資訊' });
    });

    it('builds the converter on first use, once', () => {
        const actual = jest.requireActual<typeof import('opencc-js')>('opencc-js');
        const Converter = jest.fn(actual.Converter);
        jest.isolateModules(() => {
            jest.doMock('opencc-js', () => ({ ...actual, Converter }));
            const isolated: typeof import('../../../src/services/sync/signal-insight/insight-text') = require('../../../src/services/sync/signal-insight/insight-text');
            expect(Converter).not.toHaveBeenCalled();
            const sections = { conclusion: '软件', timeframes: '信息', review: '软件', watch: '信息' };
            expect(isolated.toTraditional(sections)).toEqual(toTraditional(sections));
            isolated.toTraditional(sections);
            expect(Converter).toHaveBeenCalledTimes(1);
        });
        jest.dontMock('opencc-js');
    });
});
