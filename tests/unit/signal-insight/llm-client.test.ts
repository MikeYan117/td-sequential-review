import {
    DEFAULT_INSIGHT_MODEL,
    generateInsight,
    INSIGHT_SYSTEM_PROMPT,
    InsightLlmConfig,
    readInsightLlmConfig,
} from '../../../src/services/sync/signal-insight/llm-client';
import { llmPayload, LlmInput, ruleConclusion, toTraditional } from '../../../src/services/sync/signal-insight/insight-text';
import * as template from '../../../src/services/sync/signal-insight/insight-template';

const input: LlmInput = {
    symbol: 'BTCUSDC',
    card: { direction: 'bullish', anchorInterval: '1h' },
    facts: {
        structures: [
            {
                interval: '1h', close: '82900.1', trend: 'down', stage: 'exhausted', setupStep: 9, countdown: 13,
                formingOpposite: null, timeline: [], thirteenFailed: false, lean: 'bullish',
            },
            {
                interval: '4h', close: '82900.1', trend: 'down', stage: 'established', setupStep: 9, countdown: 6,
                formingOpposite: null, timeline: [], thirteenFailed: false, lean: 'bearish',
            },
        ],
        live13: [
            {
                interval: '1h', side: 'buy', barsAgo: 3, price: '82800', riskLevel: '82831.5',
                intact: true, roomPct: '0.23', sincePct: '-0.01', oppositeSetup: 2,
            },
        ],
        review: [],
        reviewPick: null,
        focus: [],
        mainLine: null,
    },
};

const config: InsightLlmConfig = {
    baseUrl: 'https://gw.example/v1', apiKey: 'k-secret', model: 'gpt-6.1-sol', reasoningEffort: 'medium', refreshMinutes: 5,
};

const goodOut = {
    en: {
        conclusion: 'The 1h downtrend has reversed, still valid. The 4h downtrend is fading, 7 steps from a reversal.',
    },
    zhCN: { conclusion: '1h 下跌趋势反转确立，信号仍有效；4h 下跌趋势正在衰减，离反转还差 7 步。' },
};

