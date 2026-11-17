// Print exactly what the API returns in `data.charts[i]` for one symbol and interval.
//
// Live (same Binance request and code path as production):
//   npm run chart -- BTCUSDC 4h [limit=500]
// From a local file, as the API would have answered when `--end` was the newest closed bar:
//   npm run chart -- --file data/BTCUSDC-4h.json [--end <openTime ms>] [--limit 500]

import { fetchClosedKlines, isDemarkInterval, isDemarkLimit } from '../src/services/manager/demark/binance-klines';
import { buildChart } from '../src/services/manager/demark/demark-service';
import { DemarkLimit } from '../src/services/manager/types/demark-types';
import { parseArgs, readKlineFile } from './klines-file';

function toLimit(raw: string | undefined): DemarkLimit {
    const limit = Number(raw ?? 500);
    if (!isDemarkLimit(limit)) {
        throw new Error(`limit must be 500, 1000 or 1500, got ${raw}`);
    }
    return limit;
}

async function main(): Promise<void> {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const file = flags.get('file');
    if (file) {
        const { symbol, interval, rows } = readKlineFile(file);
        const limit = toLimit(flags.get('limit'));
        const endRaw = flags.get('end');
        const endIndex = endRaw === undefined ? rows.length - 1 : rows.findIndex((r) => r.openTime === Number(endRaw));
        if (endIndex < 0) {
            throw new Error(`--end ${endRaw} is not an open time in ${file}`);
        }
        const window = rows.slice(Math.max(0, endIndex - limit + 1), endIndex + 1);
        console.log(JSON.stringify(buildChart(symbol, interval, window), null, 2));
        return;
    }
    const [symbol, interval, rawLimit] = positional;
    if (!symbol || !interval || !isDemarkInterval(interval)) {
        throw new Error('Usage: npm run chart -- SYMBOL INTERVAL [limit]  |  npm run chart -- --file PATH [--end MS] [--limit N]');
    }
    const limit = toLimit(rawLimit);
    const rows = await fetchClosedKlines(symbol, interval, Date.now(), fetch, limit);
    console.log(JSON.stringify(buildChart(symbol, interval, rows), null, 2));
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
