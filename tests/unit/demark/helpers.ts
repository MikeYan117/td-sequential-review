import { readFileSync } from 'fs';
import path from 'path';
import { KlineRow } from '../../../src/services/manager/demark/binance-klines';
import { EngineResult } from '../../../src/services/manager/demark/engine';
import { PriceRow, fromScaled } from '../../../src/services/manager/demark/fixed-decimal';
import { DemarkTrend, Lean, TimeframeStructure } from '../../../src/services/manager/types/insight-types';

export const BUY = [100, 101, 102, 103, 104, 99, 98, 97, 96, 95, 94, 93, 92, 91];
export const HOUR = 3_600_000;

export function readFixture<T>(name: string): T {
    return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as T;
}

/** A Python-generated fixture read without a declared shape; tests compare its values with toEqual. */
export function loadJson(name: string): any {
    return readFixture<unknown>(name);
}

/** `[openTime, high, low, close]` tuples, the Binance fixtures' kline encoding. */
export function toRows(klines: readonly [number, string, string, string][]): KlineRow[] {
    return klines.map(([openTime, high, low, close]) => ({ openTime, high, low, close }));
}

/**
 * The lean a hand-built structure carries, by the reading table (R32): a 9 counting toward 13 leans with
 * its move, an intact exhausted move against it; forming and failed timeframes have none.
 */
export function readingLean(trend: DemarkTrend, stage: TimeframeStructure['stage'], thirteenFailed = false): Lean | null {
    if (stage === 'forming' || thirteenFailed) return null;
    if (stage === 'established') return trend === 'up' ? 'bullish' : 'bearish';
    return trend === 'up' ? 'bearish' : 'bullish';
}

/** `count` hourly bars whose high, low and close all equal `price`: no bar ever counts toward a setup. */
export function flatRows(count: number, price: string): KlineRow[] {
    return Array.from({ length: count }, (_, i) => ({ openTime: i * HOUR, high: price, low: price, close: price }));
}

/** Same shape as `sequences` in the Python-generated fixtures. */
export function sequencesView(result: EngineResult, scale: number): unknown[] {
    return result.sequences.map((s) => ({
        side: s.side,
        setup: s.setup,
        setupStatus: s.setupStatus,
        perfected: s.perfected,
        countdown: s.countdown,
        countdownStatus: s.countdownStatus,
        tdst: s.tdst === null ? null : fromScaled(s.tdst, scale),
        risk: s.risk === null ? null : fromScaled(s.risk, scale),
        riskStatus: s.riskStatus
    }));
}

/** `[kind, sequence, bar, count, reason]`, the Python fixtures' event encoding. */
export function eventTuples(result: EngineResult, options: { skipCounts?: boolean } = {}): unknown[][] {
    return result.events
        .filter((e) => !options.skipCounts || (e.kind !== 'setup_count' && e.kind !== 'countdown_count'))
        .map((e) => [e.kind, e.sequence, e.bar, e.count, e.reason]);
}

export interface SyntheticInput {
    closes: number[];
    lows?: number[] | null;
    highs?: number[] | null;
}

/** Synthetic bars: high = close + 1, low = close - 1 unless overridden. */
export function syntheticRows(input: SyntheticInput): PriceRow[] {
    return input.closes.map((close, i) => ({
        high: String(input.highs?.[i] ?? close + 1),
        low: String(input.lows?.[i] ?? close - 1),
        close: String(close)
    }));
}
