// One symbol's insight snapshot (spec section 9), assembled from its five analysed windows:
// regime, strength card (section 5) with its headline and protection suggestion, and facts (section 6). Pure: no
// I/O and no clock.

import { INTERVAL_MS } from '../../manager/demark/binance-klines';
import { TimeframeInput, buildFacts } from '../../manager/demark/insight-facts';
import { cardProtection } from '../../manager/demark/protection';
import { composeRegime } from '../../manager/demark/regime';
import { CardLead, SCORED_INTERVALS, cardStrength, scoreTimeframe } from '../../manager/demark/strength';
import { WindowAnalysis } from '../../manager/demark/summary';
import {
    DemarkSummary,
    INSIGHT_INTERVALS,
    InsightInterval,
    InsightSnapshot,
    InsightText,
    ScoredInterval,
    TimeframeScore
} from '../../manager/types/insight-types';
import { TICK_OFFSET_MS } from '../signal-push/signal-push-task';
import { SignalSymbol } from '../signal-push/symbols';
import { cardPhase } from './card-phase';
import { LlmInput } from './insight-text';

function lastOpenTime(analysis: WindowAnalysis): number {
    const last = analysis.rows[analysis.rows.length - 1];
    if (last === undefined) {
        throw new Error(`Empty ${analysis.interval} window`);
    }
    return last.openTime;
}

function isScored(interval: InsightInterval): interval is ScoredInterval {
    return (SCORED_INTERVALS as readonly InsightInterval[]).includes(interval);
}

/** The snapshot, without AI text, and the LLM input for the same bar. */
export function assembleSnapshot(
    symbol: SignalSymbol,
    windows: Readonly<Record<InsightInterval, WindowAnalysis>>
): { snapshot: InsightSnapshot; input: LlmInput } {
    const summaries = {} as Record<InsightInterval, DemarkSummary | null>;
    const lastClosed = {} as Record<InsightInterval, number>;
    for (const interval of INSIGHT_INTERVALS) {
        summaries[interval] = windows[interval].summary;
        lastClosed[interval] = lastOpenTime(windows[interval]);
    }
    const { regime, timeframes: composed } = composeRegime(summaries);

    const inputs = {} as Record<InsightInterval, TimeframeInput>;
    for (const interval of INSIGHT_INTERVALS) {
        inputs[interval] = { analysis: windows[interval], composed: composed[interval] };
    }
    const facts = buildFacts(inputs);

    // Scoring reads each timeframe's stage and lean from the facts, so the card and the text read it the same way.
    const scores = {} as Record<ScoredInterval, TimeframeScore | null>;
    for (const interval of SCORED_INTERVALS) {
        const { state, signals } = composed[interval];
        const structure = facts.structures.find((s) => s.interval === interval) ?? null;
        scores[interval] = scoreTimeframe(interval, state, signals, lastClosed[interval], structure);
    }
    // The facts read only scored timeframes (R36) and the lead's structure always has a lean, so a lead outside them
    // or without a score is a bug, not a quiet strength 0.
    let lead: CardLead | null = null;
    if (facts.mainLine !== null) {
        const { direction, leadInterval } = facts.mainLine;
        const score = isScored(leadInterval) ? scores[leadInterval] : null;
        if (!isScored(leadInterval) || score === null) {
            throw new Error(`Lead timeframe ${leadInterval} has no score`);
        }
        lead = { direction, interval: leadInterval, score };
    }
    const card = cardStrength(scores, lead);

    const asOf = lastClosed['5m'] + INTERVAL_MS['5m'];
    const snapshot: InsightSnapshot = {
        symbol: symbol.klineSymbol,
        source: 'binance-usdm',
        ruleset: 'td-sequential-v2',
        strengthRuleset: 'strength-v1.5',
        asOf,
        nextUpdateAt: asOf + INTERVAL_MS['5m'] + TICK_OFFSET_MS,
        card: {
            ...card,
            phase: cardPhase(card, facts.structures),
            protection: cardProtection(card, inputs, facts.structures),
            insight: null
        },
        facts,
        regime,
        timeframes: INSIGHT_INTERVALS.map((interval) => ({
            interval,
            lastClosedBarTime: lastClosed[interval],
            summary: summaries[interval],
            state: composed[interval].state,
            signals: composed[interval].signals,
            newTrend: composed[interval].newTrend,
            score: isScored(interval) ? scores[interval] : null
        }))
    };
    const input: LlmInput = {
        symbol: symbol.displayName,
        card: { direction: card.direction, anchorInterval: card.anchorInterval },
        facts
    };
    return { snapshot, input };
}

/**
 * The snapshot showing `text`, or no text when it was written for another direction or more than
 * `maxAgeMs` before the snapshot: its numbers no longer match the card.
 */
export function attachInsight(snapshot: InsightSnapshot, text: InsightText | null, maxAgeMs: number): InsightSnapshot {
    const shown =
        text !== null && text.direction === snapshot.card.direction && snapshot.asOf - text.asOf <= maxAgeMs;
    return { ...snapshot, card: { ...snapshot.card, insight: shown ? text : null } };
}
