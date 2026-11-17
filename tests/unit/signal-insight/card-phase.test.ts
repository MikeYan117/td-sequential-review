import * as OpenCC from 'opencc-js';
import { SCORED_INTERVALS } from '../../../src/services/manager/demark/strength';
import {
    DemarkTrend,
    InsightInterval,
    TimeframeStructure,
} from '../../../src/services/manager/types/insight-types';
import { cardPhase } from '../../../src/services/sync/signal-insight/card-phase';
import { readingLean } from '../demark/helpers';

function structure(interval: InsightInterval, trend: DemarkTrend, stage: TimeframeStructure['stage']): TimeframeStructure {
    const setupStep = stage === 'forming' ? 5 : 9;
    const countdown = stage === 'exhausted' ? 13 : 0;
    const lean = readingLean(trend, stage);
    return { interval, close: '100', trend, stage, setupStep, countdown, formingOpposite: null, timeline: [], thirteenFailed: false, lean };
}

describe('cardPhase', () => {
    test.each([
        ['5m', 'down', 'established', { en: 'Short-term Downtrend Established', zhCN: '短趋势下跌确立', zhTW: '短趨勢下跌確立', ko: '단기 하락 추세 확립', ja: '短期下落トレンド確立' }],
        ['15m', 'up', 'exhausted', { en: 'Short-term Uptrend Reversal', zhCN: '短趋势上涨反转', zhTW: '短趨勢上漲反轉', ko: '단기 상승 추세 반전', ja: '短期上昇トレンド反転' }],
        ['1h', 'down', 'exhausted', { en: 'Long-term Downtrend Reversal', zhCN: '长趋势下跌反转', zhTW: '長趨勢下跌反轉', ko: '장기 하락 추세 반전', ja: '長期下落トレンド反転' }],
        ['1h', 'up', 'established', { en: 'Long-term Uptrend Established', zhCN: '长趋势上涨确立', zhTW: '長趨勢上漲確立', ko: '장기 상승 추세 확립', ja: '長期上昇トレンド確立' }],
        ['4h', 'down', 'established', { en: 'Long-term Downtrend Established', zhCN: '长趋势下跌确立', zhTW: '長趨勢下跌確立', ko: '장기 하락 추세 확립', ja: '長期下落トレンド確立' }],
    ] as const)('a %s %s %s anchor', (interval, trend, stage, title) => {
        expect(cardPhase({ anchorInterval: interval }, [structure(interval, trend, stage)])).toEqual({ stage, title });
    });

    it('heads a neutral card with forming', () => {
        expect(cardPhase({ anchorInterval: null }, [structure('1h', 'down', 'established')])).toEqual({
            stage: 'forming',
            title: { en: 'Trend Forming', zhCN: '趋势形成中', zhTW: '趨勢形成中', ko: '추세 형성 중', ja: 'トレンド形成中' },
        });
    });

    it('reads the anchor, not a smaller exhausted timeframe the card only bounces in', () => {
        const structures = [structure('1h', 'down', 'exhausted'), structure('4h', 'down', 'established')];
        expect(cardPhase({ anchorInterval: '4h' }, structures)).toMatchObject({
            stage: 'established',
            title: { zhCN: '长趋势下跌确立' },
        });
    });

    it('throws when the anchor has no structure', () => {
        expect(() => cardPhase({ anchorInterval: '4h' }, [structure('1h', 'down', 'established')])).toThrow(
            'Anchor timeframe 4h has no structure'
        );
    });

    it('throws when the anchor is still forming', () => {
        expect(() => cardPhase({ anchorInterval: '1h' }, [structure('1h', 'up', 'forming')])).toThrow(
            'Anchor timeframe 1h is forming'
        );
    });

    it('writes zhTW as opencc converts zhCN', () => {
        const toTw = OpenCC.Converter({ from: 'cn', to: 'twp' });
        const titles = [cardPhase({ anchorInterval: null }, []).title];
        for (const interval of SCORED_INTERVALS) {
            for (const trend of ['up', 'down'] as const) {
                for (const stage of ['established', 'exhausted'] as const) {
                    titles.push(cardPhase({ anchorInterval: interval }, [structure(interval, trend, stage)]).title);
                }
            }
        }
        expect(titles).toHaveLength(17);
        expect(titles.map((t) => t.zhCN).join()).not.toContain('中趋势');
        for (const title of titles) {
            expect(title.zhTW).toBe(toTw(title.zhCN));
        }
    });
});
