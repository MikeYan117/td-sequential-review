import { DemarkSide } from '../../manager/types/demark-types';
import {
    DemarkTrend,
    INSIGHT_INTERVALS,
    InsightFacts,
    InsightInterval,
    InsightSections,
    ReviewItem,
    ReviewVerdict,
    TimeframeStructure,
} from '../../manager/types/insight-types';
import { Lang, SIDE_TREND, intactThirteenOf } from './lean';
import { MOVE, enList, establishSteps, reversalSteps, stepsWord } from './wording';

export type TemplateSections = Pick<InsightSections, 'timeframes' | 'review' | 'watch'>;

/** A forming setup at least this far along is worth watching. */
const WATCH_MIN_SETUP_STEP = 5;
const WATCH_ITEMS = 2;
/** A second countdown is worth watching only this close to 13. */
const WATCH_SECOND_COUNTDOWN_FROM = 11;

export type WatchItem =
    | { kind: 'risk'; interval: InsightInterval; side: DemarkSide; riskLevel: string; roomPct: string }
    | { kind: 'countdown'; interval: InsightInterval; trend: DemarkTrend; countdown: number }
    | { kind: 'setup'; interval: InsightInterval; trend: DemarkTrend; step: number };

function rank(interval: InsightInterval): number {
    return INSIGHT_INTERVALS.indexOf(interval);
}

/** The main line's own item: its 13's risk level, or its 9's countdown. Null without a main line. */
function mainWatchItem(facts: InsightFacts): WatchItem | null {
    const main = facts.structures.find((s) => s.interval === facts.mainLine?.interval);
    if (main === undefined) return null;
    if (main.stage === 'exhausted') {
        const live = intactThirteenOf(facts.live13, main);
        return live === undefined
            ? null
            : { kind: 'risk', interval: live.interval, side: live.side, riskLevel: live.riskLevel, roomPct: live.roomPct };
    }
    if (main.stage === 'established' && (main.countdown === 11 || main.countdown === 12)) {
        return { kind: 'countdown', interval: main.interval, trend: main.trend, countdown: main.countdown };
    }
    return null;
}

/**
 * At most two things to watch, by rule: the main line first, then an intact risk level, the countdown
 * nearest 13, the setup nearest 9.
 */
export function watchItemsOf(facts: InsightFacts): WatchItem[] {
    const items: WatchItem[] = [];
    const [risk] = facts.live13.filter((live) => live.intact).sort((a, b) => rank(b.interval) - rank(a.interval));
    if (risk !== undefined) {
        const { interval, side, riskLevel, roomPct } = risk;
        items.push({ kind: 'risk', interval, side, riskLevel, roomPct });
    }
    const [counting, nextCounting] = facts.structures
        .filter((s) => s.stage === 'established' && s.countdown > 0)
        .sort((a, b) => b.countdown - a.countdown || rank(b.interval) - rank(a.interval));
    for (const s of [counting, nextCounting]) {
        if (s === undefined || (s === nextCounting && s.countdown < WATCH_SECOND_COUNTDOWN_FROM)) continue;
        items.push({ kind: 'countdown', interval: s.interval, trend: s.trend, countdown: s.countdown });
    }
    const [setup] = facts.structures
        .flatMap((s) => [
            ...(s.stage === 'forming' ? [{ interval: s.interval, trend: s.trend, step: s.setupStep }] : []),
            ...(s.formingOpposite !== null ? [{ interval: s.interval, ...s.formingOpposite }] : []),
        ])
        .filter((s) => s.step >= WATCH_MIN_SETUP_STEP && s.step < 9)
        .sort((a, b) => b.step - a.step || rank(b.interval) - rank(a.interval));
    if (setup !== undefined) {
        items.push({ kind: 'setup', ...setup });
    }
    const first = mainWatchItem(facts);
    if (first === null) return items.slice(0, WATCH_ITEMS);
    const rest = items.filter((i) => i.interval !== first.interval || i.kind !== first.kind);
    return [first, ...rest].slice(0, WATCH_ITEMS);
}

