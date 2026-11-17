import { Logger } from '../../../shared/utils/logger';
import { DemarkChartResponse, DemarkInterval, DemarkLimit } from '../types/demark-types';
import {
    FetchLike,
    INTERVAL_MS,
    KlineFetchError,
    KlineRow,
    SETTLE_MS,
    fetchClosedKlines
} from './binance-klines';
import { projectChart } from './chart';
import { evaluateSequential } from './engine';
import { scaleRows } from './fixed-decimal';
import { DEMARK_SYMBOLS } from './symbols';

/** Failed windows are remembered this long so chart polling cannot hammer Binance during an outage. */
export const FAILURE_TTL_MS = 5_000;

export interface DemarkChartSource {
    isSupportedSymbol(symbol: string): boolean;
    getChart(symbol: string, interval: DemarkInterval, limit: DemarkLimit): Promise<DemarkChartResponse>;
}

export interface DemarkServiceOptions {
    fetchImpl?: FetchLike;
    now?: () => number;
    symbols?: ReadonlySet<string>;
}

interface CacheEntry {
    expiresAt: number;
    value: Promise<DemarkChartResponse>;
}

export function buildChart(symbol: string, interval: DemarkInterval, rows: readonly KlineRow[]): DemarkChartResponse {
    const first = rows[0];
    const lastRow = rows[rows.length - 1];
    if (!first || !lastRow) {
        throw new Error('buildChart needs at least one bar');
    }
    const { scale, bars } = scaleRows(rows);
    const projection = projectChart(evaluateSequential(bars), rows.map((row) => row.openTime), scale);
    return {
        symbol,
        interval,
        source: 'binance-usdm',
        ruleset: 'td-sequential-v2',
        bars: rows.length,
        firstBarTime: first.openTime,
        lastClosedBarTime: lastRow.openTime,
        nextUpdateAt: lastRow.openTime + 2 * INTERVAL_MS[interval] + SETTLE_MS,
        ...projection
    };
}

/** Per-process cache: one Binance request per (symbol, interval, limit) per closed bar. */
export class DemarkService implements DemarkChartSource {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly symbols: ReadonlySet<string>;
    // Set on a Binance 429/418: every symbol pauses Binance requests until this time.
    private blockedUntil = 0;

    constructor(private readonly logger: Pick<Logger, 'warn' | 'error'>, options: DemarkServiceOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? Date.now;
        this.symbols = options.symbols ?? DEMARK_SYMBOLS;
    }

    isSupportedSymbol(symbol: string): boolean {
        return this.symbols.has(symbol);
    }

    getChart(symbol: string, interval: DemarkInterval, limit: DemarkLimit): Promise<DemarkChartResponse> {
        if (!this.isSupportedSymbol(symbol)) {
            return Promise.reject(new Error(`Unsupported DeMark symbol: ${symbol}`));
        }
        const now = this.now();
        if (now < this.blockedUntil) {
            return Promise.reject(
                new KlineFetchError(
                    `Binance rate limited; retrying after ${new Date(this.blockedUntil).toISOString()}`,
                    this.blockedUntil - now
                )
            );
        }
        const key = `${symbol}:${interval}:${limit}`;
        const cached = this.cache.get(key);
        if (cached && now < cached.expiresAt) {
            return cached.value;
        }
        const value = fetchClosedKlines(symbol, interval, now, this.fetchImpl, limit).then((rows) =>
            buildChart(symbol, interval, rows)
        );
        // In flight: concurrent callers share this request until it settles.
        const entry: CacheEntry = { expiresAt: Number.POSITIVE_INFINITY, value };
        this.cache.set(key, entry);
        value.then(
            (chart) => {
                entry.expiresAt = chart.nextUpdateAt;
            },
            (error: unknown) => {
                if (error instanceof KlineFetchError && error.retryAfterMs !== null) {
                    this.blockedUntil = Math.max(this.blockedUntil, this.now() + error.retryAfterMs);
                    entry.expiresAt = this.blockedUntil;
                    this.logger.warn('[DEMARK] Binance klines unavailable', {
                        symbol,
                        interval,
                        limit,
                        reason: error.message,
                        retryAfterMs: error.retryAfterMs
                    });
                } else if (error instanceof KlineFetchError) {
                    entry.expiresAt = this.now() + FAILURE_TTL_MS;
                    this.logger.warn('[DEMARK] Binance klines unavailable', { symbol, interval, limit, reason: error.message });
                } else {
                    entry.expiresAt = this.now() + FAILURE_TTL_MS;
                    this.logger.error('[DEMARK] Chart computation failed', error instanceof Error ? error : new Error(String(error)), { symbol, interval, limit });
                }
            }
        );
        return value;
    }
}
