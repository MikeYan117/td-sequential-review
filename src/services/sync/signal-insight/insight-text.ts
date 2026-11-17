import * as OpenCC from 'opencc-js';
import { isShort, relationItemOf } from '../../manager/demark/insight-facts';
import { DemarkSide } from '../../manager/types/demark-types';
import {
    CardDirection,
    DemarkTrend,
    INSIGHT_INTERVALS,
    InsightFacts,
    InsightInterval,
    InsightSections,
    TimeframeStructure,
} from '../../manager/types/insight-types';
import { Lang, LlmLang, structureLean } from './lean';
import {
    Label,
    bounceLabel,
    establishedLabel,
    failedLabel,
    formingLabel,
    holdsSuffix,
    joinLabels,
    noCountLabel,
    relayLabel,
    resonanceLabel,
    stageLabel,
} from './wording';

export interface LlmInput {
    symbol: string;
    card: { direction: CardDirection; anchorInterval: InsightInterval | null };
    facts: InsightFacts;
}

export type ValidationResult = { ok: true; en: string; zhCN: string } | { ok: false; reason: string };

const EN_MAX_CHARS = 1000;
const ZH_MAX_CHARS = 400;

const BANNED_WORDS: RegExp[] = [
    /demark/i,
    /\bTD\b/i,
    /sequential/i,
    /九转/,
    /九轉/,
    /神奇/,
    /win rate/i,
    /胜率/,
    /probability/i,
    /概率/,
    /confidence/i,
    /置信度/,
    /guarantee/i,
    /保证/,
    // These drifted in from earlier wording.
    /倒计时/,
    /倒计数/,
    // Plain words for beginners (2026-10-27): the labels say how many steps are left instead.
    /\bsetup\b/i,
    /\bcountdown\b/i,
    /risk level/i,
];

/**
 * The strength grade the conclusion used to open with ("偏多，弱：", "Bullish, moderate:"); a trader can't
 * read it. "confidence" is already a banned word.
 */
const STRENGTH_GRADE: RegExp[] = [
    /[，,]\s*(弱|中等|强)\s*[：:]/,
    /强度/,
    /置信/,
    /\b(weak|moderate|strong)\b\s*:/i,
    /\bstrength\b/i,
];

/** Input field identifiers: the model must describe them in plain words, never print them. */
const FIELD_NAMES = [
    'live13', 'reviewPick', 'riskLevel', 'riskLevels', 'settledBarsAgo', 'formingOpposite', 'oppositeSetup',
    'strengthLabel', 'setupStep', 'windowBars', 'favorablePct', 'adversePct', 'afterPct', 'roomPct', 'sincePct',
    'confluentIntervals', 'conflictingIntervals', 'reactionWindowBars', 'barsAgo', 'watchItems',
    'mainLine', 'opposingMain', 'closing', 'thirteenFailed', 'neutralReason', 'stance', 'bigThirteens', 'clauses',
];
const FIELD_NAME_RE = new RegExp(`\\b(${FIELD_NAMES.join('|')})\\b`);

/**
 * Market-direction words (2026-10-16): the panel speaks only of trends, so none of these may reach the reader.
 * "Short-term" and "Long-term" name a time window in the headline, not a side.
 */
export const DIRECTION_WORDS: Record<LlmLang, RegExp> = {
    zhCN: /偏多|偏空|看多|看空|看涨|看跌|多头|空头|多方|空方|利多|利空|多单|空单|做多|做空|转多|转空|翻多|翻空|开多|开空|多仓|空仓|唱多|唱空|追多|追空|多空|牛|熊|中性/,
    en: /\b(bull|bear)(ish(ly)?|s)?\b|\bneutral\b|\b(long|short)(s|ed|ing)?\b(?!-term)/i,
};

const SENTENCE_END: Record<LlmLang, string> = { en: '.', zhCN: '。' };

/** The old 顶部/底部 names, which the pushes no longer use either; the panel text speaks of up and down moves. */
const PUSH_WORDS: Record<LlmLang, RegExp> = { zhCN: /顶部|底部/, en: /\b(top|bottom)\b/i };

/** Pattern identifiers and step headings from the prompt; neither means anything to the reader. */
const PATTERN_NAME = /near[- ]exhaustion|relay-exhaustion|counter-move-ending|bounce-in-trend|thirteen-failed/i;
const STEP_LABELS: RegExp[] = [/(主线|焦点|重点)\s*[：:]/, /\b(main line|focus)\s*:/i];

