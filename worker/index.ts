import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

type WorkerEnv = {
  MCP_SHARED_SECRET?: string;
};

function createServer() {
  const server = new McpServer({
    name: "a-hairline-crack-mcp",
    version: "0.2.0"
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

  return server;
}

const mcpHandler = createMcpHandler(createServer);

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

      return mcpHandler(request, env, ctx);
    }

    return Response.json({
      ok: true,
      service: "a-hairline-crack-mcp",
      mcp: "/mcp",
      health: "/health",
      auth: "bearer"
    });
  }
} satisfies ExportedHandler<WorkerEnv>;