function okResponse(text: string, status = 'completed'): any {
    return {
        ok: true,
        status: 200,
        json: async () => ({ status, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
    };
}

function logger() {
    return { info: jest.fn(), error: jest.fn() };
}

describe('readInsightLlmConfig', () => {
    it('returns null with an info log when URL or key is missing', () => {
        const l = logger();
        expect(readInsightLlmConfig({}, l)).toBeNull();
        expect(l.info).toHaveBeenCalledWith(
            '[SIGNAL_INSIGHT] AI insight disabled: INSIGHT_LLM_BASE_URL / INSIGHT_LLM_API_KEY not set',
        );
        expect(readInsightLlmConfig({ INSIGHT_LLM_BASE_URL: 'https://a/v1' }, logger())).toBeNull();
    });

    it('rejects http URLs with an error log', () => {
        const l = logger();
        expect(readInsightLlmConfig({ INSIGHT_LLM_BASE_URL: 'http://a/v1', INSIGHT_LLM_API_KEY: 'k' }, l)).toBeNull();
        expect(l.error).toHaveBeenCalled();
    });

    it('strips trailing slash and applies defaults', () => {
        const c = readInsightLlmConfig({ INSIGHT_LLM_BASE_URL: 'https://a/v1/', INSIGHT_LLM_API_KEY: 'k' }, logger());
        expect(c).toEqual({
            baseUrl: 'https://a/v1', apiKey: 'k', model: DEFAULT_INSIGHT_MODEL, reasoningEffort: 'medium', refreshMinutes: 5,
        });
        expect(DEFAULT_INSIGHT_MODEL).toBe('gpt-6.1-sol');
    });

    it('falls back to 5 minutes on invalid INSIGHT_REFRESH_MINUTES', () => {
        const l = logger();
        const c = readInsightLlmConfig(
            { INSIGHT_LLM_BASE_URL: 'https://a/v1', INSIGHT_LLM_API_KEY: 'k', INSIGHT_REFRESH_MINUTES: 'abc' }, l,
        );
        expect(c?.refreshMinutes).toBe(5);
        expect(l.error).toHaveBeenCalled();
        const c2 = readInsightLlmConfig(
            { INSIGHT_LLM_BASE_URL: 'https://a/v1', INSIGHT_LLM_API_KEY: 'k', INSIGHT_REFRESH_MINUTES: '10' }, logger(),
        );
        expect(c2?.refreshMinutes).toBe(10);
    });
});

describe('INSIGHT_SYSTEM_PROMPT', () => {
    it('asks for the conclusion only, built from labels', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain('so you write the conclusion only');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('every phrase you need is already written in it as a label');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('Copy every label word for word and in full, and leave none out');
    });

    it('fails only a 13 on its risk level, never a 9', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain("A 13's risk level checks that reading");
        expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/9 or 13 failed/);
    });


    it('describes the trend on each timeframe, not a bull or bear lean', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain('the trend on each timeframe');
        expect(INSIGHT_SYSTEM_PROMPT).toContain(
            'Before a 9 a new trend is forming; at 9 the trend is established and starts to fade, and the labels count the steps left to 13; at 13 the trend reverses.',
        );
        expect(INSIGHT_SYSTEM_PROMPT).not.toContain('leans bullish');
        expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/reversal has appeared|reversal is confirmed/);
    });

    it('asks for every clause in order, one zhCN sentence joined with ； and ending with 。', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain('every clause, in the order given.');
        expect(INSIGHT_SYSTEM_PROMPT).toContain(
            'In zhCN, join the clauses with ； into one sentence and end it with 。; in en, write each clause as its own sentence ending with a period.',
        );
        expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/levels|大级别|小级别|Big level|Small level/);
    });

    it('gives the model no card direction and no closing, and forbids every direction word', () => {
        expect(INSIGHT_SYSTEM_PROMPT).not.toContain('closing');
        expect(INSIGHT_SYSTEM_PROMPT).not.toContain('card.direction');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('- Speak only of trends.');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('in en never bullish, bearish, bull, bear, long, short or neutral.');
    });

    it('sends no support or failures, and keeps zhCN to timeframe labels and K线', () => {
        expect(INSIGHT_SYSTEM_PROMPT).not.toContain('support');
        expect(INSIGHT_SYSTEM_PROMPT).not.toContain('failures');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('- zhCN uses no Latin letters other than timeframe labels and K线.');
    });

    it('writes for beginners, without Setup, Countdown or Risk Level', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain(
            '- Write for beginners: never write Setup, Countdown or Risk Level; the labels already say how many steps are left.',
        );
    });

    it('forbids the push words, step names, pattern identifiers, computing and forecasts', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain('Never write 顶部 or 底部 (en: top or bottom)');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('including how many steps are left');
        expect(INSIGHT_SYSTEM_PROMPT).toContain('never forecast prices');
        expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/opposingMain|focus\[/);
    });

    it('R36: describes the clauses as a summary of every timeframe from 5m to 4h, and forbids pattern identifiers', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain("the trend on each timeframe from 5m to 4h, the timeframes the panel's table lists.");
        expect(INSIGHT_SYSTEM_PROMPT).toContain('- clauses: the conclusion, in order, as labels. Together they sum up every timeframe from 5m to 4h');
        expect(INSIGHT_SYSTEM_PROMPT).toContain(
            'pattern identifiers (near-exhaustion, relay-exhaustion, counter-move-ending, bounce-in-trend, thirteen-failed)',
        );
        expect(INSIGHT_SYSTEM_PROMPT).toContain("the input's field names (clauses)");
        expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/mainLine|neutralReason|bigThirteens|1d/);
    });

    it('states the length limits the validator enforces', () => {
        expect(INSIGHT_SYSTEM_PROMPT).toContain('The en conclusion is at most 1000 characters; the zhCN conclusion is at most 400 characters.');
    });
});

