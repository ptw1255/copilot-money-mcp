/**
 * Holding History model for Copilot Money data.
 *
 * Represents monthly snapshots of investment holdings stored in Copilot's
 * /items/{item_id}/accounts/{account_id}/holdings_history/{security_hash}/history/{YYYY-MM}
 * Firestore subcollection.
 *
 * Each document contains:
 * - A map of daily snapshots keyed by millisecond timestamps
 * - Each snapshot has price and quantity at that point in time
 *
 * The security_hash cross-references with investment_prices/{hash} for ticker symbols.
 * The item_id and account_id are extracted from the collection path.
 *
 * IMPORTANT: There are empty container documents at holdings_history/{hash} level
 * that must be filtered out (0 fields). The actual data is in the /history/{YYYY-MM}
 * sub-subcollection.
 */

import { z } from 'zod';

/**
 * Month format regex for YYYY-MM validation.
 */
const MONTH_REGEX = /^\d{4}-\d{2}$/;

/**
 * A single daily snapshot of a holding's price and quantity.
 */
export const HoldingSnapshotSchema = z.object({
  price: z.number(),
  quantity: z.number(),
});

export type HoldingSnapshot = z.infer<typeof HoldingSnapshotSchema>;

/**
 * Holding History schema with validation.
 *
 * Represents a monthly snapshot of an investment holding.
 * Document ID is the month in YYYY-MM format.
 *
 * The raw Firestore `history` map (millisecond timestamps -> {price, quantity})
 * is converted to `snapshots` with ISO date string keys for usability.
 */
export const HoldingHistorySchema = z
  .object({
    // Identifiers (extracted from collection path)
    security_id: z.string(), // The hash that cross-references investment_prices
    account_id: z.string().optional(),
    item_id: z.string().optional(),

    // Month (from document ID)
    month: z.string().regex(MONTH_REGEX, 'Must be YYYY-MM format'),

    // Daily snapshots (converted from ms timestamps to ISO date keys)
    snapshots: z.record(z.string(), HoldingSnapshotSchema).optional(),
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type HoldingHistory = z.infer<typeof HoldingHistorySchema>;
