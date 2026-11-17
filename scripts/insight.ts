// Print the AI trend panel for one symbol: the card, and the conclusion / timeframes / review / watch texts.
//
// Live (each of 5m, 15m, 1h, 4h, 1d uses its last 500 closed bars, as the live service does):
//   npm run insight -- BTCUSDC
// As of a past moment, from local files data/<SYMBOL>-<interval>.json for all five intervals:
//   npm run insight -- BTCUSDC --at 2026-11-10T08:00:00Z
// Options: --lang zhCN|en|both (default zhCN), --json (full snapshot and texts),
//          --ref REF (run the algorithm as of git ref REF, e.g. `baseline`, instead of the working tree).
// --at T means: every window ends with its newest bar closed by T (at 08:00Z the newest 1h bar is the 07:00 one).
//
// The conclusion's content is computed by code (conclusionClauses); the live service has an LLM join those
// clauses into sentences. Without an LLM this script joins them by the same rule. With INSIGHT_LLM_BASE_URL and
// INSIGHT_LLM_API_KEY set in the shell or in .env (an OpenAI-compatible Responses API), it also asks the LLM,
// exactly as the live service does.

import { generateInsight, readInsightLlmConfig } from '../src/services/sync/signal-insight/llm-client';
import { loadDotEnv } from './env';
import { CURRENT, buildPanel, implAt, loadPanelRows, parseAt, signalSymbolOf } from './impl';
import { parseArgs } from './klines-file';

async function main(): Promise<void> {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const [klineSymbol] = positional;
    if (!klineSymbol) {
        throw new Error('Usage: npm run insight -- SYMBOL [--at ISO|ms] [--lang zhCN|en|both] [--json] [--ref REF]');
    }
    const at = flags.get('at');
    const rows = await loadPanelRows(klineSymbol, at === undefined ? null : parseAt(at));
    const ref = flags.get('ref') || null;
    const impl = ref === null ? CURRENT : implAt(ref);
    const { snapshot, input, conclusion, templates } = buildPanel(impl, signalSymbolOf(klineSymbol), rows);

    loadDotEnv();
    const llmConfig = readInsightLlmConfig(process.env, { info: () => undefined, error: (m) => console.error(m) });
    const llm = llmConfig === null ? null : await generateInsight(input, llmConfig);

    if (flags.has('json')) {
        console.log(JSON.stringify({ algorithm: impl.label, snapshot, conclusionRuleJoined: conclusion, templates, llm }, null, 2));
        return;
    }
    const langFlag = flags.get('lang') || 'zhCN';
    const langs: ('zhCN' | 'en')[] = langFlag === 'both' ? ['zhCN', 'en'] : langFlag === 'en' ? ['en'] : ['zhCN'];
    const { card } = snapshot;
    console.log(`${klineSymbol}  as of ${new Date(snapshot.asOf).toISOString()}  algorithm: ${impl.label}`);
    console.log(
        `card: ${card.direction}  strength ${card.strength} (${card.strengthLabel})  anchor ${card.anchorInterval ?? '-'}` +
            `  confluent [${card.confluentIntervals.join(', ')}]  conflicting [${card.conflictingIntervals.join(', ')}]`
    );
    if (card.protection) {
        const stop = card.protection.stop;
        console.log(
            `protection: ${card.protection.optionType} on ${card.protection.interval}, ${card.protection.durationSeconds / 3600}h` +
                (stop ? `, stop ${JSON.stringify(stop)}` : ', no stop')
        );
    }
    for (const lang of langs) {
        console.log(`\n[${lang}] ${card.phase.title[lang]}`);
        console.log(`conclusion (rule-joined): ${conclusion[lang]}`);
        if (llm !== null) {
            console.log(llm.ok ? `conclusion (LLM): ${llm.sections[lang].conclusion}` : `conclusion (LLM) failed: ${llm.reason}`);
        }
        console.log(`timeframes: ${templates[lang].timeframes}`);
        console.log(`review: ${templates[lang].review}`);
        console.log(`watch: ${templates[lang].watch}`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
});
