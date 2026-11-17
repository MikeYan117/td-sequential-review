// The conclusion's words for each timeframe's trend (spec section 6.5, 2026-10-16): before a 9 a new trend is
// forming, at 9 the trend is established and starts to fade while Countdown counts toward 13, and at 13 the trend
// reverses. The labels speak only of trends, never of a bull or bear side, and in plain words for beginners
// (2026-10-27): never Setup, Countdown or Risk Level, only how many steps are left to the next 9 or 13. ko and ja
// (2026-11-02) say the same in short note style, each clause a sentence of its own.

import { DemarkSide } from '../../manager/types/demark-types';
import { DemarkTrend, INSIGHT_INTERVALS, InsightInterval, TimeframeStructure } from '../../manager/types/insight-types';
import { Lang, SIDE_TREND } from './lean';

export type Label = Record<Lang, string>;

/** The move a structure counts: "上涨" / "up move". */
export const MOVE: Record<Lang, Record<DemarkTrend, string>> = {
    zhCN: { up: '上涨', down: '下跌' },
    en: { up: 'up move', down: 'down move' },
    ko: { up: '상승', down: '하락' },
    ja: { up: '上昇', down: '下落' },
};

export function eachLang(text: (lang: Lang) => string): Label {
    return { en: text('en'), zhCN: text('zhCN'), ko: text('ko'), ja: text('ja') };
}

/** How far a count is from its 9 or 13: "还差 5 步" / "5 steps"; one or two steps read as "只差 1 步" / "only 1 step". */
export function stepsWord(lang: Lang, steps: number): string {
    const near = steps <= 2;
    switch (lang) {
        case 'en':
            return `${near ? 'only ' : ''}${steps} ${steps === 1 ? 'step' : 'steps'}`;
        case 'zhCN':
            return `${near ? '只' : '还'}差 ${steps} 步`;
        case 'ko':
            return `${near ? '단 ' : ''}${steps}단계`;
        case 'ja':
            return `${near ? 'わずか' : 'あと'} ${steps} ステップ`;
    }
}

/** The steps a Countdown has left to 13. */
export function reversalSteps(countdown: number): number {
    return 13 - countdown;
}

/** The steps a Setup has left to 9. */
export function establishSteps(setupStep: number): number {
    return 9 - setupStep;
}

/** The en name of a trend: "uptrend" / "downtrend". */
const TREND: Record<DemarkTrend, string> = { up: 'uptrend', down: 'downtrend' };

/** The ko and ja names of a trend: "상승 추세" / "上昇トレンド". */
const KO_TREND: Record<DemarkTrend, string> = { up: '상승 추세', down: '하락 추세' };
const JA_TREND: Record<DemarkTrend, string> = { up: '上昇トレンド', down: '下落トレンド' };

/**
 * A timeframe's stage in the conclusion; null while it is only forming. "1h 下跌趋势反转确立",
 * "4h 下跌趋势正在衰减，离反转还差 7 步", "1d 上涨趋势正在衰减，离反转只差 1 步", "4h 下跌趋势刚确立、开始衰减，离反转还差 13 步".
 */
export function stageLabel(s: TimeframeStructure): Label | null {
    if (s.stage === 'forming') return null;
    const zhTrend = `${s.interval} ${MOVE.zhCN[s.trend]}趋势`;
    const enTrend = `the ${s.interval} ${TREND[s.trend]}`;
    const koTrend = `${s.interval} ${KO_TREND[s.trend]}`;
    const jaTrend = `${s.interval} ${JA_TREND[s.trend]}`;
    if (s.stage === 'exhausted') {
        return { en: `${enTrend} has reversed`, zhCN: `${zhTrend}反转确立`, ko: `${koTrend} 반전 확정`, ja: `${jaTrend}反転確定` };
    }
    const steps = reversalSteps(s.countdown);
    const fading: Label =
        s.countdown === 0
            ? {
                  en: `${enTrend} has just been established and starts to fade`,
                  zhCN: `${zhTrend}刚确立、开始衰减`,
                  ko: `${koTrend} 막 확립, 약화 시작`,
                  ja: `${jaTrend}は確立したばかりで弱まり始め`,
              }
            : { en: `${enTrend} is fading`, zhCN: `${zhTrend}正在衰减`, ko: `${koTrend} 약화 중`, ja: `${jaTrend}は弱まりつつあり` };
    return {
        en: `${fading.en}, ${stepsWord('en', steps)} from a reversal`,
        zhCN: `${fading.zhCN}，离反转${stepsWord('zhCN', steps)}`,
        ko: `${fading.ko}, 반전까지 ${stepsWord('ko', steps)}`,
        ja: `${fading.ja}、反転まで${stepsWord('ja', steps)}`,
    };
}

/** A 13 still holds while its risk level is not broken. */
export function holdsSuffix(): Label {
    return { en: ', still valid', zhCN: '，信号仍有效', ko: ', 신호 유효', ja: '、シグナルは有効' };
}

export function joinLabels(...parts: Label[]): Label {
    return eachLang((lang) => parts.map((p) => p[lang]).join(''));
}

