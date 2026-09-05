import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

type WorkerEnv = {
  MCP_SHARED_SECRET?: string;
  SUPABASE_SECRET_KEY?: string;
};

type RuleRow = {
  meta_key: string;
  meta_value: unknown;
  updated_at: string;
};

const SUPABASE_URL = "https://agmwevkhgkggkgmfyeyj.supabase.co";
const SUPABASE_SCHEMA = "growth_boundary_proofing_data";
const ACTIVE_RULE_KEYS = [
  "governance_instruction_active_v3",
  "governance_execution_prompt_active_v3",
  "governance_workflow_active_v3"
] as const;

async function loadActiveRules(env: WorkerEnv): Promise<RuleRow[]> {
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is not configured");
  }

  const endpoint = new URL(`${SUPABASE_URL}/rest/v1/correction_meta`);
  endpoint.searchParams.set("select", "meta_key,meta_value,updated_at");
  endpoint.searchParams.set("meta_key", `in.(${ACTIVE_RULE_KEYS.join(",")})`);
  endpoint.searchParams.set("order", "meta_key.asc");

  const response = await fetch(endpoint, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      "Accept-Profile": SUPABASE_SCHEMA,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase read failed (${response.status}): ${detail}`);
  }

  const rows = (await response.json()) as RuleRow[];
  if (rows.length !== ACTIVE_RULE_KEYS.length) {
    throw new Error(`Expected ${ACTIVE_RULE_KEYS.length} ACTIVE rule rows, received ${rows.length}`);
  }

  return rows;
}

function createServer(env: WorkerEnv) {
  const server = new McpServer({
    name: "a-hairline-crack-mcp",
    version: "0.3.1"
  });

  server.registerTool(
    "health",
    {
      description: "Check whether the A Hairline Crack MCP server is running"
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "ok"
        }
      ]
    })
  );

  server.registerTool(
    "load_rules",
    {
      description: "Load the three ACTIVE proofreading governance documents from Supabase in one read-only request"
    },
    async () => {
      try {
        const rows = await loadActiveRules(env);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                source: "supabase",
                schema: SUPABASE_SCHEMA,
                table: "correction_meta",
                rows
              })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown Supabase error"
            }
          ]
        };
      }
    }
  );

  return server;
}

function unauthorized(): Response {
  return Response.json(
    { ok: false, error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" }
    }
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "a-hairline-crack-mcp" });
    }

    // Temporary diagnostic. Returns metadata only, never rule contents or secrets.
    if (url.pathname === "/health/supabase") {
      try {
        const rows = await loadActiveRules(env);
        return Response.json(
          {
            ok: true,
            source: "supabase",
            active_rule_count: rows.length,
            keys: rows.map((row) => row.meta_key)
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : "Unknown Supabase error"
          },
          {
            status: 503,
            headers: { "Cache-Control": "no-store" }
          }
        );
      }
    }

    if (url.pathname === "/mcp") {
      if (!env.MCP_SHARED_SECRET) {
        return Response.json(
          { ok: false, error: "MCP_SHARED_SECRET is not configured" },
          { status: 503 }
        );
      }

      const authorization = request.headers.get("Authorization");
      if (authorization !== `Bearer ${env.MCP_SHARED_SECRET}`) {
        return unauthorized();
      }

      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    return Response.json({
      ok: true,
      service: "a-hairline-crack-mcp",
      mcp: "/mcp",
      health: "/health",
      supabase_health: "/health/supabase",
      auth: "bearer"
    });
  }
} satisfies ExportedHandler<WorkerEnv>;
