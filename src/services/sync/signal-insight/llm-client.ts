import { InsightSections, InsightText } from '../../manager/types/insight-types';
import { Logger } from '../../../shared/utils/logger';
import { TemplateSections, templateSections } from './insight-template';
import { LlmInput, llmPayload, ruleConclusion, toTraditional, validateConclusion } from './insight-text';
import { Lang } from './lean';

export const DEFAULT_INSIGHT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_REASONING_EFFORT = 'medium';
export const INSIGHT_LLM_TIMEOUT_MS = 90_000;
export const DEFAULT_REFRESH_MINUTES = 5;

export const INSIGHT_SYSTEM_PROMPT = [
    'You write the conclusion of the "AI Insights" panel for one market on a trading app. The input is JSON computed by rules, and every phrase you need is already written in it as a label, in en and zhCN. The other sections of the panel (timeframes, review, watch) come from templates, so you write the conclusion only.',
    "What the labels describe: the trend on each timeframe from 5m to 4h, the timeframes the panel's table lists. Before a 9 a new trend is forming; at 9 the trend is established and starts to fade, and the labels count the steps left to 13; at 13 the trend reverses. A 13's risk level checks that reading: a close past it means the trend did not reverse, so that 13 failed.",
    'Facts:',
    '- clauses: the conclusion, in order, as labels. Together they sum up every timeframe from 5m to 4h: one label per timeframe or per group of timeframes in the same stage and trend, the timeframe the panel follows first, then how it relates to other timeframes when it does.',
    'Write one conclusion in English (en) and in Simplified Chinese (zhCN), with the same content in both: every clause, in the order given.',
    'In zhCN, join the clauses with ； into one sentence and end it with 。; in en, write each clause as its own sentence ending with a period.',
    'Rules:',
    '- Copy every label word for word and in full, and leave none out; never rebuild a label from other fields, and add no facts of your own.',
    '- Copy every number exactly. Do not round, convert or compute anything, including how many steps are left. Write no times, dates or scores.',
    '- Speak only of trends. Never write a market-direction or bull/bear word: in zhCN never 偏多, 偏空, 看多, 看空, 看涨, 看跌, 多头, 空头, 多方, 空方, 利多, 利空, 多单, 空单, 做多, 做空, 转多, 转空, 翻多, 翻空, 开多, 开空, 多仓, 空仓, 唱多, 唱空, 追多, 追空, 多空, 牛, 熊 or 中性; in en never bullish, bearish, bull, bear, long, short or neutral.',
    "- Never write 顶部 or 底部 (en: top or bottom), step names (主线：, 重点：, Main line:, Focus:), pattern identifiers (near-exhaustion, relay-exhaustion, counter-move-ending, bounce-in-trend, thirteen-failed) or the input's field names (clauses).",
    '- Never name an indicator (DeMark, TD, Sequential, 九转). Never mention win rates, probabilities, confidence or guarantees, and never grade the verdict as weak, moderate or strong (弱、中等、强). Never tell the reader to open, buy or sell, and never forecast prices.',
    '- Write for beginners: never write Setup, Countdown or Risk Level; the labels already say how many steps are left.',
    '- zhCN uses no Latin letters other than timeframe labels and K线.',
    '- The en conclusion is at most 1000 characters; the zhCN conclusion is at most 400 characters.',
].join('\n');

export interface InsightLlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
    refreshMinutes: number;
}

