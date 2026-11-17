import {
    decimalPlaces,
    fromScaled,
    isDecimalText,
    scaleRows,
    toScaled
} from '../../../src/services/manager/demark/fixed-decimal';

describe('fixed-decimal', () => {
    it('accepts plain non-negative decimals only', () => {
        expect(['0', '83335', '83335.0', '230.75000'].every(isDecimalText)).toBe(true);
        expect(['', '-1', '1e5', '1.', '.5', ' 1', 'NaN'].some(isDecimalText)).toBe(false);
    });

    it('counts decimal places', () => {
        expect(decimalPlaces('83335')).toBe(0);
        expect(decimalPlaces('230.75000')).toBe(5);
        expect(() => decimalPlaces('abc')).toThrow('Invalid decimal');
    });

    it('scales and formats without rounding', () => {
        expect(toScaled('83335.0', 2)).toBe(8333500n);
        expect(toScaled('0.5', 3)).toBe(500n);
        expect(() => toScaled('1.234', 2)).toThrow('more than 2 decimal places');
        expect(fromScaled(8333500n, 2)).toBe('83335');
        expect(fromScaled(8263950n, 2)).toBe('82639.5');
        expect(fromScaled(5n, 3)).toBe('0.005');
        expect(fromScaled(-1250n, 2)).toBe('-12.5');
        expect(fromScaled(42n, 0)).toBe('42');
    });

    it('scales a window to its largest precision', () => {
        const { scale, bars } = scaleRows([
            { high: '230.75000', low: '229.1', close: '230' },
            { high: '231', low: '230.5', close: '230.75' }
        ]);
        expect(scale).toBe(5);
        expect(bars).toEqual([
            { high: 23075000n, low: 22910000n, close: 23000000n },
            { high: 23100000n, low: 23050000n, close: 23075000n }
        ]);
    });
});
