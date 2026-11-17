import {
    FetchLike,
    INTERVAL_MS,
    KlineFetchError,
    SETTLE_MS
} from '../../../src/services/manager/demark/binance-klines';
import { DemarkService, FAILURE_TTL_MS, buildChart } from '../../../src/services/manager/demark/demark-service';
import { DemarkInterval } from '../../../src/services/manager/types/demark-types';
import { BUY, HOUR } from './helpers';

const LAST = Date.UTC(2026, 8, 28, 15);
const NOW = LAST + HOUR + 5_000;

/** Binance double: answers every kline request with the BUY closes, ending at the requested endTime. */
function fakeBinance(options: { fail?: boolean } = {}) {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
        urls.push(url);
        if (options.fail) {
            return { ok: false, status: 502, json: async () => ({}) };
        }
        const query = new URL(url).searchParams;
        const step = INTERVAL_MS[query.get('interval') as DemarkInterval];
        const lastOpen = Number(query.get('endTime')) + 1 - step;
        const body = BUY.map((close, i) => [
            lastOpen - (BUY.length - 1 - i) * step,
            String(close),
            String(close + 1),
            String(close - 1),
            String(close),
            '0'
        ]);
        return { ok: true, status: 200, json: async () => body };
    };
    return { urls, fetchImpl };
}

const logger = () => ({ warn: jest.fn(), error: jest.fn() });

describe('buildChart', () => {
    it('describes the window and projects its markers', () => {
        const rows = BUY.map((close, i) => ({
            openTime: LAST - (BUY.length - 1 - i) * HOUR,
            high: String(close + 1),
            low: String(close - 1),
            close: String(close)
        }));
        const chart = buildChart('BTCUSDC', '1h', rows);
        expect(chart).toMatchObject({
            symbol: 'BTCUSDC',
            interval: '1h',
            source: 'binance-usdm',
            ruleset: 'td-sequential-v2',
            bars: 14,
            firstBarTime: LAST - 13 * HOUR,
            lastClosedBarTime: LAST,
            nextUpdateAt: LAST + 2 * HOUR + SETTLE_MS
        });
        expect(chart.markers).toEqual([
            { time: LAST, kind: 'setup9', side: 'buy', label: '9', perfected: true },
            { time: LAST, kind: 'countdownProgress', side: 'buy', label: '1', count: 1, deferred: false }
        ]);
    });
});

