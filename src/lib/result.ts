import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = CallToolResult;

/**
 * Above this many characters, indentation stops being worth its weight -- a
 * week of rrddata is mostly whitespace when pretty-printed.
 */
const PRETTY_PRINT_LIMIT = 2000;

export function ok(data: unknown): ToolResult {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    const pretty = JSON.stringify(data, null, 2);
    text = pretty.length > PRETTY_PRINT_LIMIT ? JSON.stringify(data) : pretty;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Runs a tool body, turning thrown errors into MCP error results. */
export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
