// Backtest 9 and 13 markers on a local kline file.
//
//   npm run backtest -- --file data/BTCUSDC-4h.json [--window 500] [--horizons 1,3,6,12,24] [--json]
//
// --window 0     evaluate the whole file once; every setup9 / countdown13 marker is a signal.
// --window N     replay production: at each closed bar, compute the chart on the last N bars (what the
//                API served then) and take the setup9 / countdown13 markers that appear on that newest bar.
//                Also counts markers that vanish from one bar to the next while still inside the window.
//
// Return is measured from the signal bar's close to the close h bars later, signed by the expected
// direction (buy = up, sell = down). Hit rate = share of signals with a positive signed return.

import { projectChart } from '../src/services/manager/demark/chart';
import { evaluateSequential } from '../src/services/manager/demark/engine';
import { scaleRows } from '../src/services/manager/demark/fixed-decimal';
import { KlineRow } from '../src/services/manager/demark/binance-klines';
import { DemarkMarker } from '../src/services/manager/types/demark-types';
import { parseArgs, readKlineFile } from './klines-file';

type SignalKind = 'setup9' | 'countdown13';

interface Signal {
    index: number;
    kind: SignalKind;
    side: 'buy' | 'sell';
    perfected?: boolean;
}

function markersOf(rows: readonly KlineRow[]): DemarkMarker[] {
    const { scale, bars } = scaleRows(rows);
    return projectChart(evaluateSequential(bars), rows.map((r) => r.openTime), scale).markers;
}

function isSignal(m: DemarkMarker): m is Extract<DemarkMarker, { kind: SignalKind }> {
    return m.kind === 'setup9' || m.kind === 'countdown13';
}

function toSignal(m: Extract<DemarkMarker, { kind: SignalKind }>, index: number): Signal {
    return m.kind === 'setup9'
        ? { index, kind: m.kind, side: m.side, perfected: m.perfected }
        : { index, kind: m.kind, side: m.side };
}

function collect(rows: readonly KlineRow[], window: number): { signals: Signal[]; vanished: number } {
    const indexByTime = new Map(rows.map((r, i) => [r.openTime, i]));
    if (window <= 0) {
        const signals = markersOf(rows)
            .filter(isSignal)
            .map((m) => toSignal(m, indexByTime.get(m.time) as number));
        return { signals, vanished: 0 };
    }
    const signals: Signal[] = [];
    let vanished = 0;
    let previous = new Set<string>();
    for (let t = window - 1; t < rows.length; t++) {
        const start = t - window + 1;
        const markers = markersOf(rows.slice(start, t + 1)).filter(isSignal);
        const current = new Set(markers.map((m) => `${m.time}|${m.kind}|${m.side}`));
        const windowStart = (rows[start] as KlineRow).openTime;
        for (const key of previous) {
            if (Number(key.split('|')[0]) >= windowStart && !current.has(key)) {
                vanished++;
            }
        }
        previous = current;
        const newest = (rows[t] as KlineRow).openTime;
        for (const m of markers) {
            if (m.time === newest) {
                signals.push(toSignal(m, t));
            }
        }
    }
    return { signals, vanished };
}

function main(): void {
    const { flags } = parseArgs(process.argv.slice(2));
    const file = flags.get('file');
    if (!file) {
        throw new Error('Usage: npm run backtest -- --file data/SYMBOL-INTERVAL.json [--window 500] [--horizons 1,3,6,12,24] [--json]');
    }
    const window = Number(flags.get('window') ?? 0);
    const horizons = (flags.get('horizons') ?? '1,3,6,12,24').split(',').map(Number);
    const { symbol, interval, rows } = readKlineFile(file);
    const closes = rows.map((r) => Number(r.close));
    const { signals, vanished } = collect(rows, window);

    const groups = new Map<string, Signal[]>();
    for (const s of signals) {
        const keys = [`${s.kind} ${s.side}`, s.kind];
        if (s.kind === 'setup9') keys.push(`setup9 ${s.perfected ? 'perfected' : 'plain'}`);
        for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const summary = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, list]) => ({
            group,
            signals: list.length,
            horizons: horizons.map((h) => {
                const returns = list.flatMap((s) => {
                    const exit = closes[s.index + h];
                    const entry = closes[s.index] as number;
                    if (exit === undefined) return [];
                    return [((exit / entry - 1) * (s.side === 'buy' ? 1 : -1)) * 100];
                });
                const n = returns.length;
                return {
                    h,
                    n,
                    hitRate: n ? returns.filter((r) => r > 0).length / n : null,
                    meanPct: n ? returns.reduce((a, b) => a + b, 0) / n : null
                };
            })
        }));

    const report = { symbol, interval, bars: rows.length, window, vanishedMarkers: vanished, summary };
    if (flags.has('json')) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    console.log(`${symbol} ${interval}: ${rows.length} bars, window=${window || 'full'}, vanished markers=${vanished}`);
    for (const g of summary) {
        const cells = g.horizons
            .map((x) => `h${x.h}: ${x.hitRate === null ? '-' : (x.hitRate * 100).toFixed(1)}% / ${x.meanPct === null ? '-' : x.meanPct.toFixed(2)}%`)
            .join('  ');
        console.log(`${g.group.padEnd(20)} n=${String(g.signals).padStart(4)}  ${cells}`);
    }
}

try {
    main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
