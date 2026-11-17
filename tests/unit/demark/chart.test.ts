import { projectChart } from '../../../src/services/manager/demark/chart';
import { evaluateSequential } from '../../../src/services/manager/demark/engine';
import { scaleRows } from '../../../src/services/manager/demark/fixed-decimal';
import { BUY, HOUR, SyntheticInput, syntheticRows } from './helpers';

function chart(input: SyntheticInput) {
    const rows = syntheticRows(input);
    const { scale, bars } = scaleRows(rows);
    return projectChart(evaluateSequential(bars), rows.map((_, i) => i * HOUR), scale);
}

const COUNTDOWN_TO_13 = [...BUY, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79];
const DEFERRED = [...BUY, 90, 89, 88, 87, 86, 85, 84, 94, 94, 93, 92, 91, 90, 89, 83];

describe('projectChart', () => {
    it('marks setup 9 before the countdown number on the same bar', () => {
        expect(chart({ closes: BUY }).markers).toEqual([
            { time: 13 * HOUR, kind: 'setup9', side: 'buy', label: '9', perfected: true },
            { time: 13 * HOUR, kind: 'countdownProgress', side: 'buy', label: '1', count: 1, deferred: false }
        ]);
    });

    it('marks a qualified 13 with its risk line and ends the TDST line there', () => {
        const result = chart({ closes: COUNTDOWN_TO_13 });
        expect(result.markers).toEqual([
            { time: 13 * HOUR, kind: 'setup9', side: 'buy', label: '9', perfected: true },
            { time: 25 * HOUR, kind: 'countdown13', side: 'buy', label: '13' }
        ]);
        expect(result.riskLines).toEqual([{ side: 'buy', price: '76', time: 25 * HOUR, invalidatedTime: null }]);
        expect(result.tdstLines).toEqual([
            { side: 'buy', price: '104', startTime: 5 * HOUR, endTime: 25 * HOUR, endReason: 'qualified13' }
        ]);
    });

    it('records the bar whose close breaks the risk level', () => {
        expect(chart({ closes: [...COUNTDOWN_TO_13, 75] }).riskLines).toEqual([
            { side: 'buy', price: '76', time: 25 * HOUR, invalidatedTime: 26 * HOUR }
        ]);
    });

    it('shows a deferred 13 as "+" next to the forming setup count', () => {
        const result = chart({ closes: DEFERRED.slice(0, -1) });
        expect(result.markers.filter((m) => m.kind === 'countdownProgress' || m.kind === 'setupProgress')).toEqual([
            { time: 27 * HOUR, kind: 'countdownProgress', side: 'buy', label: '+', count: 12, deferred: true },
            { time: 27 * HOUR, kind: 'setupProgress', side: 'buy', label: '3', count: 3 }
        ]);
        expect(result.tdstLines).toEqual([
            { side: 'buy', price: '104', startTime: 5 * HOUR, endTime: null, endReason: null }
        ]);
    });

    it('ends TDST lines on an opposite 9 and on a TDST breach', () => {
        expect(chart({ closes: [...BUY, 92, 92, 94, 95, 96, 97, 98, 99, 100, 101, 102] }).tdstLines).toEqual([
            { side: 'buy', price: '104', startTime: 5 * HOUR, endTime: 24 * HOUR, endReason: 'opposite' },
            { side: 'sell', price: '92', startTime: 16 * HOUR, endTime: null, endReason: null }
        ]);
        expect(chart({ closes: [...BUY, 106, 107] }).tdstLines).toEqual([
            { side: 'buy', price: '104', startTime: 5 * HOUR, endTime: 15 * HOUR, endReason: 'tdst' }
        ]);
    });

    it('marks R on a 22-bar recycle and shows no countdown number before the new one counts', () => {
        const closes = [...BUY, 95, 96, 97, 98, ...Array.from({ length: 22 }, (_, i) => 94 - i)];
        const result = chart({ closes, lows: closes.map((c) => c - 10) });
        expect(result.markers.filter((m) => m.kind === 'recycle')).toEqual([
            { time: 39 * HOUR, kind: 'recycle', side: 'buy', label: 'R' }
        ]);
        expect(result.markers.some((m) => m.kind === 'countdownProgress')).toBe(false);
        expect(result.tdstLines.map((l) => [l.startTime / HOUR, l.endReason])).toEqual([
            [5, 'recycled'],
            [18, null]
        ]);
    });

    it('marks a setup 9 held back by retain_active but draws no TDST line for it', () => {
        const closes = [...BUY, 95, 96, 97, 98, 94, 93, 92, 91, 90, 89, 88, 87, 86];
        const highs = closes.map((c) => c + 1);
        highs[18] = 114;
        const result = chart({ closes, highs });
        expect(result.markers.filter((m) => m.kind === 'setup9').map((m) => m.time / HOUR)).toEqual([13, 26]);
        expect(result.tdstLines.map((l) => l.startTime / HOUR)).toEqual([5]);
    });
});
