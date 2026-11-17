export type DemarkInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
/** Closed bars per window; Binance returns at most 1500 klines per request. */
export type DemarkLimit = 500 | 1000 | 1500;
export type DemarkSide = 'buy' | 'sell';

export type DemarkMarker =
    | { time: number; kind: 'setup9'; side: DemarkSide; label: '9'; perfected: boolean }
    | { time: number; kind: 'countdown13'; side: DemarkSide; label: '13' }
    | { time: number; kind: 'recycle'; side: DemarkSide; label: 'R' }
    | { time: number; kind: 'countdownProgress'; side: DemarkSide; label: string; count: number; deferred: boolean }
    | { time: number; kind: 'setupProgress'; side: DemarkSide; label: string; count: number };

export type DemarkTdstEndReason = 'opposite' | 'tdst' | 'recycled' | 'qualified13';

export interface DemarkTdstLine {
    side: DemarkSide;
    price: string;
    startTime: number;
    endTime: number | null;
    endReason: DemarkTdstEndReason | null;
}

export interface DemarkRiskLine {
    side: DemarkSide;
    price: string;
    time: number;
    invalidatedTime: number | null;
}

export interface DemarkChartResponse {
    symbol: string;
    interval: DemarkInterval;
    source: 'binance-usdm';
    ruleset: 'td-sequential-v2';
    bars: number;
    firstBarTime: number;
    lastClosedBarTime: number;
    nextUpdateAt: number;
    markers: DemarkMarker[];
    tdstLines: DemarkTdstLine[];
    riskLines: DemarkRiskLine[];
}

/** Charts of one symbol for one or more intervals, in the requested order. */
export interface DemarkChartsResponse {
    symbol: string;
    limit: DemarkLimit;
    charts: DemarkChartResponse[];
}