describe('generateInsight', () => {
    it('sends the expected request', async () => {
        const f = jest.fn().mockResolvedValue(okResponse(JSON.stringify(goodOut)));
        await generateInsight(input, config, f as any);
        const [url, init] = f.mock.calls[0];
        expect(url).toBe('https://gw.example/v1/responses');
        expect(init.method).toBe('POST');
        expect(init.headers.authorization).toBe('Bearer k-secret');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('gpt-6.1-sol');
        expect(body.reasoning).toEqual({ effort: 'medium' });
        expect(body.store).toBe(false);
        expect(body.temperature).toBeUndefined();
        expect(body.input[0]).toEqual({ role: 'system', content: INSIGHT_SYSTEM_PROMPT });
        expect(body.input[1].content).toBe(JSON.stringify(llmPayload(input)));
        expect(body.text.format.type).toBe('json_schema');
        expect(body.text.format.strict).toBe(true);
        const schema = body.text.format.schema;
        expect(schema.required).toEqual(['en', 'zhCN']);
        for (const lang of ['en', 'zhCN']) {
            expect(schema.properties[lang]).toEqual({
                type: 'object',
                additionalProperties: false,
                required: ['conclusion'],
                properties: { conclusion: { type: 'string' } },
            });
        }
    });

    it('puts the model conclusion before the template sections, with zhTW converted from zhCN', async () => {
        const f = jest.fn().mockResolvedValue(okResponse(JSON.stringify(goodOut)));
        const r = await generateInsight(input, config, f as any);
        const tmpl = template.templateSections(input.facts);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.sections.en).toEqual({ conclusion: goodOut.en.conclusion, ...tmpl.en });
            expect(r.sections.zhCN).toEqual({ conclusion: goodOut.zhCN.conclusion, ...tmpl.zhCN });
            expect(r.sections.zhCN.timeframes).toBe(tmpl.zhCN.timeframes);
            expect(Object.keys(r.sections.zhCN)).toEqual(['conclusion', 'timeframes', 'review', 'watch']);
            expect(r.sections.zhTW).toEqual(toTraditional(r.sections.zhCN));
            expect(r.sections.ko).toEqual({ conclusion: ruleConclusion('ko', input), ...tmpl.ko });
            expect(r.sections.ja).toEqual({ conclusion: ruleConclusion('ja', input), ...tmpl.ja });
        }
    });

    it('fails without calling the gateway when a template throws', async () => {
        const spy = jest.spyOn(template, 'templateSections').mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const f = jest.fn().mockResolvedValue(okResponse(JSON.stringify(goodOut)));
        const r = await generateInsight(input, config, f as any);
        spy.mockRestore();
        expect(r).toEqual({ ok: false, reason: 'template failed: boom' });
        expect(f).not.toHaveBeenCalled();
    });

    it('fails on incomplete status', async () => {
        const f = jest.fn().mockResolvedValue(okResponse(JSON.stringify(goodOut), 'incomplete'));
        const r = await generateInsight(input, config, f as any);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('incomplete');
    });

    it('fails on HTTP 503', async () => {
        const f = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
        const r = await generateInsight(input, config, f as any);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('HTTP 503');
    });

    it('fails on timeout when fetch hangs', async () => {
        const f = jest.fn().mockReturnValue(new Promise(() => undefined));
        const r = await generateInsight(input, config, f as any, 10);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('timeout');
    });

    it('fails on non-JSON output and never throws on fetch rejection', async () => {
        const f = jest.fn().mockResolvedValue(okResponse('not json'));
        expect((await generateInsight(input, config, f as any)).ok).toBe(false);
        const g = jest.fn().mockRejectedValue(new Error('boom'));
        const r = await generateInsight(input, config, g as any);
        expect(r.ok).toBe(false);
    });

    it('returns the validation reason when validation fails', async () => {
        const bad = { ...goodOut, en: { conclusion: goodOut.en.conclusion.replace('still valid', 'still valid at 99999') } };
        const f = jest.fn().mockResolvedValue(okResponse(JSON.stringify(bad)));
        const r = await generateInsight(input, config, f as any);
        expect(r).toEqual({ ok: false, reason: 'en.conclusion has non-whitelisted number 99999' });
    });
});
