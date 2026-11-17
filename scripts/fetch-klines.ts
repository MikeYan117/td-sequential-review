// Download closed Binance USD-M klines into data/<SYMBOL>-<interval>.json for the other scripts.
// Usage: npm run fetch-klines -- BTCUSDC 4h [bars=5000]
//        npm run fetch-klines -- BTCUSDC 5m,15m,1h,4h,1d 5000   (one file per interval)

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { isDemarkInterval } from '../src/services/manager/demark/binance-klines';
import { downloadKlines } from './klines-file';

async function main(): Promise<void> {
    const [symbol, rawIntervals, rawBars = '5000'] = process.argv.slice(2);
    const intervals = (rawIntervals ?? '').split(',');
    if (!symbol || !intervals.every(isDemarkInterval)) {
        throw new Error('Usage: npm run fetch-klines -- SYMBOL INTERVAL[,INTERVAL...] (1m|5m|15m|1h|4h|1d) [bars]');
    }
    mkdirSync('data', { recursive: true });
    for (const interval of intervals) {
        const file = await downloadKlines(symbol, interval, Number(rawBars));
        const out = path.join('data', `${symbol}-${interval}.json`);
        writeFileSync(out, JSON.stringify(file));
        const first = file.klines[0];
        const last = file.klines[file.klines.length - 1];
        console.log(
            `${out}: ${file.klines.length} closed bars` +
                (first && last ? `, ${new Date(first[0]).toISOString()} .. ${new Date(last[0]).toISOString()}` : '')
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