const END: Record<Lang, string> = { en: '.', zhCN: '。', ko: '.', ja: '。' };
const JOIN: Record<Lang, string> = { en: '; ', zhCN: '；', ko: '; ', ja: '／' };
const COLON: Record<Lang, string> = { en: ': ', zhCN: '：', ko: ': ', ja: '：' };
/** Between sentences: a space after a Latin or Hangul full stop, none after 。. */
const SENTENCE_SEP: Record<Lang, string> = { en: ' ', zhCN: '', ko: ' ', ja: '' };

/** A forming count and how far it is from its 9: "下跌还差 5 步确立" / "down move, 5 steps from being established". */
function setupWord(lang: Lang, trend: DemarkTrend, step: number): string {
    const steps = stepsWord(lang, establishSteps(step));
    const move = MOVE[lang][trend];
    switch (lang) {
        case 'en':
            return `${move}, ${steps} from being established`;
        case 'zhCN':
            return `${move}${steps}确立`;
        case 'ko':
            return `${move}, 확립까지 ${steps}`;
        case 'ja':
            return `${move}、確立まで${steps}`;
    }
}

const FAILED_ENTRY: Record<Lang, (interval: InsightInterval, move: string) => string> = {
    en: (interval, move) => `${interval} ${move}'s reversal signal failed (a close went past its risk level)`,
    zhCN: (interval, move) => `${interval} ${move}的反转信号失效（收盘越过了风险位）`,
    ko: (interval, move) => `${interval} ${move} 반전 신호 무효(종가가 위험선을 넘음)`,
    ja: (interval, move) => `${interval} ${move}の反転シグナルは失効（終値がリスクラインを越えた）`,
};

const COUNTING_ENTRY: Record<Lang, (interval: InsightInterval, move: string, steps: string) => string> = {
    en: (interval, move, steps) => `${interval} ${move}, ${steps} to go`,
    zhCN: (interval, move, steps) => `${interval} ${move}${steps}`,
    ko: (interval, move, steps) => `${interval} ${move}, ${steps} 남음`,
    ja: (interval, move, steps) => `${interval} ${move}、${steps}`,
};

/** A new count after a 13: ", new …" / "，新的…". */
const NEW_COUNT: Record<Lang, string> = { en: ', new ', zhCN: '，新的', ko: ', 새로운 ', ja: '、新たな' };

/** One timeframe in the timeframes section: its move and how far it has counted. */
function structureEntry(lang: Lang, s: TimeframeStructure): string | null {
    const move = MOVE[lang][s.trend];
    let entry: string;
    if (s.stage === 'forming') {
        if (s.setupStep < 1) return null;
        entry = `${s.interval} ${setupWord(lang, s.trend, s.setupStep)}`;
    } else if (s.stage === 'exhausted') {
        entry = s.thirteenFailed ? FAILED_ENTRY[lang](s.interval, move) : `${s.interval} ${move}`;
    } else {
        entry = COUNTING_ENTRY[lang](s.interval, move, stepsWord(lang, reversalSteps(s.countdown)));
    }
    if (s.stage === 'exhausted' && s.formingOpposite !== null) {
        entry += NEW_COUNT[lang] + setupWord(lang, s.formingOpposite.trend, s.formingOpposite.step);
    }
    return entry;
}

interface Group {
    label: string;
    items: string[];
}

/** The groups of the timeframes section, by trend stage (2026-10-16): never by a bull or bear side. */
const GROUPS: Record<Lang, { reversing: string; established: string; forming: string; failed: string }> = {
    zhCN: { reversing: '反转确立', established: '衰减中、反转倒计时', forming: '新趋势', failed: '已失效' },
    en: { reversing: 'Reversal confirmed', established: 'Fading, counting down to a reversal', forming: 'New trend', failed: 'Failed' },
    ko: { reversing: '반전 확정', established: '약화 중, 반전까지 남은 단계', forming: '새 추세', failed: '무효' },
    ja: { reversing: '反転確定', established: '減速中・反転までの残り', forming: '新トレンド', failed: '失効' },
};

const NO_TREND: Record<Lang, string> = {
    en: 'No timeframe shows a clear trend yet.',
    zhCN: '各周期暂无明显趋势。',
    ko: '모든 주기에서 아직 뚜렷한 추세 없음.',
    ja: '各時間軸とも明確なトレンドなし。',
};

