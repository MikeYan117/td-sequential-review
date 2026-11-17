/**
 * Protection suggestion: the hedge option the
 * DeMark signals suggest for a trade in the card's direction. It reads DeMark facts only (card
 * direction, the protected timeframe's structure, its 13 risk level or the 9's TDST), not volatility,
 * the clock or positions. The protected timeframe is the card's anchor, one of 5m to 4h (R36).
 * The option duration covers 8 bars of the protected timeframe, and moves shorter when the stop is nearer than
 * that duration's shallowest strike. Pure: no I/O and no clock.
 */

import { INTERVAL_MS } from './binance-klines';
import { fromScaled } from './fixed-decimal';
import { TimeframeInput, formatPct, trendThirteen, trimPrice } from './insight-facts';
import { DemarkSide } from '../types/demark-types';
import {
    CardProtection,
    CardStrength,
    InsightInterval,
    ProtectionStop,
    TimeframeStructure
} from '../types/insight-types';

/**
 * Offered option durations with their OTM strike bands in basis points (five evenly spaced strikes per
 * duration), shortest first.
 * 30m, 1H and 2H share one band, so shifting shorter picks 2H; the target duration is never shorter than
 * 1H, so 30m is never chosen.
 */
const OFFERED_DURATIONS: readonly { seconds: number; minBps: number; maxBps: number }[] = [
    { seconds: 1_800, minBps: 10, maxBps: 50 },
    { seconds: 3_600, minBps: 10, maxBps: 50 },
    { seconds: 7_200, minBps: 10, maxBps: 50 },
    { seconds: 14_400, minBps: 20, maxBps: 100 },
    { seconds: 28_800, minBps: 30, maxBps: 150 },
    { seconds: 43_200, minBps: 40, maxBps: 200 },
    { seconds: 86_400, minBps: 75, maxBps: 375 }
];

/** Bars of the protected timeframe the suggested option covers: 5m -> 1H, 15m -> 2H, 1h -> 8H, 4h -> 24H. */
const PROTECTION_BARS = 8;

/** The shortest offered duration covering `windowMs`, capped at the longest. */
function durationCovering(windowMs: number): number {
    const longest = OFFERED_DURATIONS[OFFERED_DURATIONS.length - 1] as { seconds: number };
    return OFFERED_DURATIONS.find((d) => d.seconds * 1000 >= windowMs)?.seconds ?? longest.seconds;
}

/**
 * The target duration, or a shorter one when the stop (in bps) is nearer than the target's shallowest strike: then
 * the longest duration whose strike band holds it. A stop beyond the target's deepest strike keeps the target (the
 * frontend picks its deepest strike); so does a distance below the shallowest offered strike, not positive, or a
 * null stop (the frontend picks ATM). Band edges count as fitting.
 */
export function durationFitting(targetSeconds: number, distanceBps: number | null): number {
    const target = OFFERED_DURATIONS.find((d) => d.seconds === targetSeconds);
    if (target === undefined) {
        throw new Error(`Unknown option duration ${targetSeconds}`);
    }
    if (distanceBps === null || distanceBps < 10 || distanceBps >= target.minBps) {
        return targetSeconds;
    }
    // Bands widen with the duration, so the durations holding a stop nearer than the target's band are all shorter.
    const fitting = OFFERED_DURATIONS.filter((d) => d.minBps <= distanceBps && distanceBps <= d.maxBps);
    return (fitting[fitting.length - 1] as { seconds: number }).seconds;
}

/**
 * The stop follows the protected timeframe's structure. An exhausted move stops at the risk level of its
 * intact 13. A move still counting from its 9 stops at that 9's TDST: it is the price whose break
 * cancels the countdown, and it sits on the far side of price from the move.
 */
function stopPrice({ analysis }: TimeframeInput, structure: TimeframeStructure): { signal: 9 | 13; price: string } | null {
    const { summary } = analysis;
    if (summary === null) {
        throw new Error(`Protected timeframe ${analysis.interval} has no DeMark summary`);
    }
    if (structure.stage === 'exhausted') {
        const seq = trendThirteen(analysis, structure.trend)?.signal.seq;
        // A broken risk level means the 13 has failed and no longer marks a stop.
        if (seq === undefined || seq.risk === null || seq.riskStatus === 'invalidated') {
            return null;
        }
        return { signal: 13, price: fromScaled(seq.risk, analysis.scale) };
    }
    if (structure.stage === 'established') {
        // In setup phase the summary's tdst is the last completed setup of either side, so require this move's side.
        const setupSide: DemarkSide = structure.trend === 'up' ? 'sell' : 'buy';
        if (summary.side === setupSide && summary.risk.tdst !== null) {
            return { signal: 9, price: summary.risk.tdst };
        }
    }
    return null;
}

export function cardProtection(
    card: CardStrength,
    inputs: Readonly<Record<InsightInterval, TimeframeInput>>,
    structures: readonly TimeframeStructure[]
): CardProtection | null {
    if (card.direction === 'neutral') {
        return null;
    }
    const interval = card.anchorInterval;
    if (interval === null) {
        throw new Error(`A ${card.direction} card has no anchor timeframe`);
    }
    const side: DemarkSide = card.direction === 'bullish' ? 'buy' : 'sell';
    const structure = structures.find((s) => s.interval === interval);
    if (structure === undefined) {
        throw new Error(`Protected timeframe ${interval} has no structure`);
    }
    const found = stopPrice(inputs[interval], structure);
    let stop: ProtectionStop | null = null;
    if (found !== null) {
        const rows = inputs['5m'].analysis.rows;
        const last = rows[rows.length - 1];
        if (last === undefined) {
            throw new Error('Empty 5m window');
        }
        const current = Number(last.close);
        const room = side === 'buy' ? current - Number(found.price) : Number(found.price) - current;
        stop = { signal: found.signal, price: trimPrice(found.price), distancePct: formatPct((room / current) * 100) };
    }
    return {
        optionType: side === 'buy' ? 'put' : 'call',
        interval,
        durationSeconds: durationFitting(
            durationCovering(PROTECTION_BARS * INTERVAL_MS[interval]),
            stop === null ? null : Math.round(Number(stop.distancePct) * 100)
        ),
        stop
    };
}