/** Built on first use: its dictionaries take tens of MB, which a sync process without an LLM never needs. */
let converter: OpenCC.ConverterFunction | null = null;

function cnToTw(text: string): string {
    converter ??= OpenCC.Converter({ from: 'cn', to: 'twp' });
    return converter(text);
}

/**
 * The structure the conclusion opens with: the facts' main line (R34); without one, on a bullish or bearish card,
 * the anchor timeframe if its signal is valid. Null when none applies.
 */
function mainStructureOf(input: LlmInput): TimeframeStructure | null {
    const { structures, mainLine } = input.facts;
    const byInterval = (interval: InsightInterval) => structures.find((s) => s.interval === interval);
    if (mainLine !== null) return byInterval(mainLine.interval) ?? null;
    const { direction, anchorInterval } = input.card;
    if (direction === 'neutral' || anchorInterval === null) return null;
    const anchor = byInterval(anchorInterval);
    return anchor !== undefined && structureLean(anchor) !== null ? anchor : null;
}

/** The sentence for a panel without any timeframe structure, checked word for word. */
const NO_COUNTS: Label = {
    en: 'no timeframe from 5m to 4h shows a clear trend yet',
    zhCN: '5m 到 4h 暂无明显趋势',
    ko: '5m~4h 모두 아직 뚜렷한 추세 없음',
    ja: '5m〜4h いずれも明確なトレンドなし',
};

type Category = 'reversing' | 'failed' | 'established' | 'forming' | 'noCount';

function categoryOf(s: TimeframeStructure): Category {
    if (s.stage === 'exhausted') return s.thirteenFailed ? 'failed' : 'reversing';
    if (s.stage === 'established') return 'established';
    return s.setupStep > 0 ? 'forming' : 'noCount';
}

/** Timeframes in the same stage and trend, smallest first; trend does not split timeframes without a count. */
interface Group {
    category: Category;
    structures: TimeframeStructure[];
}

function rank(interval: InsightInterval): number {
    return INSIGHT_INTERVALS.indexOf(interval);
}

function groupsOf(structures: readonly TimeframeStructure[]): Group[] {
    const groups: Group[] = [];
    for (const s of [...structures].sort((a, b) => rank(a.interval) - rank(b.interval))) {
        const category = categoryOf(s);
        const group = groups.find(
            (g) => g.category === category && (category === 'noCount' || g.structures[0]?.trend === s.trend),
        );
        if (group === undefined) groups.push({ category, structures: [s] });
        else group.structures.push(s);
    }
    return groups;
}

const EXHAUSTING_SIDE: Record<DemarkTrend, DemarkSide> = { up: 'sell', down: 'buy' };

function groupLabel({ category, structures }: Group): Label {
    const [first] = structures;
    if (first === undefined) throw new Error('Empty timeframe group');
    switch (category) {
        case 'reversing': {
            if (structures.length > 1) return resonanceLabel(structures.map((s) => s.interval), EXHAUSTING_SIDE[first.trend]);
            const stage = stageLabel(first);
            if (stage === null) throw new Error(`${first.interval} has no stage label`);
            return joinLabels(stage, holdsSuffix());
        }
        case 'failed':
            return failedLabel(structures);
        case 'established':
            return establishedLabel(structures);
        case 'forming':
            return formingLabel(structures);
        case 'noCount':
            return noCountLabel(structures.map((s) => s.interval));
    }
}

/**
 * R35: a short main 13 reversing together with a long one that is itself only a bounce inside a bigger move keeps
 * that bounce, so the bigger move is still told. Only when that long 13 is the resonance's biggest timeframe: a bounce
 * of a smaller one would say the bigger trend has not reversed beside a bigger 13 that has.
 */
function resonanceBounceOf(input: LlmInput, intervals: readonly InsightInterval[]): Label | null {
    const biggest = [...intervals].sort((a, b) => rank(b) - rank(a))[0];
    if (biggest === undefined || isShort(biggest)) return null;
    const bounce = input.facts.focus.find((item) => item.pattern === 'bounce-in-trend' && item.small === biggest);
    return bounce?.pattern === 'bounce-in-trend' ? bounceLabel(bounce.bigTrend) : null;
}