function timeframesText(lang: Lang, structures: TimeframeStructure[]): string {
    const ordered = [...structures].sort((a, b) => rank(a.interval) - rank(b.interval));
    const entries = (keep: (s: TimeframeStructure) => boolean): string[] =>
        ordered
            .filter(keep)
            .map((s) => structureEntry(lang, s))
            .filter((e): e is string => e !== null);
    const words = GROUPS[lang];
    const groups: Group[] = [
        { label: words.reversing, items: entries((s) => s.stage === 'exhausted' && !s.thirteenFailed) },
        { label: words.established, items: entries((s) => s.stage === 'established') },
        { label: words.forming, items: entries((s) => s.stage === 'forming') },
        { label: words.failed, items: entries((s) => s.thirteenFailed) },
    ].filter((g) => g.items.length > 0);
    if (groups.length === 0) return NO_TREND[lang];
    const sep = SENTENCE_SEP[lang];
    const text = groups.map((g) => `${g.label}${COLON[lang]}${g.items.join(JOIN[lang])}${END[lang]}`).join(sep);
    const summary = summaryText(lang, structures);
    return summary === '' ? text : `${text}${sep}${summary}`;
}

/** Two or more timeframes of one move one or two steps from 13, biggest first. */
function resonanceClause(lang: Lang, tfs: InsightInterval[], trend: DemarkTrend, oneStep: boolean): string {
    switch (lang) {
        case 'en':
            return `the ${enList(tfs)} ${MOVE.en[trend]}s are all ${oneStep ? 'one step' : 'one or two steps'} from a reversal and may reverse together`;
        case 'zhCN':
            return `${tfs.join('、')} ${MOVE.zhCN[trend]}离反转都只差${oneStep ? '一步' : '一两步'}，可能同步反转`;
        case 'ko':
            return `${tfs.join('·')} ${MOVE.ko[trend]} 모두 반전까지 ${oneStep ? '한 단계' : '한두 단계'}, 동시 반전 가능`;
        case 'ja':
            return `${tfs.join('・')} ${MOVE.ja[trend]}はいずれも反転まであと${oneStep ? '一歩' : '一、二歩'}、同時に反転する可能性`;
    }
}

/** The closing sentence of the timeframes section: per trend, two or more timeframes one or two steps from 13. */
function summaryText(lang: Lang, structures: TimeframeStructure[]): string {
    const resonances = (['up', 'down'] as const)
        .map((trend) =>
            structures
                .filter((s) => s.stage === 'established' && s.trend === trend && (s.countdown === 11 || s.countdown === 12))
                .sort((a, b) => rank(b.interval) - rank(a.interval)),
        )
        .filter((near) => near.length >= 2)
        .sort((a, b) => rank(b[0]!.interval) - rank(a[0]!.interval));
    const clauses = resonances.map((near) =>
        resonanceClause(lang, near.map((s) => s.interval), near[0]!.trend, near.every((s) => s.countdown === 12)),
    );
    if (clauses.length === 0) return '';
    if (lang === 'en') {
        const sentence = clauses.join(', ');
        return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
    }
    const comma: Record<Exclude<Lang, 'en'>, string> = { zhCN: '，', ko: ', ', ja: '、' };
    return `${clauses.join(comma[lang])}${END[lang]}`;
}