export function readInsightLlmConfig(
    env: Record<string, string | undefined>,
    logger: Pick<Logger, 'info' | 'error'>,
): InsightLlmConfig | null {
    const rawUrl = env.INSIGHT_LLM_BASE_URL?.trim();
    const apiKey = env.INSIGHT_LLM_API_KEY?.trim();
    if (!rawUrl || !apiKey) {
        logger.info('[SIGNAL_INSIGHT] AI insight disabled: INSIGHT_LLM_BASE_URL / INSIGHT_LLM_API_KEY not set');
        return null;
    }
    if (!rawUrl.startsWith('https://')) {
        logger.error('[SIGNAL_INSIGHT] AI insight disabled: INSIGHT_LLM_BASE_URL must be https');
        return null;
    }
    let refreshMinutes = DEFAULT_REFRESH_MINUTES;
    const rawRefresh = env.INSIGHT_REFRESH_MINUTES;
    if (rawRefresh !== undefined && rawRefresh !== '') {
        if (/^[1-9]\d*$/.test(rawRefresh.trim())) {
            refreshMinutes = Number(rawRefresh.trim());
        } else {
            logger.error(
                `[SIGNAL_INSIGHT] Invalid INSIGHT_REFRESH_MINUTES "${rawRefresh}", using ${DEFAULT_REFRESH_MINUTES}`,
            );
        }
    }
    return {
        baseUrl: rawUrl.replace(/\/+$/, ''),
        apiKey,
        model: env.INSIGHT_LLM_MODEL?.trim() || DEFAULT_INSIGHT_MODEL,
        reasoningEffort: env.INSIGHT_LLM_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT,
        refreshMinutes,
    };
}

export type GenerateResult = { ok: true; sections: InsightText['sections'] } | { ok: false; reason: string };

const CONCLUSION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['conclusion'],
    properties: { conclusion: { type: 'string' } },
};

const RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['en', 'zhCN'],
    properties: { en: CONCLUSION_SCHEMA, zhCN: CONCLUSION_SCHEMA },
};

function field(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function extractOutputText(body: unknown): string | null {
    const output = field(body, 'output');
    if (!Array.isArray(output)) return null;
    for (const item of output) {
        const content = field(item, 'content');
        if (field(item, 'type') !== 'message' || !Array.isArray(content)) continue;
        for (const part of content) {
            const text = field(part, 'text');
            if (field(part, 'type') === 'output_text' && typeof text === 'string') return text;
        }
    }
    return null;
}

async function callGateway(
    input: LlmInput,
    templates: Record<Lang, TemplateSections>,
    config: InsightLlmConfig,
    fetchImpl: typeof fetch,
    controller: AbortController,
): Promise<GenerateResult> {
    const res = await fetchImpl(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
            model: config.model,
            reasoning: { effort: config.reasoningEffort },
            store: false,
            input: [
                { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify(llmPayload(input)) },
            ],
            text: {
                format: { type: 'json_schema', name: 'insight_conclusion', strict: true, schema: RESPONSE_SCHEMA },
            },
        }),
        signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body: unknown = await res.json();
    const status = field(body, 'status');
    if (status !== 'completed') return { ok: false, reason: `LLM response status ${String(status ?? 'unknown')}` };
    const text = extractOutputText(body);
    if (text === null) return { ok: false, reason: 'LLM response has no output_text' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'LLM output is not valid JSON' };
    }
    const v = validateConclusion(parsed, input);
    if (!v.ok) return { ok: false, reason: v.reason };
    const en: InsightSections = { conclusion: v.en, ...templates.en };
    const zhCN: InsightSections = { conclusion: v.zhCN, ...templates.zhCN };
    const ko: InsightSections = { conclusion: ruleConclusion('ko', input), ...templates.ko };
    const ja: InsightSections = { conclusion: ruleConclusion('ja', input), ...templates.ja };
    return { ok: true, sections: { en, zhCN, zhTW: toTraditional(zhCN), ko, ja } };
}

/** Never throws: every failure becomes { ok: false, reason }. */
export async function generateInsight(
    input: LlmInput,
    config: InsightLlmConfig,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = INSIGHT_LLM_TIMEOUT_MS,
): Promise<GenerateResult> {
    // The templates come first: when they can't be written there is no text to finish, so the LLM is skipped.
    let templates: Record<Lang, TemplateSections>;
    try {
        templates = templateSections(input.facts);
    } catch (err) {
        return { ok: false, reason: `template failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<GenerateResult>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({ ok: false, reason: `LLM timeout after ${timeoutMs}ms` });
        }, timeoutMs);
    });
    try {
        return await Promise.race([callGateway(input, templates, config, fetchImpl, controller), timeout]);
    } catch (err) {
        return { ok: false, reason: `LLM request failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
