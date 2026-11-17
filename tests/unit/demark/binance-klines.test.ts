import {
    BINANCE_USDM_KLINES_URL,
    FetchLike,
    KlineFetchError,
    fetchClosedKlines,
    isDemarkInterval,
    isDemarkLimit,
    lastClosedOpenTime,
    parseKlines
} from '../../../src/services/manager/demark/binance-klines';

const HOUR = 3_600_000;
const LAST = Date.UTC(2026, 8, 28, 15); // the 15:00 bar
const NOW = LAST + HOUR + 5_000; // 16:00:05, that bar has settled

/** A raw Binance USD-M kline array. */
function raw(openTime: number, close = '100.5'): unknown[] {
    return [openTime, '100', '101.25', '99.75', close, '12.5', openTime + HOUR - 1, '1260', 42, '6', '630', '0'];
}

const closedWindow = (): unknown[][] => [raw(LAST - 2 * HOUR), raw(LAST - HOUR), raw(LAST)];

describe('lastClosedOpenTime', () => {
    it('counts a bar as closed two seconds after its close', () => {
        expect(lastClosedOpenTime(NOW, '1h')).toBe(LAST);
        expect(lastClosedOpenTime(LAST + HOUR + 1_999, '1h')).toBe(LAST - HOUR);
        expect(lastClosedOpenTime(LAST + HOUR + 2_000, '1h')).toBe(LAST);
        expect(lastClosedOpenTime(Date.UTC(2026, 8, 29, 0, 0, 3), '1d')).toBe(Date.UTC(2026, 8, 28));
    });
});

describe('isDemarkInterval', () => {
    it('accepts only the chart intervals', () => {
        expect(['1m', '5m', '15m', '1h', '4h', '1d'].every(isDemarkInterval)).toBe(true);
        expect(['2h', '1w', '4H', '', 'toString', '__proto__'].some(isDemarkInterval)).toBe(false);
    });
});

describe('isDemarkLimit', () => {
    it('accepts only the 500, 1000 and 1500 bar windows', () => {
        expect([500, 1000, 1500].every(isDemarkLimit)).toBe(true);
        expect([499, 0, 750, 2000, NaN].some(isDemarkLimit)).toBe(false);
    });
});

describe('parseKlines', () => {
    it('keeps the open time and decimal prices of a contiguous closed window', () => {
        expect(parseKlines(closedWindow(), '1h', LAST)).toEqual([
            { openTime: LAST - 2 * HOUR, high: '101.25', low: '99.75', close: '100.5' },
            { openTime: LAST - HOUR, high: '101.25', low: '99.75', close: '100.5' },
            { openTime: LAST, high: '101.25', low: '99.75', close: '100.5' }
        ]);
    });

    it.each<[string, unknown, RegExp]>([
        ['an empty response', [], /empty or non-array/],
        ['a Binance error object', { code: -1121, msg: 'Invalid symbol.' }, /empty or non-array/],
        ['a row that is not an array', ['x'], /row 0 is not an array/],
        ['a gap', [raw(LAST - 2 * HOUR), raw(LAST)], /gap before/],
        ['a misaligned open time', [raw(LAST + 1)], /not aligned to 1h/],
        ['a non-decimal price', [raw(LAST, '1e5')], /non-decimal price/],
        ['a window that stops before the expected bar', [raw(LAST - 2 * HOUR), raw(LAST - HOUR)], /expected closed bar/]
    ])('rejects %s', (_name, body, message) => {
        expect(() => parseKlines(body, '1h', LAST)).toThrow(KlineFetchError);
        expect(() => parseKlines(body, '1h', LAST)).toThrow(message);
    });
});

describe('fetchClosedKlines', () => {
    it('requests the chosen number of closed bars ending at the last settled bar', async () => {
        const urls: string[] = [];
        const signals: unknown[] = [];
        const fetchImpl: FetchLike = async (url, init) => {
            urls.push(url);
            signals.push(init.signal);
            return { ok: true, status: 200, json: async () => closedWindow() };
        };
        const rows = await fetchClosedKlines('BTCUSDC', '1h', NOW, fetchImpl, 500);
        expect(urls).toEqual([
            `${BINANCE_USDM_KLINES_URL}?symbol=BTCUSDC&interval=1h&endTime=${LAST + HOUR - 1}&limit=500`
        ]);
        await fetchClosedKlines('BTCUSDC', '1h', NOW, fetchImpl, 1500);
        expect(urls[1]).toContain('&limit=1500');
        expect(rows.map((r) => r.openTime)).toEqual([LAST - 2 * HOUR, LAST - HOUR, LAST]);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it('turns HTTP errors and network failures into KlineFetchError', async () => {
        const limited: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
        await expect(fetchClosedKlines('BTCUSDC', '1h', NOW, limited, 500)).rejects.toThrow('Binance klines HTTP 429');

        const timedOut: FetchLike = async () => {
            throw new Error('The operation was aborted due to timeout');
        };
        await expect(fetchClosedKlines('BTCUSDC', '1h', NOW, timedOut, 500)).rejects.toThrow(KlineFetchError);
        await expect(fetchClosedKlines('BTCUSDC', '1h', NOW, timedOut, 500)).rejects.toThrow(
            'Binance klines request failed: The operation was aborted due to timeout'
        );
    });

    it('appends the cause code for network failures', async () => {
        const refused: FetchLike = async () => {
            throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        };
        await expect(fetchClosedKlines('BTCUSDC', '1h', NOW, refused, 500)).rejects.toThrow(
            'Binance klines request failed: fetch failed (ECONNREFUSED)'
        );
    });

    it.each<[number, string | null, number | null]>([
        [429, '120', 120_000],
        [418, null, 60_000],
        [500, null, null]
    ])('sets retryAfterMs for HTTP %i with Retry-After %p', async (status, retryAfter, expected) => {
        const fetchImpl: FetchLike = async () => ({
            ok: false,
            status,
            headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
            json: async () => ({})
        });
        let caught: unknown;
        try {
            await fetchClosedKlines('BTCUSDC', '1h', NOW, fetchImpl, 500);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(KlineFetchError);
        expect((caught as InstanceType<typeof KlineFetchError>).retryAfterMs).toBe(expected);
    });
});
