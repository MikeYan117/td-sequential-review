import { evaluateSequential } from '../../../src/services/manager/demark/engine';
import { scaleRows } from '../../../src/services/manager/demark/fixed-decimal';
import { BUY, SyntheticInput, eventTuples, readFixture, sequencesView, syntheticRows } from './helpers';

interface V2Case extends SyntheticInput {
    name: string;
    sequences: unknown[];
    events: unknown[][];
}

function run(input: SyntheticInput) {
    const { scale, bars } = scaleRows(syntheticRows(input));
    return { scale, result: evaluateSequential(bars) };
}

const COUNTDOWN_TO_13 = [...BUY, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79];
// CD8 closes at 84 on bar 20; bar 27 qualifies by close but its low 88 stays above 84.
const DEFERRED = [...BUY, 90, 89, 88, 87, 86, 85, 84, 94, 94, 93, 92, 91, 90, 89, 83];

describe('evaluateSequential (td-sequential-v2)', () => {
    const cases = readFixture<V2Case[]>('sequential-v2-cases.json');

    it.each(cases.map((c) => [c.name, c] as const))('%s matches the Python reference engine', (_name, c) => {
        const { scale, result } = run(c);
        expect(sequencesView(result, scale)).toEqual(c.sequences);
        expect(eventTuples(result, { skipCounts: true })).toEqual(c.events);
    });

    it('completes a buy setup on bar 13 and qualifies 13 on bar 25 with risk 76', () => {
        const { scale, result } = run({ closes: COUNTDOWN_TO_13 });
        expect(sequencesView(result, scale)).toEqual([
            {
                side: 'buy',
                setup: [5, 6, 7, 8, 9, 10, 11, 12, 13],
                setupStatus: 'completed',
                perfected: true,
                countdown: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
                countdownStatus: 'qualified13',
                tdst: '104',
                risk: '76',
                riskStatus: 'valid'
            }
        ]);
    });

    it('defers 13 while the low stays above the countdown-8 close', () => {
        const pending = run({ closes: DEFERRED.slice(0, -1) }).result;
        expect(pending.sequences[0]?.countdownStatus).toBe('count13_unqualified');
        expect(pending.sequences[0]?.countdown).toHaveLength(12);
        expect(pending.events.filter((e) => e.kind === 'deferred13').map((e) => e.bar)).toEqual([27]);

        const done = run({ closes: DEFERRED }).result;
        expect(done.sequences[0]?.countdownStatus).toBe('qualified13');
        expect(done.sequences[0]?.countdown.at(-1)).toBe(28);
    });

    it('keeps an equal close from counting but lets an equal earlier close flip', () => {
        expect(run({ closes: [100, 101, 102, 103, 100, 99] }).result.sequences[0]?.setup).toEqual([5]);
        expect(run({ closes: [100, 101, 102, 103, 100, 99, 102] }).result.sequences[0]?.setupStatus).toBe(
            'interrupted'
        );
    });
});