const VERDICT_WORDS: Record<Lang, Record<ReviewVerdict, { buy: string; sell: string }>> = {
    zhCN: {
        confirmed: { buy: '按预期反弹', sell: '按预期回落' },
        unconfirmed: { buy: '未见反弹', sell: '未见回落' },
        unclear: { buy: '没走出明确结果', sell: '没走出明确结果' },
        failed: { buy: '风险位被突破', sell: '风险位被突破' },
        pending: { buy: '仍在观察期', sell: '仍在观察期' },
    },
    en: {
        confirmed: { buy: 'rebounded as expected', sell: 'pulled back as expected' },
        unconfirmed: { buy: 'no rebound', sell: 'no pullback' },
        unclear: { buy: 'no clear move either way', sell: 'no clear move either way' },
        failed: { buy: 'risk level broken', sell: 'risk level broken' },
        pending: { buy: 'still in its window', sell: 'still in its window' },
    },
    ko: {
        confirmed: { buy: '예상대로 반등', sell: '예상대로 하락' },
        unconfirmed: { buy: '반등 없음', sell: '하락 없음' },
        unclear: { buy: '뚜렷한 결과 없음', sell: '뚜렷한 결과 없음' },
        failed: { buy: '위험선 돌파', sell: '위험선 돌파' },
        pending: { buy: '관찰 기간 중', sell: '관찰 기간 중' },
    },
    ja: {
        confirmed: { buy: '想定どおり反発', sell: '想定どおり下落' },
        unconfirmed: { buy: '反発なし', sell: '下落なし' },
        unclear: { buy: '明確な結果なし', sell: '明確な結果なし' },
        failed: { buy: 'リスクラインを突破', sell: 'リスクラインを突破' },
        pending: { buy: '観察期間中', sell: '観察期間中' },
    },
};

/** What a reviewed signal is, in plain words: a 9 establishes a trend, a 13 reverses it. */
const KIND_WORDS: Record<Lang, Record<ReviewItem['kind'], string>> = {
    zhCN: { 9: '确立信号', 13: '反转信号' },
    en: { 9: 'trend-established signal', 13: 'reversal signal' },
    ko: { 9: '확립 신호', 13: '반전 신호' },
    ja: { 9: '確立シグナル', 13: '反転シグナル' },
};

// A 9 is expected to keep its own move going, so its confirmed/unconfirmed words differ from a 13's.
const NINE_VERDICT_WORDS: Record<Lang, Record<'confirmed' | 'unconfirmed', { buy: string; sell: string }>> = {
    zhCN: {
        confirmed: { buy: '按预期继续下跌', sell: '按预期继续上涨' },
        unconfirmed: { buy: '未见继续下跌', sell: '未见继续上涨' },
    },
    en: {
        confirmed: { buy: 'kept falling as expected', sell: 'kept rising as expected' },
        unconfirmed: { buy: 'did not keep falling', sell: 'did not keep rising' },
    },
    ko: {
        confirmed: { buy: '예상대로 하락 지속', sell: '예상대로 상승 지속' },
        unconfirmed: { buy: '하락 지속 없음', sell: '상승 지속 없음' },
    },
    ja: {
        confirmed: { buy: '想定どおり下落継続', sell: '想定どおり上昇継続' },
        unconfirmed: { buy: '下落継続せず', sell: '上昇継続せず' },
    },
};

function moveOf(pct: string): string {
    if (Number(pct) === 0) return `${pct.replace(/^[-+]/, '')}%`;
    return `${/^[-+]/.test(pct) ? '' : '+'}${pct}%`;
}

function bars(n: number): string {
    return n === 1 ? 'bar' : 'bars';
}

const NO_REVIEW: Record<Lang, string> = {
    en: 'No recent signal to review.',
    zhCN: '近期没有可复盘的信号。',
    ko: '최근 복기할 신호 없음.',
    ja: '直近で振り返るシグナルなし。',
};

function reviewText(lang: Lang, pick: ReviewItem | null): string {
    if (pick === null) return NO_REVIEW[lang];
    const move = MOVE[lang][SIDE_TREND[pick.side]];
    const verdict =
        pick.kind === 9 && (pick.verdict === 'confirmed' || pick.verdict === 'unconfirmed')
            ? NINE_VERDICT_WORDS[lang][pick.verdict][pick.side]
            : VERDICT_WORDS[lang][pick.verdict][pick.side];
    const since = pick.verdict === 'pending' ? null : moveOf(pick.sincePct);
    const kind = KIND_WORDS[lang][pick.kind];
    switch (lang) {
        case 'en':
            return `The ${pick.interval} ${move}'s ${kind}, ${pick.barsAgo} ${bars(pick.barsAgo)} ago at ${pick.price}${since === null ? '' : `, ${since} since`}: ${verdict}.`;
        case 'zhCN':
            return `${pick.interval} ${move}的${kind}，${pick.barsAgo} 根K线前，价格 ${pick.price}${since === null ? '' : `，至今 ${since}`}，${verdict}。`;
        case 'ko':
            return `${pick.interval} ${move} ${kind}, ${pick.barsAgo}봉 전, 가격 ${pick.price}${since === null ? '' : `, 이후 ${since}`}, ${verdict}.`;
        case 'ja':
            return `${pick.interval} ${move}の${kind}、${pick.barsAgo} 本前、価格 ${pick.price}${since === null ? '' : `、以降 ${since}`}、${verdict}。`;
    }
}

