# Wealth Management Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose all hidden financial data (investment prices, splits, connections, balance history, holdings history) as new MCP tools and enhance existing tools with richer context, turning the MCP server into a comprehensive wealth management data pipeline for Claude.

**Architecture:** Three phases — (1) expose already-decoded-but-unexposed data as new tools, (2) decode and expose the two undecoded collections (balance_history, holdings_history), (3) enhance existing tools with richer financial context. Each phase follows the existing codebase patterns: Zod model → decoder processor → database cache/accessor → tool method → tool schema → server routing → manifest.

**Tech Stack:** TypeScript, Zod (runtime validation), Bun (test runner + runtime), MCP SDK, LevelDB (classic-level), custom protobuf parser.

---

## Phase 1: Expose Already-Decoded Data (3 New Tools)

Investment prices, investment splits, and items (Plaid connections) are already decoded by `decoder.ts` and cached by `database.ts` — they just lack MCP tool endpoints. This phase wires them up.

### Task 1: Add `get_investment_prices` Tool

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts:97-152` (add switch case)
- Modify: `manifest.json` (add tool entry)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

Add to `tests/tools/tools.test.ts`:

```typescript
describe('CopilotMoneyTools.getInvestmentPrices', () => {
  test('returns all investment prices', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('prices');
    expect(result).toHaveProperty('tickers');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'AAPL' });
    for (const price of result.prices) {
      expect(price.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by date range', async () => {
    const result = await tools.getInvestmentPrices({
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  test('filters by price_type', async () => {
    const result = await tools.getInvestmentPrices({ price_type: 'daily' });
    for (const price of result.prices) {
      expect(price.price_type).toBe('daily');
    }
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentPrices({ limit: 5, offset: 0 });
    expect(result.prices.length).toBeLessThanOrEqual(5);
    expect(result).toHaveProperty('has_more');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getInvestmentPrices"`
Expected: FAIL with "tools.getInvestmentPrices is not a function"

**Step 3: Implement the tool method**

Add to `src/tools/tools.ts` in the `CopilotMoneyTools` class (after `getGoals` method, around line 1805):

```typescript
async getInvestmentPrices(options: {
  ticker_symbol?: string;
  start_date?: string;
  end_date?: string;
  price_type?: 'daily' | 'hf';
  limit?: number;
  offset?: number;
} = {}): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  tickers: string[];
  prices: InvestmentPrice[];
}> {
  const {
    ticker_symbol,
    start_date,
    end_date,
    price_type,
  } = options;

  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const prices = await this.db.getInvestmentPrices({
    tickerSymbol: ticker_symbol,
    startDate: start_date,
    endDate: end_date,
    priceType: price_type,
  });

  // Extract unique tickers
  const tickerSet = new Set<string>();
  for (const p of prices) {
    if (p.ticker_symbol) tickerSet.add(p.ticker_symbol);
  }

  const totalCount = prices.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = prices.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    tickers: [...tickerSet].sort(),
    prices: paged,
  };
}
```

Note: You'll need to add `InvestmentPrice` to the imports at the top of tools.ts:
```typescript
import type { Transaction, Account, InvestmentPrice, InvestmentSplit, Item } from '../models/index.js';
```

**Step 4: Add the tool schema**

Add to the `createToolSchemas()` return array in `src/tools/tools.ts`:

```typescript
{
  name: 'get_investment_prices',
  description:
    'Get investment price history for portfolio tracking. Returns daily and high-frequency ' +
    'price data for stocks, ETFs, mutual funds, and crypto. Filter by ticker symbol, date range, ' +
    'or price type (daily/hf). Includes OHLCV data when available. ' +
    'Use this with get_investment_splits for accurate historical price calculations.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "BTC-USD", "VTSAX")',
      },
      start_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD or YYYY-MM)',
        pattern: '^\\d{4}-\\d{2}(-\\d{2})?$',
      },
      end_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD or YYYY-MM)',
        pattern: '^\\d{4}-\\d{2}(-\\d{2})?$',
      },
      price_type: {
        type: 'string',
        enum: ['daily', 'hf'],
        description: 'Filter by price type: daily (monthly aggregates) or hf (high-frequency intraday)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default: 100)',
        default: 100,
      },
      offset: {
        type: 'integer',
        description: 'Number of results to skip for pagination (default: 0)',
        default: 0,
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
},
```

**Step 5: Add server routing**

Add to `src/server.ts` in the `handleCallTool` switch statement (before the `default` case):

```typescript
case 'get_investment_prices':
  result = await this.tools.getInvestmentPrices(
    (typedArgs as Parameters<typeof this.tools.getInvestmentPrices>[0]) || {}
  );
  break;
```

**Step 6: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getInvestmentPrices"`
Expected: PASS (note: tests may show 0 prices if mock data doesn't include investment prices — that's ok, the structure test still validates)

**Step 7: Commit**

```bash
cd /Users/parker/copilot-money-mcp
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add get_investment_prices MCP tool

Exposes already-decoded investment price data as a queryable tool.
Supports filtering by ticker, date range, and price type (daily/hf)
with pagination."
```

---

### Task 2: Add `get_investment_splits` Tool

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts` (add switch case)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('CopilotMoneyTools.getInvestmentSplits', () => {
  test('returns all investment splits', async () => {
    const result = await tools.getInvestmentSplits({});
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('splits');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'AAPL' });
    for (const split of result.splits) {
      expect(split.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by date range', async () => {
    const result = await tools.getInvestmentSplits({
      start_date: '2020-01-01',
      end_date: '2025-12-31',
    });
    expect(result.count).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getInvestmentSplits"`
Expected: FAIL

**Step 3: Implement the tool method**

Add to `CopilotMoneyTools` class:

```typescript
async getInvestmentSplits(options: {
  ticker_symbol?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  splits: InvestmentSplit[];
}> {
  const { ticker_symbol, start_date, end_date } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const splits = await this.db.getInvestmentSplits({
    tickerSymbol: ticker_symbol,
    startDate: start_date,
    endDate: end_date,
  });

  const totalCount = splits.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = splits.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    splits: paged,
  };
}
```

**Step 4: Add the tool schema**

```typescript
{
  name: 'get_investment_splits',
  description:
    'Get stock split history. Returns split ratios, dates, and multipliers for ' +
    'accurate historical price and share calculations. Filter by ticker symbol or date range.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "TSLA")',
      },
      start_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      end_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default: 100)',
        default: 100,
      },
      offset: {
        type: 'integer',
        description: 'Number of results to skip for pagination (default: 0)',
        default: 0,
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
},
```

**Step 5: Add server routing**

```typescript
case 'get_investment_splits':
  result = await this.tools.getInvestmentSplits(
    (typedArgs as Parameters<typeof this.tools.getInvestmentSplits>[0]) || {}
  );
  break;
```

**Step 6: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getInvestmentSplits"`
Expected: PASS

**Step 7: Commit**

```bash
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add get_investment_splits MCP tool

Exposes stock split history for accurate historical calculations.
Filter by ticker symbol and date range."
```

---

### Task 3: Add `get_connections` Tool

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts` (add switch case)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('CopilotMoneyTools.getConnections', () => {
  test('returns all connections', async () => {
    const result = await tools.getConnections({});
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('connections');
  });

  test('filters by connection_status', async () => {
    const result = await tools.getConnections({ connection_status: 'active' });
    for (const conn of result.connections) {
      expect(conn.connection_status).toBe('active');
    }
  });

  test('filters by needs_update', async () => {
    const result = await tools.getConnections({ needs_update: true });
    for (const conn of result.connections) {
      expect(conn.needs_update).toBe(true);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getConnections"`
Expected: FAIL

**Step 3: Implement the tool method**

```typescript
async getConnections(options: {
  connection_status?: string;
  institution_id?: string;
  needs_update?: boolean;
} = {}): Promise<{
  count: number;
  connections: Item[];
}> {
  const connections = await this.db.getItems({
    connectionStatus: options.connection_status,
    institutionId: options.institution_id,
    needsUpdate: options.needs_update,
  });

  return {
    count: connections.length,
    connections,
  };
}
```

**Step 4: Add the tool schema**

```typescript
{
  name: 'get_connections',
  description:
    'Get Plaid connection health for linked financial institutions. Shows connection status, ' +
    'last sync times, error codes, and whether re-authentication is needed. ' +
    'Use this to check if account data is fresh and all institutions are connected properly.',
  inputSchema: {
    type: 'object',
    properties: {
      connection_status: {
        type: 'string',
        description: 'Filter by status (e.g., "active", "error", "disconnected")',
      },
      institution_id: {
        type: 'string',
        description: 'Filter by Plaid institution ID',
      },
      needs_update: {
        type: 'boolean',
        description: 'Filter by whether connection needs re-authentication',
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
},
```

**Step 5: Add server routing**

```typescript
case 'get_connections':
  result = await this.tools.getConnections(
    (typedArgs as Parameters<typeof this.tools.getConnections>[0]) || {}
  );
  break;
```

**Step 6: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getConnections"`
Expected: PASS

**Step 7: Commit**

```bash
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add get_connections MCP tool

Exposes Plaid connection health data - status, sync times,
errors, and re-auth needs for linked institutions."
```

---

## Phase 2: Decode New Collections (2 New Tools)

The `balance_history` and `holdings_history` collections exist in the LevelDB cache but have no decoder, model, or tool. We need to discover their schema, then build the full pipeline.

### Task 4: Discover `balance_history` and `holdings_history` Field Schemas

**Files:**
- Create: `scripts/discover-collections.ts`

**Step 1: Write a discovery script**

Create `scripts/discover-collections.ts`:

```typescript
/**
 * Discovery script to inspect undocumented Firestore collections.
 * Iterates the LevelDB and dumps sample documents from target collections.
 *
 * Usage: bun run scripts/discover-collections.ts [--db-path /path/to/db]
 */
import { iterateDocuments } from '../src/core/leveldb-reader.js';
import { toPlainObject } from '../src/core/protobuf-parser.js';
import { homedir } from 'os';
import { join } from 'path';

const TARGET_COLLECTIONS = ['balance_history', 'holdings_history'];
const MAX_SAMPLES = 3;

async function discover(dbPath: string) {
  const samples: Record<string, unknown[]> = {};
  for (const col of TARGET_COLLECTIONS) {
    samples[col] = [];
  }

  for await (const doc of iterateDocuments(dbPath)) {
    for (const target of TARGET_COLLECTIONS) {
      if (
        doc.collection === target ||
        doc.collection.endsWith(`/${target}`) ||
        doc.collection.includes(`${target}/`)
      ) {
        if (samples[target].length < MAX_SAMPLES) {
          const plain = Object.fromEntries(
            [...doc.fields.entries()].map(([k, v]) => [k, toPlainObject(new Map([[k, v]]))])
          );
          samples[target].push({
            collection: doc.collection,
            documentId: doc.documentId,
            key: doc.key,
            fields: plain,
          });
        }
      }
    }

    // Stop early if we have enough samples
    const allDone = TARGET_COLLECTIONS.every((col) => samples[col].length >= MAX_SAMPLES);
    if (allDone) break;
  }

  for (const col of TARGET_COLLECTIONS) {
    console.log(`\n=== ${col} (${samples[col].length} samples) ===`);
    console.log(JSON.stringify(samples[col], null, 2));
  }
}

// Default DB path
const dbPath =
  process.argv.includes('--db-path')
    ? process.argv[process.argv.indexOf('--db-path') + 1]
    : join(
        homedir(),
        'Library/Containers/com.copilot.production/Data/Library',
        'Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main'
      );

discover(dbPath).catch(console.error);
```

**Step 2: Run the discovery script**

Run: `cd /Users/parker/copilot-money-mcp && bun run scripts/discover-collections.ts`

**Step 3: Analyze the output**

Examine the JSON output to determine:
- The exact Firestore path pattern (e.g., `users/{user_id}/balance_history/{date}`)
- Field names and types for each collection
- Document ID format (date? account_id? composite?)
- Any nested objects or subcollections

**Step 4: Document findings**

Update `docs/firestore-collections.md` with the discovered schemas for both collections, following the existing documentation format.

**Step 5: Commit**

```bash
git add scripts/discover-collections.ts docs/firestore-collections.md
git commit -m "chore: add collection discovery script, document balance_history and holdings_history schemas"
```

---

### Task 5: Add `BalanceHistory` Model

**Files:**
- Create: `src/models/balance-history.ts`
- Modify: `src/models/index.ts`

**Step 1: Create the model file**

Based on Task 4's discovery, create `src/models/balance-history.ts`. The schema below is a best-guess template — adjust field names after running the discovery script:

```typescript
import { z } from 'zod';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const BalanceHistorySchema = z
  .object({
    account_id: z.string(),
    date: z.string().regex(DATE_REGEX),
    balance: z.number(),
    available_balance: z.number().optional(),
    user_id: z.string().optional(),
    iso_currency_code: z.string().optional(),
  })
  .passthrough();

export type BalanceHistory = z.infer<typeof BalanceHistorySchema>;
```

**Step 2: Export from models index**

Add to `src/models/index.ts`:

```typescript
export { BalanceHistorySchema, type BalanceHistory } from './balance-history.js';
```

**Step 3: Run typecheck**

Run: `cd /Users/parker/copilot-money-mcp && bun run check`
Expected: PASS (no type errors)

**Step 4: Commit**

```bash
git add src/models/balance-history.ts src/models/index.ts
git commit -m "feat: add BalanceHistory Zod model"
```

---

### Task 6: Add `HoldingHistory` Model

**Files:**
- Create: `src/models/holding-history.ts`
- Modify: `src/models/index.ts`

**Step 1: Create the model file**

Based on Task 4's discovery, create `src/models/holding-history.ts`:

```typescript
import { z } from 'zod';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const HoldingHistorySchema = z
  .object({
    holding_id: z.string(),
    account_id: z.string().optional(),
    ticker_symbol: z.string().optional(),
    security_id: z.string().optional(),
    quantity: z.number().optional(),
    cost_basis: z.number().optional(),
    value: z.number().optional(),
    price: z.number().optional(),
    date: z.string().regex(DATE_REGEX).optional(),
    iso_currency_code: z.string().optional(),
    user_id: z.string().optional(),
  })
  .passthrough();

export type HoldingHistory = z.infer<typeof HoldingHistorySchema>;
```

**Step 2: Export from models index**

Add to `src/models/index.ts`:

```typescript
export { HoldingHistorySchema, type HoldingHistory } from './holding-history.js';
```

**Step 3: Run typecheck**

Run: `cd /Users/parker/copilot-money-mcp && bun run check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/models/holding-history.ts src/models/index.ts
git commit -m "feat: add HoldingHistory Zod model"
```

---

### Task 7: Add Decoders for `balance_history` and `holdings_history`

**Files:**
- Modify: `src/core/decoder.ts` (add process functions, update AllCollectionsResult, update decodeAllCollections)
- Test: `tests/core/decoder-coverage.test.ts`

**Step 1: Write failing tests**

Add to `tests/core/decoder-coverage.test.ts`:

```typescript
describe('processBalanceHistory', () => {
  test('decodes balance history document', () => {
    // Test will be written using actual field names from discovery
  });
});

describe('processHoldingHistory', () => {
  test('decodes holding history document', () => {
    // Test will be written using actual field names from discovery
  });
});
```

**Step 2: Add imports to decoder.ts**

At the top of `src/core/decoder.ts`:

```typescript
import { BalanceHistory, BalanceHistorySchema } from '../models/balance-history.js';
import { HoldingHistory, HoldingHistorySchema } from '../models/holding-history.js';
```

**Step 3: Add `processBalanceHistory` function**

Add after the other process functions (adjust field names per discovery):

```typescript
function processBalanceHistory(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): BalanceHistory | null {
  const balance = getNumber(fields, 'balance') ?? getNumber(fields, 'current_balance');
  if (balance === undefined) return null;

  // Extract account_id from collection path if present
  const pathSegments = collection.split('/');
  const accountId = getString(fields, 'account_id') ?? docId;
  const date = getDateString(fields, 'date') ?? docId;

  const data: Record<string, unknown> = {
    account_id: accountId,
    date,
    balance,
  };

  const optionalNumbers = ['available_balance'];
  for (const field of optionalNumbers) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const optionalStrings = ['user_id', 'iso_currency_code'];
  for (const field of optionalStrings) {
    const value = getString(fields, field);
    if (value) data[field] = value;
  }

  try {
    return BalanceHistorySchema.parse(data);
  } catch {
    return null;
  }
}
```

**Step 4: Add `processHoldingHistory` function**

```typescript
function processHoldingHistory(
  fields: Map<string, FirestoreValue>,
  docId: string,
  _collection: string
): HoldingHistory | null {
  const holdingId = getString(fields, 'holding_id') ?? getString(fields, 'id') ?? docId;

  const data: Record<string, unknown> = {
    holding_id: holdingId,
  };

  const optionalStrings = [
    'account_id', 'ticker_symbol', 'security_id',
    'iso_currency_code', 'user_id',
  ];
  for (const field of optionalStrings) {
    const value = getString(fields, field);
    if (value) data[field] = value;
  }

  const optionalNumbers = ['quantity', 'cost_basis', 'value', 'price'];
  for (const field of optionalNumbers) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const date = getDateString(fields, 'date');
  if (date) data.date = date;

  try {
    return HoldingHistorySchema.parse(data);
  } catch {
    return null;
  }
}
```

**Step 5: Update `AllCollectionsResult` interface**

In `src/core/decoder.ts`, update the interface (around line 619):

```typescript
export interface AllCollectionsResult {
  transactions: Transaction[];
  accounts: Account[];
  recurring: Recurring[];
  budgets: Budget[];
  goals: Goal[];
  goalHistory: GoalHistory[];
  investmentPrices: InvestmentPrice[];
  investmentSplits: InvestmentSplit[];
  items: Item[];
  categories: Category[];
  userAccounts: UserAccountCustomization[];
  balanceHistory: BalanceHistory[];    // NEW
  holdingHistory: HoldingHistory[];    // NEW
}
```

**Step 6: Update `decodeAllCollections` function**

Add raw arrays at the top of the function (around line 1258):

```typescript
const rawBalanceHistory: BalanceHistory[] = [];
const rawHoldingHistory: HoldingHistory[] = [];
```

Add routing in the `for await` loop (before the final `else if` for categories):

```typescript
} else if (
  collectionMatches(collection, 'balance_history') ||
  collection.includes('balance_history/')
) {
  const bh = processBalanceHistory(fields, documentId, collection);
  if (bh) rawBalanceHistory.push(bh);
} else if (
  collectionMatches(collection, 'holdings_history') ||
  collection.includes('holdings_history/')
) {
  const hh = processHoldingHistory(fields, documentId, collection);
  if (hh) rawHoldingHistory.push(hh);
}
```

Add deduplication and sorting after the existing dedup blocks:

```typescript
// Balance history: dedupe by account_id + date, sort by date desc
const bhSeen = new Set<string>();
const balanceHistory: BalanceHistory[] = [];
for (const bh of rawBalanceHistory) {
  const key = `${bh.account_id}|${bh.date}`;
  if (!bhSeen.has(key)) {
    bhSeen.add(key);
    balanceHistory.push(bh);
  }
}
balanceHistory.sort((a, b) => b.date.localeCompare(a.date));

// Holding history: dedupe by holding_id + date
const hhSeen = new Set<string>();
const holdingHistory: HoldingHistory[] = [];
for (const hh of rawHoldingHistory) {
  const key = `${hh.holding_id}|${hh.date ?? ''}`;
  if (!hhSeen.has(key)) {
    hhSeen.add(key);
    holdingHistory.push(hh);
  }
}
holdingHistory.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
```

Add to the return object:

```typescript
return {
  // ... existing fields ...
  balanceHistory,
  holdingHistory,
};
```

**Step 7: Also export standalone decode functions**

Add these exported functions (following the pattern of existing standalone decoders):

```typescript
export async function decodeBalanceHistory(dbPath: string): Promise<BalanceHistory[]> {
  const items: BalanceHistory[] = [];
  for await (const doc of iterateDocuments(dbPath, { collection: 'balance_history' })) {
    const item = processBalanceHistory(doc.fields, doc.documentId, doc.collection);
    if (item) items.push(item);
  }
  // Deduplicate
  const seen = new Set<string>();
  const unique: BalanceHistory[] = [];
  for (const bh of items) {
    const key = `${bh.account_id}|${bh.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(bh);
    }
  }
  unique.sort((a, b) => b.date.localeCompare(a.date));
  return unique;
}

export async function decodeHoldingHistory(dbPath: string): Promise<HoldingHistory[]> {
  const items: HoldingHistory[] = [];
  for await (const doc of iterateDocuments(dbPath, { collection: 'holdings_history' })) {
    const item = processHoldingHistory(doc.fields, doc.documentId, doc.collection);
    if (item) items.push(item);
  }
  const seen = new Set<string>();
  const unique: HoldingHistory[] = [];
  for (const hh of items) {
    const key = `${hh.holding_id}|${hh.date ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(hh);
    }
  }
  unique.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return unique;
}
```

**Step 8: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/core/`
Expected: PASS (existing tests should still pass, new decode functions exist)

**Step 9: Commit**

```bash
git add src/core/decoder.ts src/models/ tests/core/
git commit -m "feat: add decoders for balance_history and holdings_history collections

Parses previously-undecoded Firestore collections for historical
account balances and investment holdings. Integrates into the
single-pass decodeAllCollections batch loader."
```

---

### Task 8: Add Database Cache and Accessors for New Collections

**Files:**
- Modify: `src/core/database.ts` (add cache fields, load methods, accessor methods)

**Step 1: Add imports**

At the top of `src/core/database.ts`, add to the decoder imports:

```typescript
import {
  // ... existing imports ...
  decodeBalanceHistory,
  decodeHoldingHistory,
} from './decoder.js';
```

And add model imports:

```typescript
import {
  // ... existing imports ...
  BalanceHistory,
  HoldingHistory,
} from '../models/index.js';
```

**Step 2: Add cache fields**

In the `CopilotDatabase` class, add alongside existing cache fields:

```typescript
private _balanceHistory: BalanceHistory[] | null = null;
private _holdingHistory: HoldingHistory[] | null = null;

// In-flight loading promises
private _loadingBalanceHistory: Promise<BalanceHistory[]> | null = null;
private _loadingHoldingHistory: Promise<HoldingHistory[]> | null = null;
```

**Step 3: Update `clearCache`**

Add to the `clearCache()` method:

```typescript
this._balanceHistory = null;
this._holdingHistory = null;
this._loadingBalanceHistory = null;
this._loadingHoldingHistory = null;
```

**Step 4: Update `loadAllCollections`**

In the `loadAllCollections` method, add to the cache population block:

```typescript
this._balanceHistory = result.balanceHistory;
this._holdingHistory = result.holdingHistory;
```

**Step 5: Add load methods**

```typescript
private async loadBalanceHistory(): Promise<BalanceHistory[]> {
  if (this._balanceHistory !== null) return this._balanceHistory;
  if (!this._allCollectionsLoaded) {
    await this.loadAllCollections();
    return this._balanceHistory ?? [];
  }
  if (this._loadingBalanceHistory !== null) return this._loadingBalanceHistory;
  this._loadingBalanceHistory = decodeBalanceHistory(this.requireDbPath());
  try {
    this._balanceHistory = await this._loadingBalanceHistory;
    return this._balanceHistory;
  } finally {
    this._loadingBalanceHistory = null;
  }
}

private async loadHoldingHistory(): Promise<HoldingHistory[]> {
  if (this._holdingHistory !== null) return this._holdingHistory;
  if (!this._allCollectionsLoaded) {
    await this.loadAllCollections();
    return this._holdingHistory ?? [];
  }
  if (this._loadingHoldingHistory !== null) return this._loadingHoldingHistory;
  this._loadingHoldingHistory = decodeHoldingHistory(this.requireDbPath());
  try {
    this._holdingHistory = await this._loadingHoldingHistory;
    return this._holdingHistory;
  } finally {
    this._loadingHoldingHistory = null;
  }
}
```

**Step 6: Add accessor methods**

```typescript
async getBalanceHistory(options: {
  accountId?: string;
  startDate?: string;
  endDate?: string;
} = {}): Promise<BalanceHistory[]> {
  const { accountId, startDate, endDate } = options;
  const all = await this.loadBalanceHistory();
  let result = [...all];

  if (accountId) {
    result = result.filter((bh) => bh.account_id === accountId);
  }
  if (startDate) {
    result = result.filter((bh) => bh.date >= startDate);
  }
  if (endDate) {
    result = result.filter((bh) => bh.date <= endDate);
  }

  return result;
}

async getHoldingHistory(options: {
  accountId?: string;
  tickerSymbol?: string;
  startDate?: string;
  endDate?: string;
} = {}): Promise<HoldingHistory[]> {
  const { accountId, tickerSymbol, startDate, endDate } = options;
  const all = await this.loadHoldingHistory();
  let result = [...all];

  if (accountId) {
    result = result.filter((hh) => hh.account_id === accountId);
  }
  if (tickerSymbol) {
    result = result.filter((hh) => hh.ticker_symbol === tickerSymbol);
  }
  if (startDate) {
    result = result.filter((hh) => hh.date && hh.date >= startDate);
  }
  if (endDate) {
    result = result.filter((hh) => hh.date && hh.date <= endDate);
  }

  return result;
}
```

**Step 7: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/core/database.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/core/database.ts
git commit -m "feat: add database cache and accessors for balance_history and holdings_history"
```

---

### Task 9: Add `get_balance_history` Tool

**Files:**
- Modify: `src/tools/tools.ts`
- Modify: `src/server.ts`
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('CopilotMoneyTools.getBalanceHistory', () => {
  test('returns balance history', async () => {
    const result = await tools.getBalanceHistory({});
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('history');
  });

  test('filters by account_id', async () => {
    const result = await tools.getBalanceHistory({ account_id: 'acc1' });
    for (const entry of result.history) {
      expect(entry.account_id).toBe('acc1');
    }
  });

  test('filters by date range', async () => {
    const result = await tools.getBalanceHistory({
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.count).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getBalanceHistory"`
Expected: FAIL

**Step 3: Implement the tool method**

Add to `CopilotMoneyTools`:

```typescript
async getBalanceHistory(options: {
  account_id?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  history: BalanceHistory[];
}> {
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const history = await this.db.getBalanceHistory({
    accountId: options.account_id,
    startDate: options.start_date,
    endDate: options.end_date,
  });

  const totalCount = history.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = history.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    history: paged,
  };
}
```

Note: Add `BalanceHistory` and `HoldingHistory` to the imports in tools.ts.

**Step 4: Add tool schema**

```typescript
{
  name: 'get_balance_history',
  description:
    'Get historical account balance snapshots over time. Enables net worth tracking, ' +
    'balance trend analysis, and financial health monitoring. Filter by account and date range. ' +
    'Each entry contains the account balance on a specific date.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Filter by account ID',
      },
      start_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      end_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default: 100)',
        default: 100,
      },
      offset: {
        type: 'integer',
        description: 'Number of results to skip for pagination (default: 0)',
        default: 0,
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
},
```

**Step 5: Add server routing**

```typescript
case 'get_balance_history':
  result = await this.tools.getBalanceHistory(
    (typedArgs as Parameters<typeof this.tools.getBalanceHistory>[0]) || {}
  );
  break;
```

**Step 6: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getBalanceHistory"`
Expected: PASS

**Step 7: Commit**

```bash
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add get_balance_history MCP tool

Exposes historical account balance snapshots for net worth
tracking and trend analysis."
```

---

### Task 10: Add `get_holdings` Tool

**Files:**
- Modify: `src/tools/tools.ts`
- Modify: `src/server.ts`
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('CopilotMoneyTools.getHoldings', () => {
  test('returns holdings history', async () => {
    const result = await tools.getHoldings({});
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('holdings');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'AAPL' });
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by account_id', async () => {
    const result = await tools.getHoldings({ account_id: 'inv1' });
    for (const h of result.holdings) {
      expect(h.account_id).toBe('inv1');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getHoldings"`
Expected: FAIL

**Step 3: Implement the tool method**

```typescript
async getHoldings(options: {
  account_id?: string;
  ticker_symbol?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  holdings: HoldingHistory[];
}> {
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const holdings = await this.db.getHoldingHistory({
    accountId: options.account_id,
    tickerSymbol: options.ticker_symbol,
    startDate: options.start_date,
    endDate: options.end_date,
  });

  const totalCount = holdings.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = holdings.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    holdings: paged,
  };
}
```

**Step 4: Add tool schema**

```typescript
{
  name: 'get_holdings',
  description:
    'Get investment holdings history - positions in stocks, ETFs, mutual funds, and crypto. ' +
    'Shows ticker, quantity, cost basis, current value, and price per share over time. ' +
    'Filter by account, ticker symbol, or date range. Use with get_investment_prices ' +
    'for detailed performance analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Filter by investment account ID',
      },
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
      },
      start_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      end_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD)',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default: 100)',
        default: 100,
      },
      offset: {
        type: 'integer',
        description: 'Number of results to skip for pagination (default: 0)',
        default: 0,
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
},
```

**Step 5: Add server routing**

```typescript
case 'get_holdings':
  result = await this.tools.getHoldings(
    (typedArgs as Parameters<typeof this.tools.getHoldings>[0]) || {}
  );
  break;
```

**Step 6: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "getHoldings"`
Expected: PASS

**Step 7: Commit**

```bash
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add get_holdings MCP tool

Exposes investment holdings history for portfolio analysis -
positions, quantities, cost basis, and values over time."
```

---

## Phase 3: Enhance Existing Tools

### Task 11: Enhance `get_transactions` with `include_summary` Flag

**Files:**
- Modify: `src/tools/tools.ts` (update getTransactions method + schema)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('getTransactions include_summary', () => {
  test('returns summary when include_summary is true', async () => {
    const result = await tools.getTransactions({
      period: 'this_month',
      include_summary: true,
    });
    expect(result).toHaveProperty('summary');
    expect(result.summary).toHaveProperty('total_income');
    expect(result.summary).toHaveProperty('total_expenses');
    expect(result.summary).toHaveProperty('net');
    expect(result.summary).toHaveProperty('savings_rate');
  });

  test('does not return summary by default', async () => {
    const result = await tools.getTransactions({ period: 'this_month' });
    expect(result).not.toHaveProperty('summary');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "include_summary"`
Expected: FAIL

**Step 3: Update the getTransactions method**

In the `getTransactions` method, add `include_summary` to the options type and, after computing the final transactions array but before returning, add:

```typescript
// Compute summary if requested (uses ALL filtered transactions, not just the paged subset)
let summary: {
  total_income: number;
  total_expenses: number;
  net: number;
  savings_rate: number;
  transaction_count: number;
} | undefined;

if (options.include_summary) {
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const txn of allFilteredTransactions) {
    if (txn.amount < 0) {
      // Negative = income in Copilot's convention
      totalIncome += Math.abs(txn.amount);
    } else {
      totalExpenses += txn.amount;
    }
  }

  const net = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? (net / totalIncome) * 100 : 0;

  summary = {
    total_income: roundAmount(totalIncome),
    total_expenses: roundAmount(totalExpenses),
    net: roundAmount(net),
    savings_rate: roundAmount(savingsRate),
    transaction_count: allFilteredTransactions.length,
  };
}
```

Add `summary` to the return object (conditionally):

```typescript
return {
  // ... existing fields ...
  ...(summary && { summary }),
};
```

**Step 4: Update the tool schema**

Add to the `get_transactions` schema properties:

```typescript
include_summary: {
  type: 'boolean',
  description:
    'Include income/expense/net summary for the queried period (default: false). ' +
    'Summary is computed across ALL matching transactions, not just the paged subset.',
  default: false,
},
```

**Step 5: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "include_summary"`
Expected: PASS

**Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add include_summary flag to get_transactions

Returns total income, expenses, net, and savings rate for the
queried period. Summary covers all matching transactions, not
just the paged subset."
```

---

### Task 12: Enhance `get_goals` with Full History

**Files:**
- Modify: `src/tools/tools.ts` (update getGoals method + schema)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('getGoals include_history', () => {
  test('includes monthly history when include_history is true', async () => {
    const result = await tools.getGoals({ include_history: true });
    for (const goal of result.goals) {
      expect(goal).toHaveProperty('history');
      if (goal.history) {
        expect(Array.isArray(goal.history)).toBe(true);
      }
    }
  });

  test('does not include history by default', async () => {
    const result = await tools.getGoals({});
    for (const goal of result.goals) {
      expect(goal).not.toHaveProperty('history');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "include_history"`
Expected: FAIL

**Step 3: Update the getGoals method**

Add `include_history?: boolean` to the options. When true, attach the full `GoalHistory[]` for each goal:

```typescript
const { active_only = false, include_history = false } = options;

// ... existing logic to build goals ...

// If include_history, attach the full history array per goal
if (include_history) {
  // Group history by goal_id
  const historyByGoal = new Map<string, GoalHistory[]>();
  for (const h of goalHistory) {
    const list = historyByGoal.get(h.goal_id) ?? [];
    list.push(h);
    historyByGoal.set(h.goal_id, list);
  }

  return {
    count: goals.length,
    total_target: roundAmount(totalTarget),
    total_saved: roundAmount(totalSaved),
    goals: goals.map((g) => ({
      // ... existing fields ...
      history: historyByGoal.get(g.goal_id) ?? [],
    })),
  };
}
```

**Step 4: Update the tool schema**

Add to `get_goals` schema properties:

```typescript
include_history: {
  type: 'boolean',
  description:
    'Include full monthly history (snapshots with current_amount, daily_data, contributions) ' +
    'for each goal (default: false). Useful for tracking goal progress over time.',
  default: false,
},
```

**Step 5: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "include_history"`
Expected: PASS

**Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add include_history flag to get_goals

Optionally returns full monthly progress snapshots per goal,
including daily data and contributions."
```

---

### Task 13: Enhance `get_recurring_transactions` with Annual Cost

**Files:**
- Modify: `src/tools/tools.ts` (update getRecurringTransactions)
- Test: `tests/tools/tools.test.ts`

**Step 1: Write the failing test**

```typescript
describe('getRecurringTransactions annual cost', () => {
  test('copilot subscriptions include annual_cost', async () => {
    const result = await tools.getRecurringTransactions({
      include_copilot_subscriptions: true,
    });
    if (result.copilot_subscriptions) {
      for (const group of Object.values(result.copilot_subscriptions)) {
        if (Array.isArray(group)) {
          for (const sub of group) {
            if (sub.amount && sub.frequency) {
              expect(sub).toHaveProperty('annual_cost');
            }
          }
        }
      }
    }
  });
});
```

**Step 2: Implement annual cost calculation**

In the section of `getRecurringTransactions` that builds the Copilot subscriptions response, add an `annual_cost` field to each subscription entry:

```typescript
function calculateAnnualCost(amount: number, frequency: string): number {
  const multipliers: Record<string, number> = {
    daily: 365,
    weekly: 52,
    biweekly: 26,
    monthly: 12,
    bimonthly: 6,
    quarterly: 4,
    quadmonthly: 3,
    semiannually: 2,
    annually: 1,
    yearly: 1,
  };
  return roundAmount(Math.abs(amount) * (multipliers[frequency] ?? 12));
}
```

Add `annual_cost: calculateAnnualCost(rec.amount, rec.frequency)` to each subscription object in the copilot_subscriptions mapping.

**Step 3: Run tests**

Run: `cd /Users/parker/copilot-money-mcp && bun test tests/tools/tools.test.ts -t "annual cost"`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add annual_cost to recurring subscriptions

Calculates annualized cost based on subscription frequency
for easier financial planning."
```

---

## Phase 4: Finalize

### Task 14: Update `manifest.json`

**Files:**
- Modify: `manifest.json`

**Step 1: Add all 5 new tools to the manifest tools array**

Follow the existing pattern in `manifest.json` — each tool has `name` and `description`. Add entries for:
- `get_investment_prices`
- `get_investment_splits`
- `get_connections`
- `get_balance_history`
- `get_holdings`

**Step 2: Run sync check**

Run: `cd /Users/parker/copilot-money-mcp && bun run sync-manifest`
Expected: Manifest matches code (or auto-fixes)

**Step 3: Commit**

```bash
git add manifest.json
git commit -m "chore: update manifest.json with 5 new wealth management tools"
```

---

### Task 15: Update Documentation

**Files:**
- Modify: `docs/firestore-collections.md` (add balance_history and holdings_history)

**Step 1: Document the new collections**

Add sections for `balance_history` and `holdings_history` with the field schemas discovered in Task 4.

**Step 2: Commit**

```bash
git add docs/firestore-collections.md
git commit -m "docs: document balance_history and holdings_history collection schemas"
```

---

### Task 16: Full Test Suite + Typecheck

**Step 1: Run full check**

Run: `cd /Users/parker/copilot-money-mcp && bun run check`

This runs: typecheck + lint + format:check + test (772+ tests)

Expected: All pass.

**Step 2: Fix any issues found**

If lint or format issues: `bun run fix`
If type errors: fix them.

**Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "chore: fix lint/format/type issues from wealth management tools"
```

---

## Summary

| Phase | Tasks | New/Modified Files | Result |
|-------|-------|--------------------|--------|
| 1 | Tasks 1-3 | tools.ts, server.ts, tests | 3 new tools (investment prices, splits, connections) |
| 2 | Tasks 4-10 | models/*, decoder.ts, database.ts, tools.ts, server.ts, tests | 2 new tools (balance history, holdings) + 2 new models + discovery script |
| 3 | Tasks 11-13 | tools.ts, tests | 3 enhanced tools (transactions summary, goals history, recurring annual cost) |
| 4 | Tasks 14-16 | manifest.json, docs, full test | Polish and validation |

**Total: 5 new MCP tools + 3 enhancements to existing tools = 13 tools total**
