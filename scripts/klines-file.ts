// Local kline files used by the scripts: data/<SYMBOL>-<interval>.json.
// `klines` uses the test fixtures' encoding, [openTime ms, high, low, close], oldest first, plus the open price
// as an optional fifth element (only the chart viewer draws it; the algorithm never reads it).

import { readFileSync } from 'fs';
import {
    BINANCE_USDM_KLINES_URL,
    INTERVAL_MS,
    KlineRow,
    isDemarkInterval,
    lastClosedOpenTime
} from '../src/services/manager/demark/binance-klines';
import { DemarkInterval } from '../src/services/manager/types/demark-types';

export type KlineTuple = [number, string, string, string, string?];

export interface KlineFile {
    symbol: string;
    interval: DemarkInterval;
    klines: KlineTuple[];
}

export interface LoadedKlines {
    symbol: string;
    interval: DemarkInterval;
    rows: KlineRow[];
    /** Open price by open time, where the file has it. */
    opens: Map<number, string>;
}

export function toLoaded(file: KlineFile, source: string): LoadedKlines {
    if (!isDemarkInterval(file.interval)) {
        throw new Error(`${source}: unsupported interval ${String(file.interval)}`);
    }
    const rows = file.klines.map(([openTime, high, low, close]) => ({ openTime, high, low, close }));
    const step = INTERVAL_MS[file.interval];
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const row = rows[i];
        if (prev && row && row.openTime - prev.openTime !== step) {
            throw new Error(`${source}: gap between ${prev.openTime} and ${row.openTime}; the engine needs contiguous bars`);
        }
    }
    const opens = new Map<number, string>();
    for (const [openTime, , , , open] of file.klines) {
        if (open !== undefined) opens.set(openTime, open);
    }
    return { symbol: file.symbol, interval: file.interval, rows, opens };
}

export function readKlineFile(path: string): LoadedKlines {
    return toLoaded(JSON.parse(readFileSync(path, 'utf8')) as KlineFile, path);
}

/** The newest `wanted` closed Binance USD-M bars, oldest first, paging back 1500 at a time. */
export async function downloadKlines(symbol: string, interval: DemarkInterval, wanted: number): Promise<KlineFile> {
    const page = 1500;
    const step = INTERVAL_MS[interval];
    let cursor = lastClosedOpenTime(Date.now(), interval);
    const klines: KlineTuple[] = [];
    while (klines.length < wanted) {
        const limit = Math.min(page, wanted - klines.length);
        const url = `${BINANCE_USDM_KLINES_URL}?symbol=${symbol}&interval=${interval}&endTime=${cursor + step - 1}&limit=${limit}`;
        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
            throw new Error(
                `Cannot reach ${url} (${cause}). These scripts need network access to fapi.binance.com; ` +
                    'if you run inside a sandbox, allow network access and retry.'
            );
        }
        if (!response.ok) {
            throw new Error(`Binance HTTP ${response.status} for ${url}`);
        }
        const rows = (await response.json()) as [number, string, string, string, string][];
        if (rows.length === 0) {
            break;
        }
        klines.unshift(...rows.map(([openTime, open, high, low, close]): KlineTuple => [openTime, high, low, close, open]));
        const first = rows[0];
        if (!first || rows.length < limit) {
            break;
        }
        cursor = first[0] - step;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { symbol, interval, klines };
}

/** `--name value` style flags (a flag followed by another flag or nothing is `''`) plus positional arguments. */
export function parseArgs(argv: readonly string[]): { flags: Map<string, string>; positional: string[] } {
    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg.startsWith('--')) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags.set(arg.slice(2), '');
            } else {
                flags.set(arg.slice(2), next);
                i++;
            }
        } else {
            positional.push(arg);
        }
    }
    return { flags, positional };
}
