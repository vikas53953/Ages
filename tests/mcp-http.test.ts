import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpHttpConnection, mcpServers, mcpUrlProblem, startMcp, closeMcp, describeServer } from "../src/mcp.ts";
import { settingsPath } from "../src/rules.ts";

type Seen = { method?: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

/** A small streamable-HTTP MCP server: JSON for initialize and tools/call, an event stream for tools/list. */
async function fakeServer(options: { redirect?: boolean } = {}) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (options.redirect) {
        res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
        return res.end();
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ method: req.method === "DELETE" ? "DELETE" : String(body.method), headers: req.headers, body });
      if (req.method === "DELETE" || body.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
      }
      if (body.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ping\n\n");
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", description: "find a host", inputSchema: { type: "object" } }] } })}\n\n`);
        return res.end();
      }
      if (body.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        const args = (body.params as { arguments?: { host?: string } }).arguments ?? {};
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `host ${args.host} is up` }] } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const saved = { ...process.env };
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-mcp-http-home-"));
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("MCP over HTTP", () => {
  it("only https, or plain http on this PC; no password in the URL", () => {
    expect(mcpUrlProblem("https://api.githubcopilot.com/mcp/")).toBeUndefined();
    expect(mcpUrlProblem("http://127.0.0.1:3000/mcp")).toBeUndefined();
    expect(mcpUrlProblem("http://localhost:3000/mcp")).toBeUndefined();
    expect(mcpUrlProblem("http://example.com/mcp")).toContain("https");
    expect(mcpUrlProblem("https://user:pw@example.com/mcp")).toContain("password");
    expect(mcpUrlProblem("file:///etc/passwd")).toContain("https");
  });

  it("initialize, tools from an event stream, a call; session id sent back; DELETE on close", async () => {
    const fake = await fakeServer();
    closers.push(fake.close);
    process.env.FAKE_TOKEN = "t0ken";
    const connection = new McpHttpConnection("net", { url: fake.url, headers: { authorization: "Bearer ${FAKE_TOKEN}" } }, true);
    await connection.start();
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__net__lookup"]);
    expect(await connection.callTool("lookup", { host: "fw1" })).toBe("host fw1 is up");
    const list = fake.seen.find((row) => row.method === "tools/list")!;
    expect(list.headers["mcp-session-id"]).toBe("sess-1");
    expect(list.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(list.headers.authorization).toBe("Bearer t0ken");
    expect(fake.seen.some((row) => row.method === "notifications/initialized")).toBe(true);
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.seen.at(-1)?.method).toBe("DELETE");
  });

  it("a redirect is refused (your token does not follow it)", async () => {
    const fake = await fakeServer({ redirect: true });
    closers.push(fake.close);
    const connection = new McpHttpConnection("net", { url: fake.url, headers: { authorization: "Bearer x" } }, true);
    await expect(connection.start()).rejects.toThrow();
    connection.close();
  });

  it("a project's server waits for /mcp trust; its headers never expand your environment", async () => {
    const fake = await fakeServer();
    closers.push(fake.close);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mcp-http-proj-"));
    await mkdir(path.join(cwd, ".aegis"));
    process.env.SECRET_FOR_TEST = "do-not-send";
    await writeFile(settingsPath(cwd), JSON.stringify({ mcp: { servers: { remote: { url: fake.url, headers: { "x-key": "${SECRET_FOR_TEST}" } } } } }));
    const [entry] = mcpServers(cwd);
    expect(entry).toMatchObject({ name: "remote", scope: "project", trusted: false });
    expect(describeServer(entry!)).toBe(`${fake.url} (sends x-key)`);
    const untrusted = await startMcp(cwd);
    expect(untrusted.status[0]!.state).toContain("not started");
    expect(fake.seen).toHaveLength(0);
    const { trustProjectServer } = await import("../src/mcp.ts");
    trustProjectServer(cwd, "remote");
    const state = await startMcp(cwd);
    expect(state.status[0]!.state).toContain("running, 1 tool(s)");
    expect(fake.seen[0]!.headers["x-key"]).toBe("${SECRET_FOR_TEST}");
    closeMcp(state);
  });
});

describe("MCP over HTTP: review fixes", () => {
  it("a header needing an unset variable, or holding a line break, fails without showing its value", () => {
    delete process.env.NOT_SET_FOR_TEST;
    expect(() => new McpHttpConnection("x", { url: "https://example.com/mcp", headers: { authorization: "Bearer ${NOT_SET_FOR_TEST}" } }, true)).toThrow(
      "header authorization needs ${NOT_SET_FOR_TEST}, which is not set",
    );
    process.env.BROKEN_TOKEN = "sup3rsecret\ntrailing";
    let message = "";
    try {
      new McpHttpConnection("x", { url: "https://example.com/mcp", headers: { authorization: "Bearer ${BROKEN_TOKEN}" } }, true);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("line break");
    expect(message).not.toContain("sup3rsecret");
  });

  it("a server request that reuses the id is not taken as the answer; a last event without a blank line counts; an empty answer is clear", async () => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { id?: number; method?: string };
        if (body.id === undefined) return res.writeHead(202).end();
        if (body.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }));
        }
        if (body.method === "tools/list") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, method: "sampling/createMessage", params: {} })}\n\n`);
          // The answer, with no blank line after it: the stream just ends.
          return res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t", inputSchema: { type: "object" } }] } })}`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const connection = new McpHttpConnection("s", { url }, true);
    await connection.start();
    expect((await connection.listTools()).map((tool) => tool.tool)).toEqual(["t"]);
    await expect(connection.callTool("t", {})).rejects.toThrow("empty answer");
    connection.close();
  });
});
