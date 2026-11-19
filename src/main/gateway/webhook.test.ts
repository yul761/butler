import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseWebhookUrl, sendWebhook } from "./webhook";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(handler: (body: string, headers: IncomingHttpHeaders) => { status: number; delayMs?: number; location?: string }): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = handler(body, req.headers);
      setTimeout(() => {
        res.writeHead(r.status, r.location ? { Location: r.location } : {});
        res.end("secret response body");
      }, r.delayMs ?? 0);
    });
  });
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/hook`)));
}

describe("parseWebhookUrl", () => {
  it("accepts https and loopback http only, without credentials", () => {
    expect(parseWebhookUrl(" https://ntfy.example/topic ")?.host).toBe("ntfy.example");
    expect(parseWebhookUrl("http://127.0.0.1:8080/x")).not.toBeNull();
    expect(parseWebhookUrl("http://localhost/x")).not.toBeNull();
    for (const bad of ["http://ntfy.example/x", "https://u:p@ntfy.example/x", "ftp://x", "file:///etc/passwd", "nonsense", "", `https://a.example/${"x".repeat(2000)}`]) {
      expect(parseWebhookUrl(bad)).toBeNull();
    }
  });
});

describe("sendWebhook", () => {
  it("posts the body with the content type and safe extra headers, and reports the status", async () => {
    const seen: { body: string; headers: IncomingHttpHeaders }[] = [];
    const url = await listen((body, headers) => (seen.push({ body, headers }), { status: 200 }));
    expect(await sendWebhook({ url, body: "hi", contentType: "text/plain", headers: { Title: "Butler", Bad: "x\ny" } })).toEqual({ ok: true, status: 200 });
    expect(seen[0]!.body).toBe("hi");
    expect(seen[0]!.headers["content-type"]).toBe("text/plain");
    expect(seen[0]!.headers.title).toBe("Butler");
    expect(seen[0]!.headers.bad).toBeUndefined();
    expect(seen[0]!.headers.cookie).toBeUndefined();
  });

  it("fails without the response body on HTTP errors, redirects, timeouts and refused addresses", async () => {
    const url = await listen((body) => (body === "slow" ? { status: 200, delayMs: 300 } : body === "moved" ? { status: 302, location: "https://elsewhere.example/" } : { status: 500 }));
    const err = await sendWebhook({ url, body: "x", contentType: "text/plain" });
    expect(err).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(err)).not.toContain("secret response body");
    expect(await sendWebhook({ url, body: "moved", contentType: "text/plain" })).toMatchObject({ ok: false });
    expect(await sendWebhook({ url, body: "slow", contentType: "text/plain", timeoutMs: 50 })).toMatchObject({ ok: false, status: null });
    expect(await sendWebhook({ url: "http://ntfy.example/x", body: "x", contentType: "text/plain" })).toMatchObject({ ok: false, status: null });
  });
});
