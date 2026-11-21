// stdio 上的 JSON-RPC：butler-sessions（sessions-entry.ts）和记忆 server（entry.ts）共用。

export interface StdioMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** stdio：每行一条 JSON-RPC 消息，回复也是一行一条。butler-sessions 和记忆 server（entry.ts）都用它。 */
export function serveStdio(server: { handle(msg: StdioMessage): Promise<object | null> }, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: StdioMessage;
      try {
        msg = JSON.parse(line) as StdioMessage;
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      void server.handle(msg).then(
        (r) => r && output.write(`${JSON.stringify(r)}\n`),
        (e: unknown) => output.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: String(e) } })}\n`),
      );
    }
  });
}
