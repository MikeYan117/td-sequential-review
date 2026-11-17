/**
 * One timeframe's primary DeMark sequence, ported from the Python reference
 * summary.py (`summarize`).
 *
 * Three per-sequence values that the Python engine reports (`_result_sequence`) and engine.ts does
 * not are derived here: the qualified 13's confirmation close, bars since that 13, and the next-bar
 * conditions. Prices come out as Python prints them: trailing zeros stripped. Pure: no I/O and no clock.
 */

import { INTERVAL_MS, KlineRow } from './binance-klines';
import { CountdownStatus, EngineResult, SequenceState, evaluateSequential } from './engine';
import { ScaledBar, fromScaled, scaleRows } from './fixed-decimal';
import { DemarkInterval, DemarkSide } from '../types/demark-types';
import {
    DemarkNextBarNeeds,
    DemarkPrevCountdown,
    DemarkRound,
    DemarkSecondSetup,
    DemarkSignalRef,
    DemarkSummary,
    DemarkTrend
} from '../types/insight-types';

export interface WindowAnalysis {
    interval: DemarkInterval;
    rows: readonly KlineRow[];
    /** Decimal places of the window's fixed-point prices (see fixed-decimal.ts). */
    scale: number;
    engine: EngineResult;
    summary: DemarkSummary | null;
}

const TREND: Record<DemarkSide, DemarkTrend> = { buy: 'down', sell: 'up' };
const ACTIVE: readonly CountdownStatus[] = ['active', 'count13_unqualified'];
const ENDED: readonly CountdownStatus[] = ['qualified13', 'cancelled', 'recycled'];

function at<T>(items: readonly T[], index: number): T {
    const item = items[index];
    if (item === undefined) {
        throw new Error(`Index ${index} out of range`);
    }
    return item;
}

function lastOf<T>(items: readonly T[]): T {
    return at(items, items.length - 1);
}

/** Python's `max(items, key=...)`: the first item with the largest key. */
function firstMax<T, K extends number | bigint>(items: readonly T[], key: (item: T) => K): T | undefined {
    let best: T | undefined;
    let bestKey: K | undefined;
    for (const item of items) {
        const value = key(item);
        if (bestKey === undefined || value > bestKey) {
            best = item;
            bestKey = value;
        }
    }
    return best;
}

export function analyzeWindow(rows: readonly KlineRow[], interval: DemarkInterval): WindowAnalysis {
    const { scale, bars } = scaleRows(rows);
    const engine = evaluateSequential(bars);
    return { interval, rows, scale, engine, summary: summarize(engine, rows, bars, scale, interval) };
}

