#!/usr/bin/env node
// A tiny stdio MCP server: tools "echo" and "wipe". Every call is appended to $FAKE_MCP_LOG, so tests can
// prove a denied call never reached the server.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_MCP_LOG;
let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "echo", description: "Say it back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
            { name: "wipe", description: "Delete everything", inputSchema: { type: "object", properties: {} } },
          ],
        },
      });
    } else if (message.method === "tools/call") {
      if (log) appendFileSync(log, `${message.params.name}\n`);
      const text = message.params.name === "echo" ? `echo: ${message.params.arguments.text}` : "wiped";
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
      // Answer, then exit at once: the answer must still arrive.
      if (process.env.FAKE_MCP_EXIT_AFTER_CALL === "1") process.stdout.write("", () => process.exit(0));
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
    }
  }
});
