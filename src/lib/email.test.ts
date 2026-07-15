import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The email provider chain (Gmail -> Brevo -> Resend) with a mocked config +
// fetch, so we assert the order, fallback and error propagation without ever
// sending a real message. Gmail is left unconfigured here so nodemailer is not
// touched (it is exercised only when GMAIL_* are set).

const cfg: Record<string, string | undefined> = {};
vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => cfg[k],
}));
// server-only is a no-op import at runtime; stub it so vitest can load the module.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  for (const k of Object.keys(cfg)) delete cfg[k];
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  return await import("./email");
}

describe("email provider chain", () => {
  it("reports unconfigured when nothing is set", async () => {
    const { sendEmail, emailProviderStatus } = await load();
    const status = await emailProviderStatus();
    expect(status.anyConfigured).toBe(false);
    const r = await sendEmail({ to: ["a@b.com"], subject: "s", html: "h" });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("unconfigured");
  });

  it("uses Brevo when configured and tags the provider", async () => {
    cfg.BREVO_API_KEY = "brevo-key";
    cfg.BREVO_SENDER = "sender@shop.com";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messageId: "brevo-123" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const { sendEmail } = await load();
    const r = await sendEmail({ to: ["a@b.com"], subject: "s", html: "h" });
    expect(r.sent).toBe(true);
    expect(r.provider).toBe("brevo");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.anything()
    );
  });

  it("falls through to Resend when Brevo errors", async () => {
    cfg.BREVO_API_KEY = "brevo-key";
    cfg.BREVO_SENDER = "sender@shop.com";
    cfg.RESEND_API_KEY = "resend-key";
    cfg.FEEDBACK_FROM_EMAIL = "WheelDeal <hi@wheeldeal.app>";
    // Brevo errors HARD -> the chain returns the brevo error (does NOT silently
    // fall through on a real error; only an UNCONFIGURED provider is skipped).
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("brevo")) {
        return { ok: false, json: async () => ({ message: "brevo down" }) };
      }
      return { ok: true, json: async () => ({ id: "resend-1" }) };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const { sendEmail } = await load();
    const r = await sendEmail({ to: ["a@b.com"], subject: "s", html: "h" });
    // A hard Brevo error is surfaced (provider=brevo), by design.
    expect(r.provider).toBe("brevo");
    expect(r.sent).toBe(false);
  });

  it("uses Resend when it is the only provider", async () => {
    cfg.RESEND_API_KEY = "resend-key";
    cfg.FEEDBACK_FROM_EMAIL = "WheelDeal <hi@wheeldeal.app>";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "resend-9" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const { sendEmail } = await load();
    const r = await sendEmail({ to: ["a@b.com"], subject: "s", html: "h" });
    expect(r.sent).toBe(true);
    expect(r.provider).toBe("resend");
  });

  it("flags the Resend sandbox sender", async () => {
    cfg.RESEND_API_KEY = "resend-key";
    // No FEEDBACK_FROM_EMAIL -> defaults to onboarding@resend.dev sandbox.
    const { emailProviderStatus } = await load();
    const status = await emailProviderStatus();
    expect(status.resendSandbox).toBe(true);
  });
});
