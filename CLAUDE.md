# Copilot Money MCP Server (Wealth Management Fork)

Forked from [ignaciohermosillacornejo/copilot-money-mcp](https://github.com/ignaciohermosillacornejo/copilot-money-mcp). This fork extends the MCP server into a comprehensive wealth management data pipeline — exposing all available financial data so Claude can serve as a personal financial advisor with real numbers.

**Owner:** ptw1255 (GitHub)
**Upstream:** ignaciohermosillacornejo/copilot-money-mcp

## Quick Reference

```bash
bun install          # Install dependencies
bun test             # Run tests (772+ tests)
bun run build        # Build for production
bun run pack:mcpb    # Create .mcpb bundle for Claude Desktop
bun run check        # Run typecheck + lint + format:check + test
bun run fix          # Run lint:fix + format
```

## Active Plan

See `docs/plans/2026-03-02-wealth-management-tools.md` for the full implementation plan.

**Summary:** 5 new MCP tools + 3 enhancements to existing tools across 4 phases:
- Phase 1: Expose already-decoded data (investment prices, splits, connections)
- Phase 2: Decode + expose new collections (balance_history, holdings_history)
- Phase 3: Enhance existing tools (transaction summary, goal history, annual recurring cost)
- Phase 4: Manifest, docs, full test pass

## Architecture

### Data Flow
1. Copilot Money app syncs to local LevelDB/Firestore cache on macOS
2. `src/core/leveldb-reader.ts` copies DB to temp dir (avoids lock conflict with running app)
3. `src/core/protobuf-parser.ts` parses Firestore's binary protobuf wire format
4. `src/core/decoder.ts` routes documents to collection-specific processors, validates with Zod
5. `src/core/database.ts` provides in-memory cache (5-min TTL) with filtered query API
6. `src/tools/tools.ts` implements MCP tool methods with enrichment (category names, merchant normalization)
7. `src/server.ts` handles MCP protocol via stdio transport

### Project Structure

```
src/
├── core/
│   ├── leveldb-reader.ts  # LevelDB I/O, temp-copy, binary key parsing
│   ├── protobuf-parser.ts # Custom protobuf wire format decoder
│   ├── decoder.ts         # Collection processors, Zod validation, batch loader
│   └── database.ts        # CopilotDatabase - cached data access layer
├── models/
│   ├── transaction.ts     # Transaction Zod schema
│   ├── account.ts         # Account Zod schema
│   ├── budget.ts          # Budget Zod schema
│   ├── goal.ts            # Goal + progress helpers
│   ├── goal-history.ts    # Monthly goal snapshots
│   ├── recurring.ts       # Recurring/subscription schema
│   ├── category.ts        # User-defined categories
│   ├── category-full.ts   # Full Plaid category taxonomy (static)
│   ├── investment-price.ts # Investment price data (daily + hf)
│   ├── investment-split.ts # Stock split schema
│   ├── item.ts            # Plaid connection schema
│   └── index.ts           # Barrel exports
├── tools/
│   ├── tools.ts           # All MCP tool implementations + schemas
│   └── index.ts           # Barrel exports
├── utils/
│   ├── date.ts            # parsePeriod() for date range shortcuts
│   └── categories.ts      # 900+ category name mappings, transfer/income detection
├── server.ts              # MCP server (CopilotMoneyServer class)
└── cli.ts                 # CLI entry point with --db-path option
```

## Key Conventions

### Adding a New Tool (4-step pattern)
1. **Schema:** Add input schema in `createToolSchemas()` in `src/tools/tools.ts`
2. **Method:** Implement async method in `CopilotMoneyTools` class
3. **Route:** Add case to switch in `src/server.ts:handleCallTool()`
4. **Manifest:** Add tool to `manifest.json`, run `bun run sync-manifest`
5. **Test:** Add tests in `tests/tools/tools.test.ts`

### Adding a New Collection (full pipeline)
1. **Model:** Create `src/models/<name>.ts` with Zod schema, export from `src/models/index.ts`
2. **Decoder:** Add `process<Name>()` in `decoder.ts`, add to `AllCollectionsResult` interface, add routing + dedup in `decodeAllCollections()`, add standalone `decode<Name>()` export
3. **Database:** Add cache field + loading promise + `load<Name>()` + `get<Name>()` in `database.ts`, update `clearCache()` and `loadAllCollections()`
4. **Tool:** Follow "Adding a New Tool" above

### Code Style
- TypeScript strict mode
- Zod for runtime validation of ALL data models
- ESLint + Prettier enforced via pre-commit hooks
- All tools marked `readOnlyHint: true` (read-only, never modifies user data)
- Process functions return `null` on validation failure (never throw)
- Use `getString/getNumber/getBoolean/getDateString/getMap` helpers for field extraction

### Amount Sign Convention
- **Positive = expense** (money out), **Negative = income** (money in)
- This is the OPPOSITE of standard accounting — be careful when computing totals

### Testing
- Bun test runner
- Tests in `tests/` mirror `src/` structure
- Mock data injected via `(db as any)._fieldName = [...]` pattern
- Run specific: `bun test tests/tools/tools.test.ts -t "testName"`

## Important Notes

- **Privacy First:** 100% local processing, zero network requests
- **Read-Only:** Never modifies Copilot Money database
- **Cache Limitation:** Local DB only holds ~500 recent transactions the app has synced — not full history
- **Database Location:** `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`
- **Undecoded collections:** `balance_history` (1000+ records) and `holdings_history` (500+ records) exist in the DB but need schema discovery before decoding
