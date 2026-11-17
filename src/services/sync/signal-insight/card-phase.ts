// The card's headline (spec section 5.7, 2026-10-15), the first words a user reads: whether the anchor
// timeframe's trend is established or reversing, in place of the card's direction, and whether that timeframe is a
// short (5m, 15m) or long (1h, 4h) trend (R36). The anchor, not the main line, is read, so a 1h-or-bigger main 13
// that is only a bounce inside a bigger move does not head the card as a reversal; a short main line is its own anchor
// (R35), so its 13 heads the card as a reversal and the bounce is told in the conclusion. zhTW is written out rather than converted
// with opencc, whose dictionaries a sync process without an LLM never loads; a test checks it matches the
// conversion.

import {
    CardPhase,
    CardStrength,
    DemarkTrend,
    ScoredInterval,
    TimeframeStructure,
} from '../../manager/types/insight-types';

type TitleLang = keyof CardPhase['title'];
type CountedStage = 'established' | 'exhausted';

/** The headline per stage and trend after the tier: the trend the anchor counts, and whether it is established or reversing. */
const TITLES: Record<TitleLang, Record<CountedStage, Record<DemarkTrend, string>>> = {
    en: {
        established: { up: 'Uptrend Established', down: 'Downtrend Established' },
        exhausted: { up: 'Uptrend Reversal', down: 'Downtrend Reversal' },
    },
    zhCN: {
        established: { up: '上涨确立', down: '下跌确立' },
        exhausted: { up: '上涨反转', down: '下跌反转' },
    },
    zhTW: {
        established: { up: '上漲確立', down: '下跌確立' },
        exhausted: { up: '上漲反轉', down: '下跌反轉' },
    },
    ko: {
        established: { up: '상승 추세 확립', down: '하락 추세 확립' },
        exhausted: { up: '상승 추세 반전', down: '하락 추세 반전' },
    },
    ja: {
        established: { up: '上昇トレンド確立', down: '下落トレンド確立' },
        exhausted: { up: '上昇トレンド反転', down: '下落トレンド反転' },
    },
};

type Tier = 'short' | 'long';

/** 5m and 15m are a short trend, 1h and 4h a long trend (R36, 2026-10-26). */
const TIER_OF: Record<ScoredInterval, Tier> = { '5m': 'short', '15m': 'short', '1h': 'long', '4h': 'long' };

const TIER_WORDS: Record<TitleLang, Record<Tier, string>> = {
    en: { short: 'Short-term ', long: 'Long-term ' },
    zhCN: { short: '短趋势', long: '长趋势' },
    zhTW: { short: '短趨勢', long: '長趨勢' },
    ko: { short: '단기 ', long: '장기 ' },
    ja: { short: '短期', long: '長期' },
};

const FORMING: CardPhase = {
    stage: 'forming',
    title: { en: 'Trend Forming', zhCN: '趋势形成中', zhTW: '趨勢形成中', ko: '추세 형성 중', ja: 'トレンド形成中' },
};

/** The anchor structure's stage with its title; a neutral card, which has no anchor, is forming and has no tier. */
export function cardPhase(card: Pick<CardStrength, 'anchorInterval'>, structures: readonly TimeframeStructure[]): CardPhase {
    const anchor = card.anchorInterval;
    if (anchor === null) {
        return FORMING;
    }
    const structure = structures.find((s) => s.interval === anchor);
    if (structure === undefined) {
        throw new Error(`Anchor timeframe ${anchor} has no structure`);
    }
    const { stage, trend } = structure;
    if (stage === 'forming') {
        throw new Error(`Anchor timeframe ${anchor} is forming`);
    }
    const titleIn = (lang: TitleLang): string => TIER_WORDS[lang][TIER_OF[anchor]] + TITLES[lang][stage][trend];
    return {
        stage,
        title: { en: titleIn('en'), zhCN: titleIn('zhCN'), zhTW: titleIn('zhTW'), ko: titleIn('ko'), ja: titleIn('ja') },
    };
}
