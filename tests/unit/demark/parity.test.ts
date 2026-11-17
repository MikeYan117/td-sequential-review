import { evaluateSequential } from '../../../src/services/manager/demark/engine';
import { scaleRows } from '../../../src/services/manager/demark/fixed-decimal';
import { eventTuples, readFixture, sequencesView } from './helpers';

interface BinanceFixture {
    symbol: string;
    interval: string;
    /** [openTime, high, low, close] of 499 closed Binance USD-M bars. */
    klines: [number, string, string, string][];
    expected: { sequences: unknown[]; events: unknown[][] };
}

describe('engine parity with the Python reference engine on Binance USD-M klines', () => {
    it.each(['binance-btcusdc-4h.json', 'binance-nvdausdt-1h.json'])('%s', (name) => {
        const fixture = readFixture<BinanceFixture>(name);
        const { scale, bars } = scaleRows(fixture.klines.map(([, high, low, close]) => ({ high, low, close })));
        const result = evaluateSequential(bars);
        expect(sequencesView(result, scale)).toEqual(fixture.expected.sequences);
        expect(eventTuples(result)).toEqual(fixture.expected.events);
    });
});
