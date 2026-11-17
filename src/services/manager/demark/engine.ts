/**
 * TD Sequential state machine, ported from a Python reference engine.
 *
 * The configuration is fixed to td-sequential-v2: price flip required, perfection
 * strict_at_nine, same_side retain_active, recycling range_and_22, TDST breach on true
 * extremes, risk breach on close, no validity expiry. Inputs are contiguous closed bars
 * (binance-klines.ts rejects gaps), so the Python gap/continuity branches are not ported.
 * Pure: no I/O and no clock.
 */

import { ScaledBar } from './fixed-decimal';

export type Side = 'buy' | 'sell';
export type SetupStatus = 'forming' | 'completed' | 'interrupted';
export type CountdownStatus =
    | 'inactive'
    | 'active'
    | 'count13_unqualified'
    | 'qualified13'
    | 'cancelled'
    | 'recycled';
export type RiskStatus = 'not_available' | 'valid' | 'invalidated';
export type EventKind =
    | 'setup_count'
    | 'setup_completed'
    | 'setup_interrupted'
    | 'perfected'
    | 'countdown_count'
    | 'deferred13'
    | 'qualified13'
    | 'cancelled'
    | 'recycled'
    | 'invalidated';

export interface SequenceState {
    /** Index in `EngineResult.sequences`, in creation order. */
    id: number;
    side: Side;
    /** Bar indices of Setup 1..n. */
    setup: number[];
    setupStatus: SetupStatus;
    perfected: boolean;
    /** Bar indices of Countdown 1..n. */
    countdown: number[];
    countdownStatus: CountdownStatus;
    tdst: bigint | null;
    risk: bigint | null;
    riskStatus: RiskStatus;
}

export interface EngineEvent {
    kind: EventKind;
    sequence: number;
    side: Side;
    bar: number;
    count: number | null;
    reason: string;
}

export interface EngineResult {
    sequences: SequenceState[];
    events: EngineEvent[];
}

const isActive = (status: CountdownStatus): boolean =>
    status === 'active' || status === 'count13_unqualified';
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function last<T>(items: readonly T[]): T {
    const item = items[items.length - 1];
    if (item === undefined) {
        throw new Error('Expected a non-empty list');
    }
    return item;
}

function at<T>(items: readonly T[], index: number): T {
    const item = items[index];
    if (item === undefined) {
        throw new Error(`Index ${index} out of range`);
    }
    return item;
}

