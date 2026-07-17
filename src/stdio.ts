import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfigPath } from "./config/store.js";
import { RootRegistry } from "./services/root-registry.js";
import { createMcpServer } from "./register.js";
import type { RuntimeContext } from "./runtime/context.js";

// stdout is reserved exclusively for the JSON-RPC message stream that the MCP
// client reads. Any stray write to stdout corrupts message framing and breaks
// the connection. Reroute the stdout-bound console methods to stderr so neither
// this codebase nor a dependency can pollute the protocol channel. Diagnostics
// remain visible on stderr, which the client ignores.
function guardStdout(): void {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
  );
}

async function loadRegistry(configPath: string): Promise<RootRegistry> {
  try {
    return await RootRegistry.fromFile(configPath);
  } catch (error) {
    if (isFileNotFound(error)) {
      console.error(
        `gpt-repo-mcp: config not found at ${configPath}; starting with no approved repos.`
      );
      return RootRegistry.fromConfig({ repos: [], limits: {} });
    }
    throw error;
  }
}

/**
 * Starts the MCP server over stdio and resolves once the connection closes
 * (client disconnects or the process receives SIGINT/SIGTERM).
 */
export async function startStdioServer(options: { configPath?: string } = {}): Promise<void> {
  guardStdout();

  const configPath =
    options.configPath ?? resolveConfigPath({ env: process.env, cwd: process.cwd() });
  const registry = await loadRegistry(configPath);
  const context: RuntimeContext = { registry };

  const server = createMcpServer(context);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`gpt-repo-mcp stdio server ready (config: ${configPath})`);

  await new Promise<void>((resolvePromise) => {
    // connect() takes ownership of the transport callbacks, so onclose is set afterwards.
    server.server.onclose = () => resolvePromise();

    // The stdio transport does not react to stdin ending on its own, so close
    // the server when the client disconnects (stdin EOF) to shut down cleanly.
    const onStdinEnd = () => {
      void server.close();
    };
    process.stdin.once("end", onStdinEnd);
    process.stdin.once("close", onStdinEnd);

    const shutdown = (signal: NodeJS.Signals) => {
      console.error(`gpt-repo-mcp stdio: received ${signal}, shutting down.`);
      void server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

