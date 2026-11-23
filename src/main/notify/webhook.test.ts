import { afterEach, describe, expect, it } from "vitest";
import { startLoopbackRecorder, type LoopbackRecorder, type RecordedHeaders } from "../testing/loopback-recorder";
import { parseWebhookUrl, sendWebhook } from "./webhook";

let server: LoopbackRecorder | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function listen(handler: (body: string, headers: RecordedHeaders) => { status: number; delayMs?: number; location?: string }): Promise<string> {
  server = await startLoopbackRecorder((req) => {
    const r = handler(req.body, req.headers);
    return { status: r.status, delayMs: r.delayMs, headers: r.location ? { Location: r.location } : undefined, raw: "secret response body" };
  });
  return server.url("/hook");
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
    const seen: { body: string; headers: RecordedHeaders }[] = [];
    const url = await listen((body, headers) => (seen.push({ body, headers }), { status: 200 }));
    expect(await sendWebhook({ url, body: "hi", contentType: "text/plain", headers: { Title: "Shipherd", Bad: "x\ny" } })).toEqual({ ok: true, status: 200 });
    expect(seen[0]!.body).toBe("hi");
    expect(seen[0]!.headers["content-type"]).toBe("text/plain");
    expect(seen[0]!.headers.title).toBe("Shipherd");
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
