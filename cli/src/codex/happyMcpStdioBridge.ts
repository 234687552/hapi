/**
 * HAPI MCP STDIO Bridge
 *
 * Minimal STDIO MCP server.
 * Title-changing tool exposure has been removed.
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function runHappyMcpStdioBridge(_argv: string[]): Promise<void> {
  try {
    // Create STDIO MCP server
    const server = new McpServer({
      name: 'HAPI MCP Bridge',
      version: '1.0.0',
    });

    // Start STDIO transport
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
  } catch (err) {
    try {
      process.stderr.write(`[hapi-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.exit(1);
    }
  }
}