export function evaluateSequential(input: readonly ScaledBar[]): EngineResult {
    const sequences: SequenceState[] = [];
    const events: EngineEvent[] = [];
    let streak: SequenceState | null = null;
    let streakLength = 0;

    const bar = (i: number): ScaledBar => at(input, i);
    const trueHigh = (i: number): bigint => (i > 0 ? max(bar(i).high, bar(i - 1).close) : bar(i).high);
    const trueLow = (i: number): bigint => (i > 0 ? min(bar(i).low, bar(i - 1).close) : bar(i).low);
    const emit = (seq: SequenceState, kind: EventKind, i: number, reason: string, count: number | null = null): void => {
        events.push({ kind, sequence: seq.id, side: seq.side, bar: i, count, reason });
    };
    const setupRange = (seq: SequenceState): bigint => {
        let high = trueHigh(at(seq.setup, 0));
        let low = trueLow(at(seq.setup, 0));
        for (const j of seq.setup) {
            high = max(high, trueHigh(j));
            low = min(low, trueLow(j));
        }
        return high - low;
    };

    const perfect = (seq: SequenceState, i: number): void => {
        // strict_at_nine: perfection is judged only on the Setup 9 bar.
        if (seq.perfected || i !== last(seq.setup)) {
            return;
        }
        const six = bar(at(seq.setup, 5));
        const seven = bar(at(seq.setup, 6));
        const candidates = [at(seq.setup, 7), at(seq.setup, 8), i].map(bar);
        const perfected =
            seq.side === 'buy'
                ? candidates.map((b) => b.low).reduce(min) < min(six.low, seven.low)
                : candidates.map((b) => b.high).reduce(max) > max(six.high, seven.high);
        if (perfected) {
            seq.perfected = true;
            emit(seq, 'perfected', i, 'extreme_vs_setup_six_and_seven');
        }
    };

    const completeSetup = (seq: SequenceState, i: number): void => {
        seq.setupStatus = 'completed';
        seq.countdownStatus = 'active';
        seq.tdst = seq.setup
            .map((j) => (seq.side === 'buy' ? trueHigh(j) : trueLow(j)))
            .reduce(seq.side === 'buy' ? max : min);
        emit(seq, 'setup_completed', i, 'nine_consecutive_closes', 9);
        const newRange = setupRange(seq);
        for (const older of sequences) {
            if (older === seq || !isActive(older.countdownStatus)) {
                continue;
            }
            if (older.side !== seq.side) {
                older.countdownStatus = 'cancelled';
                emit(older, 'cancelled', i, 'opposite_setup_completed');
            } else {
                const oldRange = setupRange(older);
                if (oldRange > 0n && oldRange <= newRange && newRange <= oldRange * 2n) {
                    older.countdownStatus = 'recycled';
                    emit(older, 'recycled', i, 'same_side_setup_range_100_to_200_percent');
                }
            }
        }
        // retain_active: keep the completed Setup, but let the existing Countdown finish.
        if (sequences.some((older) => older !== seq && older.side === seq.side && isActive(older.countdownStatus))) {
            seq.countdownStatus = 'inactive';
            perfect(seq, i);
        }
    };

    const advance = (i: number): void => {
        if (i < 4) {
            return;
        }
        const current = bar(i);
        const close = current.close;
        const other = bar(i - 4).close;
        const side: Side | null = close < other ? 'buy' : close > other ? 'sell' : null;
        if (streak && side !== streak.side) {
            if (streak.setupStatus === 'forming') {
                streak.setupStatus = 'interrupted';
                emit(streak, 'setup_interrupted', i, 'consecutive_condition_failed');
            }
            streak = null;
            streakLength = 0;
        }
        let flip = false;
        if (i >= 5 && side) {
            const previous = bar(i - 1).close;
            const prior = bar(i - 5).close;
            flip = side === 'buy' ? previous >= prior : previous <= prior;
        }
        if (side && streak === null && flip) {
            streak = {
                id: sequences.length,
                side,
                setup: [],
                setupStatus: 'forming',
                perfected: false,
                countdown: [],
                countdownStatus: 'inactive',
                tdst: null,
                risk: null,
                riskStatus: 'not_available'
            };
            sequences.push(streak);
        }
        if (streak) {
            const seq: SequenceState = streak;
            streakLength += 1;
            if (seq.setupStatus === 'forming') {
                seq.setup.push(i);
                emit(seq, 'setup_count', i, 'close_vs_four_bars_earlier', seq.setup.length);
                if (seq.setup.length === 9) {
                    completeSetup(seq, i);
                }
            }
            if (streakLength === 22) {
                // Only a subsequent overlapping Setup can recycle an older Countdown.
                for (const older of sequences) {
                    if (
                        older !== seq &&
                        older.side === seq.side &&
                        isActive(older.countdownStatus) &&
                        last(older.setup) < at(seq.setup, 0)
                    ) {
                        older.countdownStatus = 'recycled';
                        emit(older, 'recycled', i, 'subsequent_setup_extended_to_22');
                        if (seq.countdownStatus === 'inactive') {
                            // Begin prospectively at the handover; never backdate a 13.
                            seq.countdownStatus = 'active';
                        }
                    }
                }
            }
        }
        for (const seq of sequences) {
            if (seq.setupStatus !== 'completed') {
                continue;
            }
            if (seq.riskStatus === 'valid' && i > last(seq.countdown)) {
                if (seq.risk === null) {
                    throw new Error('Valid risk status without a risk level');
                }
                if (seq.side === 'buy' ? close < seq.risk : close > seq.risk) {
                    seq.riskStatus = 'invalidated';
                    emit(seq, 'invalidated', i, 'risk_level_breach');
                }
            }
            if (isActive(seq.countdownStatus)) {
                if (seq.tdst === null) {
                    throw new Error('Active countdown without TDST');
                }
                const breach =
                    seq.side === 'buy' ? trueLow(i) > seq.tdst : trueHigh(i) < seq.tdst;
                if (breach) {
                    seq.countdownStatus = 'cancelled';
                    emit(seq, 'cancelled', i, 'tdst_breach');
                }
            }
            if (isActive(seq.countdownStatus) || seq.countdownStatus === 'qualified13') {
                perfect(seq, i);
            }
            if (!isActive(seq.countdownStatus)) {
                continue;
            }
            const base = bar(i - 2);
            const qualifies = seq.side === 'buy' ? close <= base.low : close >= base.high;
            if (!qualifies) {
                continue;
            }
            if (seq.countdown.length === 12) {
                const threshold = bar(at(seq.countdown, 7)).close;
                const reached = seq.side === 'buy' ? current.low <= threshold : current.high >= threshold;
                if (!reached) {
                    seq.countdownStatus = 'count13_unqualified';
                    emit(seq, 'deferred13', i, 'extreme_did_not_reach_countdown_eight', 13);
                    continue;
                }
                seq.countdownStatus = 'qualified13';
            }
            seq.countdown.push(i);
            emit(seq, 'countdown_count', i, 'close_vs_two_bars_earlier', seq.countdown.length);
            if (seq.countdownStatus === 'qualified13') {
                emit(seq, 'qualified13', i, 'extreme_reached_countdown_eight', 13);
                // Risk: the countdown span's true extreme, earliest on ties, minus/plus that bar's true range.
                let riskIndex = at(seq.countdown, 0);
                for (let j = riskIndex + 1; j <= i; j++) {
                    if (seq.side === 'buy' ? trueLow(j) < trueLow(riskIndex) : trueHigh(j) > trueHigh(riskIndex)) {
                        riskIndex = j;
                    }
                }
                const trueRange = trueHigh(riskIndex) - trueLow(riskIndex);
                seq.risk =
                    seq.side === 'buy' ? trueLow(riskIndex) - trueRange : trueHigh(riskIndex) + trueRange;
                seq.riskStatus = 'valid';
            }
        }
    };

    for (let i = 0; i < input.length; i++) {
        advance(i);
    }
    return { sequences, events };
}
