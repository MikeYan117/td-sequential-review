// Closed Binance USD-M klines for DeMark chart markers.

import { isDecimalText } from './fixed-decimal';
import { DemarkInterval, DemarkLimit } from '../types/demark-types';

export const BINANCE_USDM_KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
/** Window sizes (closed bars) callers may ask for; Binance weight grows with size (500: 5, 1500: 10). */
export const DEMARK_LIMITS: readonly DemarkLimit[] = [500, 1000, 1500];
export const DEFAULT_DEMARK_LIMIT: DemarkLimit = 500;
/** A bar counts as closed this long after its close, leaving Binance time to fold in the last trades. */
export const SETTLE_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** Minimum pause on a Binance 429/418 before any symbol is requested again. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

export const INTERVAL_MS: Record<DemarkInterval, number> = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000
};

export interface KlineRow {
    openTime: number;
    high: string;
    low: string;
    close: string;
}

export interface FetchResponseLike {
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponseLike>;

/** Binance could not provide a usable closed-bar window; the route answers 503. */
export class KlineFetchError extends Error {
    constructor(message: string, readonly retryAfterMs: number | null = null) {
        super(message);
        this.name = 'KlineFetchError';
    }
}

/** On a 429/418, how long to back off: at least `RATE_LIMIT_COOLDOWN_MS`, or Binance's Retry-After if longer. */
function rateLimitRetryAfterMs(response: FetchResponseLike): number | null {
    if (response.status !== 429 && response.status !== 418) {
        return null;
    }
    const header = response.headers?.get('Retry-After') ?? null;
    const headerSeconds = header === null ? NaN : Number(header);
    if (!Number.isFinite(headerSeconds) || headerSeconds < 0) {
        return RATE_LIMIT_COOLDOWN_MS;
    }
    return Math.max(RATE_LIMIT_COOLDOWN_MS, headerSeconds * 1000);
}

export function isDemarkInterval(value: string): value is DemarkInterval {
    return Object.prototype.hasOwnProperty.call(INTERVAL_MS, value);
}

export function isDemarkLimit(value: number): value is DemarkLimit {
    return (DEMARK_LIMITS as readonly number[]).includes(value);
}

/** Open time of the newest bar that has closed and settled at `now`. */
export function lastClosedOpenTime(now: number, interval: DemarkInterval): number {
    const step = INTERVAL_MS[interval];
    return Math.floor((now - SETTLE_MS) / step) * step - step;
}

export async function fetchClosedKlines(
    symbol: string,
    interval: DemarkInterval,
    now: number,
    fetchImpl: FetchLike,
    limit: DemarkLimit
): Promise<KlineRow[]> {
    const lastOpen = lastClosedOpenTime(now, interval);
    const endTime = lastOpen + INTERVAL_MS[interval] - 1;
    const url =
        `${BINANCE_USDM_KLINES_URL}?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    let body: unknown;
    try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new KlineFetchError(`Binance klines HTTP ${response.status}`, rateLimitRetryAfterMs(response));
        }
        body = await response.json();
    } catch (error) {
        if (error instanceof KlineFetchError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error ? error.cause : undefined;
        const causeCode =
            typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
                ? cause.code
                : null;
        throw new KlineFetchError(
            `Binance klines request failed: ${message}${causeCode !== null ? ` (${causeCode})` : ''}`
        );
    }
    return parseKlines(body, interval, lastOpen);
}

/** Validates Binance's raw kline arrays: aligned, contiguous, decimal prices, ending at `expectedLastOpen`. */
export function parseKlines(body: unknown, interval: DemarkInterval, expectedLastOpen: number): KlineRow[] {
    if (!Array.isArray(body) || body.length === 0) {
        throw new KlineFetchError('Binance klines: empty or non-array response');
    }
    const step = INTERVAL_MS[interval];
    const rows = body.map((raw: unknown, i): KlineRow => {
        if (!Array.isArray(raw)) {
            throw new KlineFetchError(`Binance klines: row ${i} is not an array`);
        }
        const [openTime, , high, low, close] = raw as unknown[];
        if (typeof openTime !== 'number' || !Number.isSafeInteger(openTime) || openTime % step !== 0) {
            throw new KlineFetchError(`Binance klines: row ${i} open time ${String(openTime)} is not aligned to ${interval}`);
        }
        if (typeof high !== 'string' || typeof low !== 'string' || typeof close !== 'string' ||
            !isDecimalText(high) || !isDecimalText(low) || !isDecimalText(close)) {
            throw new KlineFetchError(`Binance klines: row ${i} has a non-decimal price`);
        }
        return { openTime, high, low, close };
    });
    for (let i = 1; i < rows.length; i++) {
        const previous = rows[i - 1];
        const current = rows[i];
        if (previous && current && current.openTime - previous.openTime !== step) {
            throw new KlineFetchError(`Binance klines: gap before ${current.openTime}`);
        }
    }
    const lastRow = rows[rows.length - 1];
    if (!lastRow || lastRow.openTime !== expectedLastOpen) {
        throw new KlineFetchError(
            `Binance klines: last bar ${lastRow?.openTime} is not the expected closed bar ${expectedLastOpen}`
        );
    }
    return rows;
}