/**
 * How the main line relates to other timeframes, from the facts' relation item when it involves the main line, and
 * the timeframe it already names. A relay names its bigger timeframe, which then gets no sentence of its own. A
 * resonance is the main line's own group, so it adds nothing, except the bounce a short main line keeps (R35). A
 * counter-move is never written.
 */
function relationOf(
    input: LlmInput,
    main: TimeframeStructure,
    mainGroup: Group,
): { label: Label | null; names: InsightInterval | null } {
    const item = relationItemOf(input.facts.focus, main.interval);
    if (item?.pattern === 'resonance' && item.intervals.includes(main.interval)) {
        const together = mainGroup.category === 'reversing' && mainGroup.structures.length > 1;
        const label = together && isShort(main.interval) ? resonanceBounceOf(input, mainGroup.structures.map((s) => s.interval)) : null;
        return { label, names: null };
    }
    // focusOf pairs a relay only with a bigger timeframe at Countdown 11 or 12.
    if (item?.pattern === 'relay-exhaustion' && item.small === main.interval && (item.bigCountdown === 11 || item.bigCountdown === 12)) {
        return { label: relayLabel(item.big, item.bigCountdown), names: item.big };
    }
    if (item?.pattern === 'bounce-in-trend' && item.small === main.interval) {
        return { label: bounceLabel(item.bigTrend), names: null };
    }
    return { label: null, names: null };
}

/**
 * Everything the conclusion says, in order, rendered by code (R36): a summary of every timeframe the panel's table
 * lists. Timeframes in the same stage and trend share a sentence. The main line's sentence comes first, followed by
 * its relation to other timeframes; the rest follow by their smallest timeframe.
 */
export function conclusionClauses(input: LlmInput): Label[] {
    const main = mainStructureOf(input);
    const findGroup = (groups: Group[]) => groups.find((g) => main !== null && g.structures.includes(main));
    const mainGroup = findGroup(groupsOf(input.facts.structures));
    const relation = main === null || mainGroup === undefined ? null : relationOf(input, main, mainGroup);
    const groups = groupsOf(input.facts.structures.filter((s) => s.interval !== relation?.names));
    if (groups.length === 0) return [NO_COUNTS];
    const lead = findGroup(groups);
    const rest = groups.filter((g) => g !== lead).map(groupLabel);
    if (lead === undefined) return rest;
    const relationLabel = relation?.label ?? null;
    return [groupLabel(lead), ...(relationLabel === null ? [] : [relationLabel]), ...rest];
}

/** What the model sees: the clauses in en and zhCN, never the card's direction, so it has no bull or bear word to repeat. */
export function llmPayload(input: LlmInput): Record<string, unknown> {
    const clauses = conclusionClauses(input).map(({ en, zhCN }) => ({ en, zhCN }));
    return { symbol: input.symbol, clauses };
}

/**
 * The ko and ja conclusions, written by code (2026-11-02): the same clauses in the same order, each its own
 * sentence, as the model writes the en one.
 */
export function ruleConclusion(lang: Exclude<Lang, LlmLang>, input: LlmInput): string {
    const clauses = conclusionClauses(input).map((label) => label[lang]);
    return lang === 'ko' ? clauses.map((c) => `${c}.`).join(' ') : clauses.map((c) => `${c}。`).join('');
}

function collectNumbers(value: unknown, out: Set<string>): void {
    if (typeof value === 'string' || typeof value === 'number') {
        for (const m of String(value).matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0]);
    } else if (Array.isArray(value)) {
        for (const v of value) collectNumbers(v, out);
    } else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) collectNumbers(v, out);
    }
}

export function allowedNumbers(input: LlmInput): Set<string> {
    // The regex only matches unsigned digits, so absolute values come for free.
    const out = new Set<string>();
    collectNumbers(llmPayload(input), out);
    for (let i = 0; i <= 13; i++) out.add(String(i));
    return out;
}

function textNumbers(text: string): string[] {
    const stripped = text
        .replace(/\b(5m|15m|1h|4h|1d)\b/gi, ' ')
        .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
    return stripped.match(/\d+(?:\.\d+)?/g) ?? [];
}

