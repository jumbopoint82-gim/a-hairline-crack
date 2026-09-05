import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

function createServer() {
  const server = new McpServer({
    name: "a-hairline-crack-mcp",
    version: "0.1.0"
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

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "a-hairline-crack-mcp" });
    }

    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return Response.json({
      ok: true,
      service: "a-hairline-crack-mcp",
      mcp: "/mcp",
      health: "/health"
    });
  }
} satisfies ExportedHandler;