describe('DemarkService', () => {
    it('asks Binance once per closed bar', async () => {
        const binance = fakeBinance();
        let now = NOW;
        const service = new DemarkService(logger(), { fetchImpl: binance.fetchImpl, now: () => now });

        const first = await service.getChart('BTCUSDC', '1h', 500);
        await service.getChart('BTCUSDC', '1h', 500);
        now = first.nextUpdateAt - 1;
        await service.getChart('BTCUSDC', '1h', 500);
        expect(binance.urls).toHaveLength(1);

        now = first.nextUpdateAt;
        const next = await service.getChart('BTCUSDC', '1h', 500);
        expect(binance.urls).toHaveLength(2);
        expect(next.lastClosedBarTime).toBe(first.lastClosedBarTime + HOUR);
    });

    it('shares one request between concurrent callers and keys the cache by interval', async () => {
        const binance = fakeBinance();
        const service = new DemarkService(logger(), { fetchImpl: binance.fetchImpl, now: () => NOW });
        await Promise.all([
            service.getChart('BTCUSDC', '1h', 500),
            service.getChart('BTCUSDC', '1h', 500),
            service.getChart('BTCUSDC', '4h', 500)
        ]);
        expect(binance.urls).toHaveLength(2);
    });

    it('remembers a failure for five seconds and logs it once', async () => {
        const binance = fakeBinance({ fail: true });
        const log = logger();
        let now = NOW;
        const service = new DemarkService(log, { fetchImpl: binance.fetchImpl, now: () => now });

        await expect(service.getChart('BTCUSDC', '1h', 500)).rejects.toThrow(KlineFetchError);
        now += FAILURE_TTL_MS - 1;
        await expect(service.getChart('BTCUSDC', '1h', 500)).rejects.toThrow('Binance klines HTTP 502');
        expect(binance.urls).toHaveLength(1);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith('[DEMARK] Binance klines unavailable', {
            symbol: 'BTCUSDC',
            interval: '1h',
            limit: 500,
            reason: 'Binance klines HTTP 502'
        });

        now += 1;
        await expect(service.getChart('BTCUSDC', '1h', 500)).rejects.toThrow(KlineFetchError);
        expect(binance.urls).toHaveLength(2);
    });

    it('pauses every symbol on a Binance 429 until the cooldown ends, then retries all of them', async () => {
        let now = NOW;
        let calls = 0;
        const fetchImpl: FetchLike = async (url) => {
            calls++;
            if (calls === 1) {
                return {
                    ok: false,
                    status: 429,
                    headers: { get: (name: string) => (name === 'Retry-After' ? '120' : null) },
                    json: async () => ({})
                };
            }
            const query = new URL(url).searchParams;
            const step = INTERVAL_MS[query.get('interval') as DemarkInterval];
            const lastOpen = Number(query.get('endTime')) + 1 - step;
            const body = BUY.map((close, i) => [
                lastOpen - (BUY.length - 1 - i) * step,
                String(close),
                String(close + 1),
                String(close - 1),
                String(close),
                '0'
            ]);
            return { ok: true, status: 200, json: async () => body };
        };
        const log = logger();
        const service = new DemarkService(log, { fetchImpl, now: () => now });

        await expect(service.getChart('BTCUSDC', '1h', 500)).rejects.toThrow(KlineFetchError);
        expect(calls).toBe(1);
        expect(log.warn).toHaveBeenCalledWith('[DEMARK] Binance klines unavailable', {
            symbol: 'BTCUSDC',
            interval: '1h',
            limit: 500,
            reason: 'Binance klines HTTP 429',
            retryAfterMs: 120_000
        });

        now += 119_999; // still inside the 120s cooldown from the 429
        await expect(service.getChart('ETHUSDC', '4h', 500)).rejects.toThrow(KlineFetchError);
        expect(calls).toBe(1); // no fetch made for the other key
        expect(log.warn).toHaveBeenCalledTimes(1); // the blocked path logs nothing

        now += 1; // cooldown elapsed
        const btc = await service.getChart('BTCUSDC', '1h', 500);
        const eth = await service.getChart('ETHUSDC', '4h', 500);
        expect(calls).toBe(3);
        expect(btc.symbol).toBe('BTCUSDC');
        expect(eth.symbol).toBe('ETHUSDC');
    });

    it('keys the cache by window size and requests that many bars', async () => {
        const binance = fakeBinance();
        const service = new DemarkService(logger(), { fetchImpl: binance.fetchImpl, now: () => NOW });
        await service.getChart('BTCUSDC', '1h', 500);
        await service.getChart('BTCUSDC', '1h', 1000);
        await service.getChart('BTCUSDC', '1h', 500);
        expect(binance.urls.map((url) => new URL(url).searchParams.get('limit'))).toEqual(['500', '1000']);
    });

    it('rejects symbols outside the whitelist without calling Binance', async () => {
        const binance = fakeBinance();
        const service = new DemarkService(logger(), { fetchImpl: binance.fetchImpl, now: () => NOW });
        expect(service.isSupportedSymbol('BTCUSDC')).toBe(true);
        expect(service.isSupportedSymbol('SKHYNIXUSDT')).toBe(true);
        for (const symbol of ['ETHUSDT', 'SKHYUSDT', 'XAUUSDT', 'TQQQUSDT', 'CLUSDT', 'CRCLUSDT']) {
            expect(service.isSupportedSymbol(symbol)).toBe(true);
        }
        expect(service.isSupportedSymbol('BTCUSDT')).toBe(false);
        await expect(service.getChart('BTCUSDT', '1h', 500)).rejects.toThrow('Unsupported DeMark symbol: BTCUSDT');
        expect(binance.urls).toHaveLength(0);
    });
});