/** "5m and 15m" / "5m, 15m and 1h". */
export function enList(intervals: readonly InsightInterval[]): string {
    if (intervals.length < 2) return intervals.join('');
    return `${intervals.slice(0, -1).join(', ')} and ${intervals[intervals.length - 1]}`;
}

/** "5m 与 15m" / "5m、15m、1h". */
function zhList(intervals: readonly InsightInterval[]): string {
    return intervals.join(intervals.length === 2 ? ' 与 ' : '、');
}

/** "5m·15m·1h": no particle, which would depend on how the last label is read. */
function koList(intervals: readonly InsightInterval[]): string {
    return intervals.join('·');
}

/** "5m・15m・1h". */
function jaList(intervals: readonly InsightInterval[]): string {
    return intervals.join('・');
}

/** A relay, said of the bigger timeframe one or two steps from 13; the main line before it is the small 13. */
export function relayLabel(big: InsightInterval, bigCountdown: 11 | 12): Label {
    const steps = reversalSteps(bigCountdown);
    return {
        en: `the ${big} is ${stepsWord('en', steps)} from a reversal: a relay of reversals across timeframes`,
        zhCN: `${big} 离反转${stepsWord('zhCN', steps)}，大小级别接力反转`,
        ko: `${big} 반전까지 ${stepsWord('ko', steps)}, 상하위 주기 연쇄 반전`,
        ja: `${big} は反転まで${stepsWord('ja', steps)}、時間軸をまたいだ連鎖反転`,
    };
}

/**
 * The main 13 reversed a trend a bigger timeframe is still counting, so what follows is only a rebound or
 * pullback inside it: "但这只是大级别下跌趋势里的反弹，大趋势没有反转".
 */
export function bounceLabel(bigTrend: DemarkTrend): Label {
    const down = bigTrend === 'down';
    return {
        en: `but this is only a ${down ? 'rebound' : 'pullback'} inside the bigger ${TREND[bigTrend]}, which has not reversed`,
        zhCN: `但这只是大级别${MOVE.zhCN[bigTrend]}趋势里的${down ? '反弹' : '回调'}，大趋势没有反转`,
        ko: `다만 이는 상위 ${KO_TREND[bigTrend]} 속 ${down ? '반등' : '조정'}일 뿐, 큰 추세는 반전되지 않음`,
        ja: `ただし上位の${JA_TREND[bigTrend]}内の${down ? '反発' : '調整'}にすぎず、大きなトレンドは反転していない`,
    };
}

/**
 * Several timeframes whose 13s on the same side still hold, the biggest first:
 * "1h 与 15m 下跌趋势同步反转确立，信号都还有效"; three or more are joined with 、.
 */
export function resonanceLabel(intervals: readonly InsightInterval[], side: DemarkSide): Label {
    const trend = SIDE_TREND[side];
    const named = [...intervals].sort((a, b) => INSIGHT_INTERVALS.indexOf(b) - INSIGHT_INTERVALS.indexOf(a));
    return {
        en: `the ${enList(named)} ${TREND[trend]}s have reversed together, all still valid`,
        zhCN: `${zhList(named)} ${MOVE.zhCN[trend]}趋势同步反转确立，信号都还有效`,
        ko: `${koList(named)} ${KO_TREND[trend]} 동시 반전 확정, 신호 모두 유효`,
        ja: `${jaList(named)} ${JA_TREND[trend]}が同時に反転確定、シグナルはいずれも有効`,
    };
}

// R36: the conclusion sums up every timeframe the panel's table lists. The labels below each name a group of
// timeframes in the same stage and trend, given smallest first; one timeframe alone reads as its own stage.

/** Timeframes whose 13 has failed (a close went past its risk level): "5m 与 15m 上涨的反转信号已失效". */
export function failedLabel(structures: readonly TimeframeStructure[]): Label {
    const [first] = structures;
    if (first === undefined) throw new Error('A failed group needs a timeframe');
    const intervals = structures.map((s) => s.interval);
    const enMove =
        structures.length > 1 ? `${MOVE.en[first.trend]}s' reversal signals have` : `${MOVE.en[first.trend]}'s reversal signal has`;
    return {
        en: `the ${enList(intervals)} ${enMove} failed`,
        zhCN: `${zhList(intervals)} ${MOVE.zhCN[first.trend]}的反转信号已失效`,
        ko: `${koList(intervals)} ${MOVE.ko[first.trend]} 반전 신호 무효`,
        ja: `${jaList(intervals)} ${MOVE.ja[first.trend]}の反転シグナルは失効`,
    };
}

// What a group's steps lead to; zhCN says 离反转 once before the whole list instead, and ko and ja say it once before
// the list for both ("반전까지", "確立まで").
type GroupLang = 'en' | 'zhCN';
const TO_REVERSAL: Record<GroupLang, string> = { en: ' from a reversal', zhCN: '' };
const TO_ESTABLISHED: Record<GroupLang, string> = { en: ' from being established', zhCN: '确立' };

