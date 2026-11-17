// Exact fixed-point prices for one kline window: every price is scaled to the window's largest
// number of decimal places and held as a bigint, so comparisons and sums never round.

const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

export interface PriceRow {
    high: string;
    low: string;
    close: string;
}

export interface ScaledBar {
    high: bigint;
    low: bigint;
    close: bigint;
}

export function isDecimalText(text: string): boolean {
    return DECIMAL_TEXT.test(text);
}

export function decimalPlaces(text: string): number {
    if (!isDecimalText(text)) {
        throw new Error(`Invalid decimal: ${text}`);
    }
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

export function toScaled(text: string, scale: number): bigint {
    if (decimalPlaces(text) > scale) {
        throw new Error(`${text} has more than ${scale} decimal places`);
    }
    const [whole = '', fraction = ''] = text.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
}

/** Decimal text without trailing zeros, like Python's `format(Decimal, "f")` stripped. */
export function fromScaled(value: bigint, scale: number): string {
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, digits.length - scale);
    const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function scaleRows(rows: readonly PriceRow[]): { scale: number; bars: ScaledBar[] } {
    let scale = 0;
    for (const row of rows) {
        scale = Math.max(scale, decimalPlaces(row.high), decimalPlaces(row.low), decimalPlaces(row.close));
    }
    const bars = rows.map((row) => ({
        high: toScaled(row.high, scale),
        low: toScaled(row.low, scale),
        close: toScaled(row.close, scale)
    }));
    return { scale, bars };
}
