import { describe, it, expect } from "vitest";
import { routableOrigin, requestOrigin, publicRequestOrigin } from "./request-origin";

const mkReq = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("routableOrigin", () => {
  it("accepts real public hosts and normalizes to an origin", () => {
    expect(routableOrigin("https://wheeldeal-390884710631.asia-southeast1.run.app/x?y=1")).toBe(
      "https://wheeldeal-390884710631.asia-southeast1.run.app"
    );
    expect(routableOrigin("wheeldeal.app")).toBe("https://wheeldeal.app");
  });

  it("rejects bind/loopback/link-local/internal hosts", () => {
    for (const bad of [
      "https://0.0.0.0:8080",
      "http://localhost:3000",
      "https://127.0.0.1",
      "https://127.5.5.5:9999",
      "https://[::1]:8080",
      "https://169.254.10.10",
      "https://metadata.google.internal",
      "https://myhost.local",
    ]) {
      expect(routableOrigin(bad)).toBeNull();
    }
  });

  it("rejects empty/garbage", () => {
    expect(routableOrigin("")).toBeNull();
    expect(routableOrigin(null)).toBeNull();
    expect(routableOrigin("ht!tp://???")).toBeNull();
  });
});

describe("requestOrigin", () => {
  it("prefers x-forwarded-host + proto (the Cloud Run shape)", () => {
    const req = mkReq("https://0.0.0.0:8080/api/admin/ping-url", {
      "x-forwarded-host": "wheeldeal-390884710631.asia-southeast1.run.app",
      "x-forwarded-proto": "https",
    });
    expect(requestOrigin(req)).toBe("https://wheeldeal-390884710631.asia-southeast1.run.app");
  });

  it("takes the FIRST forwarded value when proxies appended a chain", () => {
    const req = mkReq("https://0.0.0.0:8080/x", {
      "x-forwarded-host": "wheeldeal.app, internal-lb.internal",
      "x-forwarded-proto": "https, http",
    });
    expect(requestOrigin(req)).toBe("https://wheeldeal.app");
  });

  it("defaults forwarded proto to https when only the host is forwarded", () => {
    const req = mkReq("http://0.0.0.0:8080/x", { "x-forwarded-host": "wheeldeal.app" });
    expect(requestOrigin(req)).toBe("https://wheeldeal.app");
  });

  it("falls back to the raw request URL (local dev stays valid)", () => {
    expect(requestOrigin(mkReq("http://localhost:3000/api/x"))).toBe("http://localhost:3000");
  });
});

describe("publicRequestOrigin", () => {
  it("is null when only the bind address is known (the 0.0.0.0 bug shape)", () => {
    expect(publicRequestOrigin(mkReq("https://0.0.0.0:8080/api/x"))).toBeNull();
  });

  it("resolves the forwarded public host", () => {
    const req = mkReq("https://0.0.0.0:8080/api/x", {
      "x-forwarded-host": "wheeldeal-390884710631.asia-southeast1.run.app",
      "x-forwarded-proto": "https",
    });
    expect(publicRequestOrigin(req)).toBe(
      "https://wheeldeal-390884710631.asia-southeast1.run.app"
    );
  });
});
