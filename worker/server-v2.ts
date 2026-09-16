import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod/v4";
import {
  ACTIVE_RULE_KEYS,
  SUPABASE_SCHEMA,
  backupGithub,
  cleanInvisibleFormatting,
  integrationHealth,
  loadActiveRules,
  parseGoogleServiceAccount,
  readDriveManuscript,
  readDriveManuscriptBatch,
  requireGithubToken,
  saveDriveManuscript,
  type DriveManuscript,
  type WorkerEnv,
} from "./integrations-v2";

const VERSION = "0.5.0";
const episodeSchema = z.number().int().min(1).max(3);
const episodeListSchema = z.array(episodeSchema).min(1).max(3);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown integration error";
}

function toolJson(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function toolError(error: unknown) {
  return toolJson({ error: errorMessage(error) }, true);
}

function prepareManuscript(manuscript: DriveManuscript) {
  const cleanup = cleanInvisibleFormatting(manuscript.text);
  return {
    ...manuscript,
    text: cleanup.text,
    prepareCleanupChanged: cleanup.changed,
    invisibleRemoved: cleanup.invisibleRemoved,
    lineSeparatorsNormalized: cleanup.lineSeparatorsNormalized,
  };
}

function batchPayload(batch: Awaited<ReturnType<typeof readDriveManuscriptBatch>>) {
  return {
    requestedEpisodes: batch.requested,
    succeeded: batch.succeeded,
    failed: batch.failed,
    partial: batch.succeeded > 0 && batch.failed > 0,
    results: batch.items.map((item) =>
      item.ok
        ? { episode: item.key, ok: true, manuscript: prepareManuscript(item.value) }
        : { episode: item.key, ok: false, error: item.error },
    ),
  };
}

function createServer(env: WorkerEnv) {
  const server = new McpServer({ name: "a-hairline-crack-mcp", version: VERSION });

  server.registerTool(
    "health",
    { description: "Check whether the A Hairline Crack MCP server is running" },
    async () => toolJson({ ok: true, service: "a-hairline-crack-mcp", version: VERSION }),
  );

  server.registerTool(
    "integration_health",
    {
      description:
        "Probe Supabase, Google Drive and GitHub reads in parallel and report per-integration latency without returning manuscript or secret contents",
    },
    async () => {
      const health = await integrationHealth(env);
      return toolJson(health, !health.ok);
    },
  );

  server.registerTool(
    "load_rules",
    {
      description:
        "Load the three ACTIVE proofreading governance documents from Supabase in one read-only request",
    },
    async () => {
      try {
        const rows = await loadActiveRules(env);
        return toolJson({
          source: "supabase",
          schema: SUPABASE_SCHEMA,
          table: "correction_meta",
          rows,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_manuscript",
    {
      description: "Read one fixed-mapped canonical Korean manuscript from Google Docs",
      inputSchema: z.object({ episode: episodeSchema }),
    },
    async ({ episode }) => {
      try {
        return toolJson(prepareManuscript(await readDriveManuscript(env, episode)));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_manuscripts",
    {
      description:
        "Read multiple fixed-mapped canonical Korean manuscripts from Google Docs concurrently; preserve successful results when another episode fails",
      inputSchema: z.object({ episodes: episodeListSchema }),
    },
    async ({ episodes }) => {
      try {
        const payload = batchPayload(await readDriveManuscriptBatch(env, episodes));
        return toolJson(payload, payload.succeeded === 0);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "prepare_cycle",
    {
      description:
        "Prepare one proofreading cycle by reading the manuscript and ACTIVE governance in parallel, once",
      inputSchema: z.object({ episode: episodeSchema }),
    },
    async ({ episode }) => {
      try {
        const [rules, manuscript] = await Promise.all([
          loadActiveRules(env),
          readDriveManuscript(env, episode),
        ]);
        return toolJson({ episode, rules, manuscript: prepareManuscript(manuscript) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "prepare_batch",
    {
      description:
        "Prepare multiple proofreading episodes in one MCP call: load ACTIVE governance once and read all requested manuscripts concurrently with partial-failure reporting",
      inputSchema: z.object({ episodes: episodeListSchema }),
    },
    async ({ episodes }) => {
      const [rulesResult, manuscriptResult] = await Promise.allSettled([
        loadActiveRules(env),
        readDriveManuscriptBatch(env, episodes),
      ]);

      const rules =
        rulesResult.status === "fulfilled"
          ? { ok: true as const, rows: rulesResult.value }
          : { ok: false as const, error: errorMessage(rulesResult.reason) };

      const uniqueEpisodes = [...new Set(episodes)];
      const manuscripts =
        manuscriptResult.status === "fulfilled"
          ? batchPayload(manuscriptResult.value)
          : {
              requestedEpisodes: uniqueEpisodes,
              succeeded: 0,
              failed: uniqueEpisodes.length,
              partial: false,
              results: uniqueEpisodes.map((episode) => ({
                episode,
                ok: false,
                error: errorMessage(manuscriptResult.reason),
              })),
            };

      return toolJson({ rules, manuscripts }, !rules.ok && manuscripts.succeeded === 0);
    },
  );

  server.registerTool(
    "save_manuscript",
    {
      description:
        "Save confirmed manuscript text to the fixed Google Docs canonical with stale-write protection",
      inputSchema: z.object({
        episode: episodeSchema,
        text: z.string(),
        expectedRevisionId: z.string().min(1),
      }),
    },
    async ({ episode, text, expectedRevisionId }) => {
      try {
        return toolJson(await saveDriveManuscript(env, episode, text, expectedRevisionId));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "backup_github",
    {
      description:
        "Back up the exact Drive-canonical manuscript text to the fixed GitHub manuscript path",
      inputSchema: z.object({ episode: episodeSchema, text: z.string() }),
    },
    async ({ episode, text }) => {
      try {
        return toolJson(await backupGithub(env, episode, text));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "finish_cycle",
    {
      description:
        "Finish a changed cycle in strict order: Drive canonical first, then GitHub backup; skip all writes when unchanged",
      inputSchema: z.object({
        episode: episodeSchema,
        text: z.string(),
        expectedRevisionId: z.string().min(1),
        changed: z.boolean(),
      }),
    },
    async ({ episode, text, expectedRevisionId, changed }) => {
      if (!changed) {
        return toolJson({
          episode,
          skipped: true,
          driveWritten: false,
          githubWritten: false,
          reason: "no manuscript change",
        });
      }

      try {
        parseGoogleServiceAccount(env);
        requireGithubToken(env);

        const drive = await saveDriveManuscript(env, episode, text, expectedRevisionId);
        try {
          const github = await backupGithub(env, episode, drive.text);
          return toolJson({
            episode,
            skipped: false,
            driveWritten: true,
            githubWritten: !github.skipped,
            drive,
            github,
          });
        } catch (backupError) {
          return toolJson(
            {
              episode,
              driveWritten: true,
              githubWritten: false,
              drive,
              error: errorMessage(backupError),
            },
            true,
          );
        }
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

function unauthorized(): Response {
  return Response.json(
    { ok: false, error: "Unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "a-hairline-crack-mcp",
        version: VERSION,
        readReliability: { timeoutMs: 12000, maxAttempts: 3 },
      });
    }

    if (url.pathname === "/health/supabase") {
      try {
        const rows = await loadActiveRules(env);
        return Response.json(
          {
            ok: true,
            source: "supabase",
            active_rule_count: rows.length,
            expected_rule_count: ACTIVE_RULE_KEYS.length,
            keys: rows.map((row) => row.meta_key),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        return Response.json(
          { ok: false, error: errorMessage(error) },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    if (url.pathname === "/health/integrations") {
      const payload = await integrationHealth(env);
      return Response.json(payload, {
        status: payload.ok ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/mcp") {
      if (!env.MCP_SHARED_SECRET) {
        return Response.json(
          { ok: false, error: "MCP_SHARED_SECRET is not configured" },
          { status: 503 },
        );
      }

      const authorization = request.headers.get("Authorization");
      if (authorization !== `Bearer ${env.MCP_SHARED_SECRET}`) return unauthorized();

      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    return Response.json({
      ok: true,
      service: "a-hairline-crack-mcp",
      version: VERSION,
      mcp: "/mcp",
      health: "/health",
      integration_health: "/health/integrations",
      auth: "bearer",
      read_tools: [
        "load_rules",
        "get_manuscript",
        "get_manuscripts",
        "prepare_cycle",
        "prepare_batch",
        "integration_health",
      ],
    });
  },
} satisfies ExportedHandler<WorkerEnv>;