function summarize(
    result: EngineResult,
    rows: readonly KlineRow[],
    bars: readonly ScaledBar[],
    scale: number,
    interval: DemarkInterval
): DemarkSummary | null {
    // engine.ts creates each sequence on its first setup bar, so `sequences` is already Python's
    // `seqs`: observed sequences with setup bars, ordered by setup start.
    const seqs = result.sequences;
    const run = seqs[seqs.length - 1];
    const lastRow = rows[rows.length - 1];
    if (run === undefined || lastRow === undefined) {
        return null;
    }
    const last = rows.length - 1;
    const bar = (i: number): ScaledBar => at(bars, i);
    const price = (value: bigint): string => fromScaled(value, scale);
    const openTime = (i: number): number => at(rows, i).openTime;
    const trueHigh = (i: number): bigint => (i > 0 && bar(i - 1).close > bar(i).high ? bar(i - 1).close : bar(i).high);
    const trueLow = (i: number): bigint => (i > 0 && bar(i - 1).close < bar(i).low ? bar(i - 1).close : bar(i).low);
    const t9 = (s: SequenceState): number => openTime(at(s.setup, 8));
    const t13 = (s: SequenceState): number => openTime(lastOf(s.countdown));
    const isQualified13 = (s: SequenceState): boolean => s.countdownStatus === 'qualified13';

    const done = seqs.filter((s) => s.setupStatus === 'completed');
    const active = seqs.filter((s) => ACTIVE.includes(s.countdownStatus));
    const primary = active[0] ?? run;
    const phase: DemarkSummary['phase'] = active.length > 0 ? 'countdown' : 'setup';
    let step: number;
    let setupStep: number;
    let countdownStep: number;
    if (phase === 'countdown') {
        step = countdownStep = primary.countdown.length;
        const sameRun = run !== primary && run.side === primary.side;
        setupStep = sameRun ? run.setup.length : primary.setup.length;
    } else {
        step = setupStep = run.setup.length;
        countdownStep = 0;
    }
    const side = primary.side;

    // Rounds, rule B: a same-side chain that restarts on an opposite 9 or on a new 9
    // after any chain round already reached qualified 13; unperfected held-back 9s are skipped.
    let chain: SequenceState[] = [];
    for (const seq of done) {
        const head = chain[0];
        if (
            head !== undefined &&
            (seq.side !== head.side ||
                chain.some((c) => isQualified13(c) && lastOf(c.countdown) < at(seq.setup, 8)))
        ) {
            chain = [];
        } else if (head !== undefined && seq.countdownStatus === 'inactive' && !seq.perfected) {
            // A same-side 9 held back by retain_active is listed only once perfected.
            continue;
        }
        chain.push(seq);
    }
    const qualified = chain.filter(isQualified13);
    const chainHead = chain[0];
    if (
        active.length === 0 &&
        chainHead !== undefined &&
        !qualified.some((c) => c.riskStatus === 'valid') &&
        (qualified.length > 0 || chainHead.side !== run.side)
    ) {
        // Outside countdown the chain drops once its 13's risk level has broken; a 13 whose
        // risk level holds stays listed.
        chain = [];
    }
    if (!chain.includes(run)) {
        chain.push(run);
    }
    const rounds: DemarkRound[] = chain.map((s) => ({
        side: s.side,
        trend: TREND[s.side],
        setup: s.setup.length,
        countdown: s.countdown.length,
        setup9At: s.setupStatus === 'completed' ? t9(s) : null,
        qualified13At: isQualified13(s) ? t13(s) : null
    }));

    const ended = seqs.filter((s) => s !== primary && ENDED.includes(s.countdownStatus) && s.countdown.length > 0);
    const prevSeq = firstMax(ended, (s) => lastOf(s.countdown));
    const prev: DemarkPrevCountdown | null =
        prevSeq === undefined
            ? null
            : {
                  side: prevSeq.side,
                  countdown: prevSeq.countdown.length,
                  qualified: isQualified13(prevSeq),
                  barsAgo: last - lastOf(prevSeq.countdown)
              };
    if (phase === 'setup' && prev !== null && prev.qualified && prev.barsAgo === 0) {
        // The reference product still reports the count on the bar the 13 qualifies.
        countdownStep = prev.countdown;
    }

    const first = at(chain, 0);
    let lastSignal: DemarkSignalRef | null;
    if (isQualified13(first)) {
        lastSignal = { kind: 13, at: t13(first), side: first.side };
    } else if (first.setupStatus === 'completed') {
        lastSignal = { kind: 9, at: t9(first), side: first.side };
    } else if (prevSeq !== undefined && prev !== null) {
        lastSignal = prev.qualified
            ? { kind: 13, at: t13(prevSeq), side: prevSeq.side }
            : { kind: 9, at: t9(prevSeq), side: prevSeq.side };
    } else {
        lastSignal = null;
    }

    const second: DemarkSecondSetup | null =
        phase === 'countdown' && run !== primary
            ? {
                  side: run.side,
                  trend: TREND[run.side],
                  step: run.setup.length,
                  setup9At: run.setupStatus === 'completed' ? t9(run) : null
              }
            : null;
    // Python `bars_since_qualified13`, per qualified sequence.
    const since13 = seqs.filter(isQualified13).map((s) => last - lastOf(s.countdown));

    const setup9 = done.filter((s) => s.side === side).at(-1);
    let risk9: bigint | null = null;
    if (setup9 !== undefined) {
        // The setup bar with the true extreme (earliest on ties), pushed out by that bar's true range.
        const j = firstMax(setup9.setup, (i) => (side === 'buy' ? -trueLow(i) : trueHigh(i)));
        if (j === undefined) {
            throw new Error('Completed setup without bars');
        }
        const range = trueHigh(j) - trueLow(j);
        risk9 = side === 'buy' ? trueLow(j) - range : trueHigh(j) + range;
    }
    const risk13 = firstMax(seqs.filter((s) => s.side === side && isQualified13(s)), t13);
    // Python `confirmation_close`: the close of the bar that qualified the 13.
    const close13 =
        prevSeq !== undefined && prev !== null && prev.qualified && prevSeq.side === side
            ? price(bar(lastOf(prevSeq.countdown)).close)
            : null;
    // Python `_result_sequence` next_conditions, for the bar after `last`: a forming setup compares
    // its close with the close four bars earlier, an active countdown with the low (buy) or high
    // (sell) two bars earlier.
    const nextBarNeeds = (seq: SequenceState, purpose: 'setup' | 'countdown'): DemarkNextBarNeeds | null => {
        const buy = seq.side === 'buy';
        let threshold: bigint;
        if (purpose === 'setup') {
            if (seq.setupStatus !== 'forming') {
                return null;
            }
            threshold = bar(last - 3).close;
        } else {
            if (!ACTIVE.includes(seq.countdownStatus)) {
                return null;
            }
            const base = bar(last - 1);
            threshold = buy ? base.low : base.high;
        }
        return { direction: buy ? 'below' : 'above', price: price(threshold) };
    };
    let tdst: bigint | null;
    let need: DemarkNextBarNeeds | null;
    if (phase === 'countdown') {
        tdst = primary.tdst;
        need = nextBarNeeds(primary, 'countdown');
    } else {
        tdst = done.at(-1)?.tdst ?? null;
        need = nextBarNeeds(run, 'setup');
    }

    return {
        side,
        trend: TREND[side],
        phase,
        step,
        target: phase === 'countdown' ? 13 : 9,
        setupStep,
        countdownStep,
        rounds,
        lastSignal,
        prev,
        second,
        barsSinceQualified13: since13.length > 0 ? Math.min(...since13) : null,
        setupRun: {
            start: openTime(at(run.setup, 0)),
            side: run.side,
            count: run.setup.length,
            active: run.setupStatus === 'forming',
            completed: run.setupStatus === 'completed'
        },
        risk: {
            risk9: risk9 === null ? null : price(risk9),
            risk9At: setup9 === undefined ? null : t9(setup9),
            // The close is dropped once the 9's countdown started and was cancelled;
            // cancelled before counting keeps it.
            setupClose:
                setup9 !== undefined && !(setup9.countdownStatus === 'cancelled' && setup9.countdown.length > 0)
                    ? price(bar(at(setup9.setup, 8)).close)
                    : null,
            riskLevel: risk13 === undefined || risk13.risk === null ? null : price(risk13.risk),
            risk13At: risk13 === undefined ? null : t13(risk13),
            // Firm until a same-side 9 completes after the 13.
            provisional: !(risk13 !== undefined && setup9 !== undefined && t9(setup9) < t13(risk13)),
            close13,
            tdst: tdst === null ? null : price(tdst),
            nextBarNeeds: need
        },
        asOf: lastRow.openTime + INTERVAL_MS[interval],
        close: price(bar(last).close)
    };
}
