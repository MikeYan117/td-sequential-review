// Stand-in for the host service's symbol list: the symbols the insight panel covers, with only the
// fields the insight code reads.

export interface SignalSymbol {
    /** Binance USD-M symbol the chart draws. */
    klineSymbol: string;
    /** Short name the conclusion uses (BTC, ETH, XAU, …). */
    displayName: string;
}

export const SIGNAL_SYMBOLS: readonly SignalSymbol[] = [
    { klineSymbol: 'BTCUSDC', displayName: 'BTC' },
    { klineSymbol: 'ETHUSDC', displayName: 'ETH' },
    { klineSymbol: 'SKHYUSDT', displayName: 'SKHY' },
    { klineSymbol: 'XAUUSDT', displayName: 'XAU' },
    { klineSymbol: 'TQQQUSDT', displayName: 'TQQQ' },
    { klineSymbol: 'CLUSDT', displayName: 'CL' },
    { klineSymbol: 'CRCLUSDT', displayName: 'CRCL' },
    { klineSymbol: 'MUUSDT', displayName: 'MU' },
    { klineSymbol: 'NVDAUSDT', displayName: 'NVDA' },
    { klineSymbol: 'TSLAUSDT', displayName: 'TSLA' }
];