function checkNumbers(text: string, allowed: Set<string>): string | null {
    // A colon alone is ordinary punctuation ("5m：…", "价格85.6：12根"); only a clock time is rejected.
    if (/[０-９]/.test(text)) return 'full-width digit';
    if (/(?<![\d.])\d{1,2}[:：]\d{2}(?!\d)/.test(text)) return 'time-like value';
    for (const n of textNumbers(text)) {
        if (!allowed.has(n)) return `number ${n}`;
    }
    return null;
}

/** zhCN may carry Latin letters only in timeframe labels and K线. */
function hasStrayLatin(text: string): boolean {
    // K线 goes first, so a label right before it ("5mK线") still stands alone.
    const rest = text.replace(/K\s*线/g, ' ').replace(/\b(5m|15m|1h|4h|1d)\b/g, '');
    return /[A-Za-z]/.test(rest);
}

function readConclusion(raw: unknown, lang: LlmLang): string | null {
    const section = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[lang] : undefined;
    const text = section && typeof section === 'object' ? (section as Record<string, unknown>).conclusion : undefined;
    return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

function checkConclusion(text: string, lang: LlmLang, input: LlmInput, allowed: Set<string>): string | null {
    const max = lang === 'en' ? EN_MAX_CHARS : ZH_MAX_CHARS;
    if ([...text].length > max) return 'too long';
    const banned = BANNED_WORDS.find((re) => re.test(text));
    if (banned) return `contains banned word ${banned}`;
    const grade = STRENGTH_GRADE.find((re) => re.test(text));
    if (grade) return `contains strength grade ${grade}`;
    const pushWord = PUSH_WORDS[lang].exec(text);
    if (pushWord) return `contains push word ${pushWord[0]}`;
    const pattern = PATTERN_NAME.exec(text);
    if (pattern) return `contains pattern name ${pattern[0]}`;
    for (const re of STEP_LABELS) {
        const step = re.exec(text);
        if (step) return `contains step label ${step[0]}`;
    }
    const field = FIELD_NAME_RE.exec(text);
    if (field) return `contains field name ${field[1]}`;
    const bad = checkNumbers(text, allowed);
    if (bad) return `has non-whitelisted ${bad}`;
    if (lang === 'zhCN' && hasStrayLatin(text)) return 'contains Latin letters';
    // 整体 usually leads into a direction word ("整体偏多"); the conclusion has no overall verdict to give.
    if (lang === 'zhCN' && text.includes('整体')) return 'contains 整体';

    if (!text.endsWith(SENTENCE_END[lang])) return `must end with ${SENTENCE_END[lang]}`;
    // Every clause word for word; the lookbehind keeps "15m …" from passing for "5m …".
    for (const label of conclusionClauses(input)) {
        // en may capitalise a label that opens a sentence.
        const re = new RegExp(`(?<![0-9A-Za-z])${label[lang].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, lang === 'en' ? 'i' : '');
        if (!re.test(text)) return `misses ${label[lang]}`;
    }
    // Any card: the conclusion speaks only of trends.
    const direction = DIRECTION_WORDS[lang].exec(text);
    if (direction) return `contains direction word ${direction[0]}`;
    return null;
}

/** The live model often starts sentences in lowercase; label matching is case-insensitive, so fix it after validation. */
function normaliseEn(text: string): string {
    return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase());
}

/** Drop the spaces the model puts after full-width punctuation; the spaces inside labels ("1h 离反转只差 1 步") stay. */
function normaliseZh(text: string): string {
    return text.replace(/([。；，：])\s+/g, '$1');
}

/** The model writes only the conclusion; every check runs on both languages. */
export function validateConclusion(raw: unknown, input: LlmInput): ValidationResult {
    const allowed = allowedNumbers(input);
    const texts = {} as Record<LlmLang, string>;
    for (const lang of ['en', 'zhCN'] as const) {
        const text = readConclusion(raw, lang);
        if (text === null) return { ok: false, reason: `${lang}.conclusion missing or empty` };
        const problem = checkConclusion(text, lang, input, allowed);
        if (problem) return { ok: false, reason: `${lang}.conclusion ${problem}` };
        texts[lang] = text;
    }
    return { ok: true, en: normaliseEn(texts.en), zhCN: normaliseZh(texts.zhCN) };
}

export function toTraditional(sections: InsightSections): InsightSections {
    return {
        conclusion: cnToTw(sections.conclusion),
        timeframes: cnToTw(sections.timeframes),
        review: cnToTw(sections.review),
        watch: cnToTw(sections.watch),
    };
}
