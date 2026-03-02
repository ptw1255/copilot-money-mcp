/**
 * Balance History model for Copilot Money data.
 *
 * Represents daily balance snapshots stored in Copilot's
 * /items/{item_id}/accounts/{account_id}/balance_history/{YYYY-MM-DD}
 * Firestore subcollection.
 *
 * Each document captures the account balance on a specific date:
 * - Current balance for checking, savings, credit, and investment accounts
 * - Optional available balance (not present on all account types)
 * - Credit limit for credit accounts
 *
 * The item_id and account_id are extracted from the collection path,
 * not from document fields. The document ID is the date (YYYY-MM-DD).
 */

import { z } from 'zod';

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Balance History schema with validation.
 *
 * Represents a daily balance snapshot for an account.
 * Document ID is the date in YYYY-MM-DD format.
 */
export const BalanceHistorySchema = z
  .object({
    // Identifiers (extracted from collection path)
    account_id: z.string(),
    item_id: z.string().optional(),

    // Date (from document ID)
    date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format'),

    // Balance data
    current_balance: z.number(),
    available_balance: z.number().optional(),
    limit: z.number().nullable().optional(),
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type BalanceHistory = z.infer<typeof BalanceHistorySchema>;