/**
 * Each timeframe's steps in a group: "5m 还差 6 步确立，1h 还差 7 步确立"; in en only the first says what they lead
 * to, "6 steps from being established on the 5m, 7 steps on the 1h"; "5m 6단계, 1h 7단계"; "5m はあと 6 ステップ、1h はあと 7 ステップ".
 */
function groupSteps(
    lang: Lang,
    structures: readonly TimeframeStructure[],
    steps: (s: TimeframeStructure) => number,
    to: Record<GroupLang, string>,
): string {
    switch (lang) {
        case 'zhCN':
            return structures.map((s) => `${s.interval} ${stepsWord(lang, steps(s))}${to.zhCN}`).join('，');
        case 'en':
            return structures.map((s, i) => `${stepsWord(lang, steps(s))}${i === 0 ? to.en : ''} on the ${s.interval}`).join(', ');
        case 'ko':
            return structures.map((s) => `${s.interval} ${stepsWord(lang, steps(s))}`).join(', ');
        case 'ja':
            return structures.map((s) => `${s.interval} は${stepsWord(lang, steps(s))}`).join('、');
    }
}

/**
 * Timeframes counting from 9 toward 13: one reads as its stage ("1h 下跌趋势刚确立、开始衰减，离反转还差 13 步"), more as
 * "5m 与 15m 上涨趋势正在衰减，离反转 5m 还差 7 步，15m 还差 12 步".
 */
export function establishedLabel(structures: readonly TimeframeStructure[]): Label {
    const [first] = structures;
    if (first === undefined) throw new Error('An established group needs a timeframe');
    if (structures.length === 1) {
        const stage = stageLabel(first);
        if (stage === null) throw new Error(`${first.interval} is not established`);
        return stage;
    }
    const intervals = structures.map((s) => s.interval);
    const steps = (s: TimeframeStructure) => reversalSteps(s.countdown);
    return {
        en: `the ${enList(intervals)} ${TREND[first.trend]}s are fading, ${groupSteps('en', structures, steps, TO_REVERSAL)}`,
        zhCN: `${zhList(intervals)} ${MOVE.zhCN[first.trend]}趋势正在衰减，离反转 ${groupSteps('zhCN', structures, steps, TO_REVERSAL)}`,
        ko: `${koList(intervals)} ${KO_TREND[first.trend]} 약화 중, 반전까지 ${groupSteps('ko', structures, steps, TO_REVERSAL)}`,
        ja: `${jaList(intervals)} ${JA_TREND[first.trend]}は弱まりつつあり、反転まで ${groupSteps('ja', structures, steps, TO_REVERSAL)}`,
    };
}

/** Timeframes whose new trend is forming: "4h 新的下跌趋势形成中，还差 5 步确立"; more as "…形成中，5m 还差 6 步确立，1h 还差 7 步确立". */
export function formingLabel(structures: readonly TimeframeStructure[]): Label {
    const [first] = structures;
    if (first === undefined) throw new Error('A forming group needs a timeframe');
    const intervals = structures.map((s) => s.interval);
    if (structures.length === 1) {
        const left = establishSteps(first.setupStep);
        return {
            en: `a new ${first.interval} ${TREND[first.trend]} is forming, ${stepsWord('en', left)}${TO_ESTABLISHED.en}`,
            zhCN: `${first.interval} 新的${MOVE.zhCN[first.trend]}趋势形成中，${stepsWord('zhCN', left)}${TO_ESTABLISHED.zhCN}`,
            ko: `${first.interval} 새로운 ${KO_TREND[first.trend]} 형성 중, 확립까지 ${stepsWord('ko', left)}`,
            ja: `${first.interval} 新たな${JA_TREND[first.trend]}が形成中、確立まで${stepsWord('ja', left)}`,
        };
    }
    const steps = (s: TimeframeStructure) => establishSteps(s.setupStep);
    return {
        en: `new ${enList(intervals)} ${TREND[first.trend]}s are forming, ${groupSteps('en', structures, steps, TO_ESTABLISHED)}`,
        zhCN: `${zhList(intervals)} 新的${MOVE.zhCN[first.trend]}趋势形成中，${groupSteps('zhCN', structures, steps, TO_ESTABLISHED)}`,
        ko: `${koList(intervals)} 새로운 ${KO_TREND[first.trend]} 형성 중, 확립까지 ${groupSteps('ko', structures, steps, TO_ESTABLISHED)}`,
        ja: `${jaList(intervals)} 新たな${JA_TREND[first.trend]}が形成中、確立まで ${groupSteps('ja', structures, steps, TO_ESTABLISHED)}`,
    };
}

/** Timeframes with no count at all, not even Setup 1: "1h 与 4h 暂无明显趋势". */
export function noCountLabel(intervals: readonly InsightInterval[]): Label {
    return {
        en: `the ${enList(intervals)} ${intervals.length > 1 ? 'have' : 'has'} no clear trend yet`,
        zhCN: `${zhList(intervals)} 暂无明显趋势`,
        ko: `${koList(intervals)} 뚜렷한 추세 없음`,
        ja: `${jaList(intervals)} 明確なトレンドなし`,
    };
}