const RISK_ITEM: Record<Lang, (riskLevel: string, interval: InsightInterval, up: boolean) => string> = {
    en: (riskLevel, interval, up) => `${riskLevel}: a ${interval} close ${up ? 'above' : 'below'} it cancels the reversal signal`,
    zhCN: (riskLevel, interval, up) => `${riskLevel}：${interval} 收盘${up ? '涨过' : '跌破'}这个价，反转信号就失效`,
    ko: (riskLevel, interval, up) => `${riskLevel}: ${interval} 종가가 이 가격을 ${up ? '상회' : '하회'}하면 반전 신호 무효`,
    ja: (riskLevel, interval, up) => `${riskLevel}：${interval} の終値がこの価格を${up ? '上回る' : '下回る'}と反転シグナルは失効`,
};

const COUNTDOWN_ITEM: Record<Lang, (interval: InsightInterval, move: string, steps: string) => string> = {
    en: (interval, move, steps) => `whether the ${interval} ${move}, ${steps} from a reversal, gets there`,
    zhCN: (interval, move, steps) => `${interval} ${move}离反转${steps}，看能否走完`,
    ko: (interval, move, steps) => `${interval} ${move} 반전까지 ${steps}, 도달 여부`,
    ja: (interval, move, steps) => `${interval} ${move}は反転まで${steps}、到達するか`,
};

const SETUP_ITEM: Record<Lang, (interval: InsightInterval, setup: string) => string> = {
    en: (interval, setup) => `whether the ${interval} ${setup}, gets there`,
    zhCN: (interval, setup) => `${interval} ${setup}，看能否走完`,
    ko: (interval, setup) => `${interval} ${setup}, 도달 여부`,
    ja: (interval, setup) => `${interval} ${setup}、到達するか`,
};

function watchItemText(lang: Lang, item: WatchItem): string {
    switch (item.kind) {
        case 'risk':
            // A close past the risk level fails the 13: above it for an up move, below it for a down move.
            return RISK_ITEM[lang](item.riskLevel, item.interval, SIDE_TREND[item.side] === 'up');
        case 'countdown':
            return COUNTDOWN_ITEM[lang](item.interval, MOVE[lang][item.trend], stepsWord(lang, reversalSteps(item.countdown)));
        case 'setup':
            return SETUP_ITEM[lang](item.interval, setupWord(lang, item.trend, item.step));
    }
}

const NO_WATCH: Record<Lang, string> = {
    en: 'No timeframe is close to being established or reversing.',
    zhCN: '暂无接近确立或反转的周期。',
    ko: '확립이나 반전에 가까운 주기 없음.',
    ja: '確立・反転が近い時間軸なし。',
};

// No colon after the lead: a risk-level item opens with its own ("关注 82569.7：…").
const WATCH_LEAD: Record<Lang, string> = { en: 'Watch ', zhCN: '关注 ', ko: '주목 ', ja: '注目 ' };

function watchText(lang: Lang, facts: InsightFacts): string {
    const items = watchItemsOf(facts);
    if (items.length === 0) return NO_WATCH[lang];
    return `${WATCH_LEAD[lang]}${items.map((i) => watchItemText(lang, i)).join(JOIN[lang])}${END[lang]}`;
}

/** The three sections written by fixed templates; only the en and zhCN conclusions are left to the model. */
export function templateSections(facts: InsightFacts): Record<Lang, TemplateSections> {
    const make = (lang: Lang): TemplateSections => ({
        timeframes: timeframesText(lang, facts.structures),
        review: reviewText(lang, facts.reviewPick),
        watch: watchText(lang, facts),
    });
    return { en: make('en'), zhCN: make('zhCN'), ko: make('ko'), ja: make('ja') };
}
