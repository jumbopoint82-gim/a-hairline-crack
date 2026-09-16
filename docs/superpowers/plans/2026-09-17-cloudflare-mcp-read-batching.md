# Cloudflare MCP Read Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Cloudflare MCP read path faster and more resilient by batching Google Docs reads, preserving partial successes, and preventing duplicate OAuth token exchanges.

**Architecture:** Keep the existing v0.4 implementation intact as rollback material. Add focused batch/single-flight helpers, move the active integration and MCP server logic into v2 modules, and switch only the thin Worker entrypoint. Existing write ordering and stale-write protection remain unchanged.

**Tech Stack:** Cloudflare Workers, TypeScript, MCP Server 2.0, agents MCP handler, Zod 4, Node test runner, Wrangler.

**Spec:** Existing `worker/index.ts` contracts plus the read-reliability work merged in commit `057743a1e354cf01598fc6afbe8a10483075e61e`.

## Global Constraints

- Keep `/mcp`, `/health`, `/health/supabase`, and `/health/integrations` compatible.
- Keep existing write operations non-retrying and in Drive-then-GitHub order.
- Keep stale-write protection based on Google Docs revision ID.
- Batch reads must keep successful episode results when another episode fails.
- Do not cache canonical manuscript bodies across requests.
- Share one in-flight Google token exchange across concurrent document reads.

---

### Task 1: Partial batch helper

**Files:** `worker/batch-read.ts`, `test/batch-read.test.mjs`

- [x] Add a generic Promise.allSettled-based batch helper that deduplicates keys and preserves order.
- [x] Test all-success and one-failure partial-success cases.

### Task 2: Single-flight OAuth helper

**Files:** `worker/single-flight.ts`, `test/single-flight.test.mjs`

- [x] Share one in-flight operation per key.
- [x] Clear failed operations so later calls can retry.

### Task 3: V2 integration layer

**Files:** `worker/integrations-v2.ts`

- [x] Preserve existing Supabase, Google Docs, and GitHub integration behavior.
- [x] Add `readDriveManuscriptBatch`.
- [x] Use single-flight Google token minting for concurrent Drive reads.
- [x] Add integration latency probes without exposing secrets or contents.

### Task 4: V2 MCP server

**Files:** `worker/server-v2.ts`, `worker/entry.ts`

- [x] Preserve existing tools and endpoints.
- [x] Add `get_manuscripts`, `prepare_batch`, and `integration_health` MCP tools.
- [x] Return per-episode failures without discarding successful reads.
- [x] Switch the entrypoint to v2 while keeping the old implementation untouched.

### Task 5: Verification

**Files:** `package.json`

- [x] Run batch and single-flight tests locally.
- [x] Add all read reliability tests to `npm run check`.
- [ ] Run Wrangler dry-run build in an environment with project dependencies installed.
- [ ] Verify the deployed `/health` reports version `0.5.0` and exercise `prepare_batch` through the authenticated MCP connection.
