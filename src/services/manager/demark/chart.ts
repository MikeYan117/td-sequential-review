// Projects engine output onto the chart markers and lines the frontend draws (rules in README.md).

import { EngineEvent, EngineResult } from './engine';
import { fromScaled } from './fixed-decimal';
import {
    DemarkMarker,
    DemarkRiskLine,
    DemarkTdstEndReason,
    DemarkTdstLine
} from '../types/demark-types';

export interface ChartProjection {
    markers: DemarkMarker[];
    tdstLines: DemarkTdstLine[];
    riskLines: DemarkRiskLine[];
}

const KIND_ORDER: Record<DemarkMarker['kind'], number> = {
    setup9: 0,
    countdown13: 1,
    recycle: 2,
    countdownProgress: 3,
    setupProgress: 4
};

function last<T>(items: readonly T[]): T {
    const item = items[items.length - 1];
    if (item === undefined) {
        throw new Error('Expected a non-empty list');
    }
    return item;
}

function endReason(event: EngineEvent): DemarkTdstEndReason {
    if (event.kind === 'cancelled') {
        return event.reason === 'opposite_setup_completed' ? 'opposite' : 'tdst';
    }
    return event.kind === 'recycled' ? 'recycled' : 'qualified13';
}

/**
 * @param openTimes open time (ms) of each input bar, by bar index
 * @param scale decimal places of the engine's scaled prices
 */
export function projectChart(result: EngineResult, openTimes: readonly number[], scale: number): ChartProjection {
    const time = (i: number): number => {
        const value = openTimes[i];
        if (value === undefined) {
            throw new Error(`No open time for bar ${i}`);
        }
        return value;
    };
    const markers: DemarkMarker[] = [];
    const tdstLines: DemarkTdstLine[] = [];
    const riskLines: DemarkRiskLine[] = [];

    for (const seq of result.sequences) {
        const events = result.events.filter((e) => e.sequence === seq.id);
        const side = seq.side;
        if (seq.setupStatus === 'completed') {
            const nine = seq.setup[8];
            if (nine === undefined) {
                throw new Error('Completed setup without a ninth bar');
            }
            markers.push({ time: time(nine), kind: 'setup9', side, label: '9', perfected: seq.perfected });
        }
        if (seq.setupStatus === 'forming') {
            const count = seq.setup.length;
            markers.push({ time: time(last(seq.setup)), kind: 'setupProgress', side, label: String(count), count });
        }
        if (seq.countdownStatus === 'qualified13') {
            const thirteen = time(last(seq.countdown));
            markers.push({ time: thirteen, kind: 'countdown13', side, label: '13' });
            if (seq.risk === null) {
                throw new Error('Qualified 13 without a risk level');
            }
            const invalidated = events.find((e) => e.kind === 'invalidated');
            riskLines.push({
                side,
                price: fromScaled(seq.risk, scale),
                time: thirteen,
                invalidatedTime: invalidated ? time(invalidated.bar) : null
            });
        }
        if (
            (seq.countdownStatus === 'active' || seq.countdownStatus === 'count13_unqualified') &&
            seq.countdown.length > 0
        ) {
            const progress = last(events.filter((e) => e.kind === 'countdown_count' || e.kind === 'deferred13'));
            const deferred = progress.kind === 'deferred13';
            const count = seq.countdown.length;
            markers.push({
                time: time(progress.bar),
                kind: 'countdownProgress',
                side,
                label: deferred ? '+' : String(count),
                count,
                deferred
            });
        }
        if (seq.setupStatus === 'completed' && seq.countdownStatus !== 'inactive') {
            if (seq.tdst === null) {
                throw new Error('Completed setup without TDST');
            }
            const end = events.find((e) => e.kind === 'cancelled' || e.kind === 'recycled' || e.kind === 'qualified13');
            const start = seq.setup[0];
            if (start === undefined) {
                throw new Error('Completed setup without a first bar');
            }
            tdstLines.push({
                side,
                price: fromScaled(seq.tdst, scale),
                startTime: time(start),
                endTime: end ? time(end.bar) : null,
                endReason: end ? endReason(end) : null
            });
        }
    }
    for (const event of result.events) {
        if (event.kind === 'recycled') {
            markers.push({ time: time(event.bar), kind: 'recycle', side: event.side, label: 'R' });
        }
    }
    markers.sort((a, b) => a.time - b.time || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    tdstLines.sort((a, b) => a.startTime - b.startTime);
    riskLines.sort((a, b) => a.time - b.time);
    return { markers, tdstLines, riskLines };
}
