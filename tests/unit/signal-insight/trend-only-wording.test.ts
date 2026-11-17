import * as OpenCC from 'opencc-js';
import { analyzeWindow, WindowAnalysis } from '../../../src/services/manager/demark/summary';
import { INSIGHT_INTERVALS, InsightInterval } from '../../../src/services/manager/types/insight-types';
import { templateSections } from '../../../src/services/sync/signal-insight/insight-template';
import { DIRECTION_WORDS, conclusionClauses, llmPayload, toTraditional } from '../../../src/services/sync/signal-insight/insight-text';
import { assembleSnapshot } from '../../../src/services/sync/signal-insight/snapshot';
import { SIGNAL_SYMBOLS, SignalSymbol } from '../../../src/services/sync/signal-push/symbols';
import { loadJson, toRows } from '../demark/helpers';

// 2026-10-16 product requirement: the panel speaks only of trends. Every string a reader sees, and everything the
// model is shown, is replayed over the fixtures and checked for bull/bear and long/short words. Since R36 the
// conclusion must also name every timeframe from 5m to 4h, and never 1d.

const toTw = OpenCC.Converter({ from: 'cn', to: 'twp' });
const zhWords = DIRECTION_WORDS.zhCN.source.split('|');
const ZH_TW = new RegExp([...new Set([...zhWords, ...zhWords.map((w) => toTw(w))])].join('|'));

function symbolOf(klineSymbol: string): SignalSymbol {
    const symbol = SIGNAL_SYMBOLS.find((s) => s.klineSymbol === klineSymbol);
    if (symbol === undefined) {
        throw new Error(`${klineSymbol} is not a signal symbol`);
    }
    return symbol;
}

function expectNoDirection(where: string, text: { en?: string; zhCN?: string; zhTW?: string }): void {
    for (const [lang, re] of [
        ['en', DIRECTION_WORDS.en],
        ['zhCN', DIRECTION_WORDS.zhCN],
        ['zhTW', ZH_TW],
    ] as const) {
        const value = text[lang];
        if (value === undefined) continue;
        const hit = re.exec(value);
        if (hit) throw new Error(`${where} ${lang} says "${hit[0]}": ${value}`);
    }
}

describe('trend-only wording', () => {
    test.each(['btcusdc', 'nvdausdt', 'xauusdt'])('%s, as of each of the last 100 closes of every timeframe', (name) => {
        const symbol = symbolOf(name.toUpperCase());
        const klines = loadJson(`insight-compose-${name}.json`).windows;
        const full = {} as Record<InsightInterval, WindowAnalysis>;
        for (const interval of INSIGHT_INTERVALS) {
            full[interval] = analyzeWindow(toRows(klines[interval]), interval);
        }
        let replays = 0;
        for (const interval of INSIGHT_INTERVALS) {
            const rows = toRows(klines[interval]);
            for (let bars = rows.length - 99; bars <= rows.length; bars++) {
                const windows = { ...full, [interval]: analyzeWindow(rows.slice(0, bars), interval) };
                const { snapshot, input } = assembleSnapshot(symbol, windows);
                const where = `${name} ${interval}@${bars}`;
                const sections = templateSections(input.facts);
                const zhTW = toTraditional({ conclusion: '', ...sections.zhCN });
                for (const key of ['timeframes', 'review', 'watch'] as const) {
                    expectNoDirection(`${where} ${key}`, { en: sections.en[key], zhCN: sections.zhCN[key], zhTW: zhTW[key] });
                }
                const clauses = conclusionClauses(input);
                for (const label of clauses) {
                    expectNoDirection(`${where} label`, { ...label, zhTW: toTw(label.zhCN) });
                }
                // R36: the conclusion sums up every timeframe the table lists, and nothing else.
                const said = clauses.map((c) => c.zhCN).join('；');
                expect(input.facts.structures.map((s) => s.interval)).toEqual(['5m', '15m', '1h', '4h']);
                for (const { interval } of input.facts.structures) {
                    if (!new RegExp(`(?<![0-9A-Za-z])${interval}[ 、]`).test(said)) {
                        throw new Error(`${where}: the conclusion leaves out ${interval}: ${said}`);
                    }
                }
                expect(said).not.toContain('1d');
                expect(snapshot.card.anchorInterval).not.toBe('1d');
                const payload = JSON.stringify(llmPayload(input));
                expectNoDirection(`${where} payload`, { en: payload, zhCN: payload });
                expectNoDirection(`${where} headline`, snapshot.card.phase.title);
                replays++;
            }
        }
        expect(replays).toBe(500);
    });
});
