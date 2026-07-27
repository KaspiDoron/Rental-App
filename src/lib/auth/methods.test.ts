import { describe, it, expect } from "vitest";
import {
  alternateMethods,
  authMethods,
  buildAuthMethods,
  decodeAuthMethods,
  emailOnlyMethods,
  methodById,
  primaryMethod,
  type AuthMethod,
} from "./methods";

// WHY THIS FILE EXISTS
//
// The login screen showed an "OR" divider above an empty gap on every
// deployment without a Google client ID, because "which methods exist" was not a
// value anybody could inspect - it was spread across a config endpoint, a ref, a
// DOM probe and a literal divider. These tests pin the list that replaced all
// four, and especially the one rule the divider is derived from: with nothing
// configured there are NO alternates, so there is nothing for a separator to
// separate.

describe("the registry answers what can actually sign someone in", () => {
  it("offers email on a fully configured server, and Google with it", () => {
    const methods = buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" });
    expect(methods.map((m) => m.id)).toEqual(["email", "google"]);
    expect(methods.every((m) => m.ready)).toBe(true);
    expect(methodById(methods, "google")?.config?.clientId).toBe("abc.apps");
  });

  it("with NO Google key it still offers email - and Google is not ready", () => {
    const methods = buildAuthMethods({ sessionReady: true });
    expect(primaryMethod(methods).ready).toBe(true);
    expect(methodById(methods, "google")?.ready).toBe(false);
    expect(methodById(methods, "google")?.config).toBeUndefined();
  });

  it("a blank or whitespace client ID is no client ID", () => {
    for (const value of ["", "   ", null, undefined]) {
      const google = methodById(
        buildAuthMethods({ sessionReady: true, googleClientId: value }),
        "google"
      );
      expect(google?.ready).toBe(false);
    }
  });

  it("trims a client ID that arrived with stray whitespace from the vault", () => {
    const google = methodById(
      buildAuthMethods({ sessionReady: true, googleClientId: "  abc.apps \n" }),
      "google"
    );
    expect(google?.ready).toBe(true);
    expect(google?.config?.clientId).toBe("abc.apps");
  });

  it("refuses Google when no session could be issued afterwards", () => {
    // A button that works and then 503s on the exchange is worse than no button.
    const methods = buildAuthMethods({ sessionReady: false, googleClientId: "abc.apps" });
    expect(methodById(methods, "google")?.ready).toBe(false);
    expect(primaryMethod(methods).ready).toBe(false);
  });

  it("every method that is not ready carries a reason a user can read", () => {
    for (const inputs of [
      { sessionReady: true },
      { sessionReady: false },
      { sessionReady: false, googleClientId: "abc.apps" },
    ]) {
      for (const m of buildAuthMethods(inputs)) {
        if (!m.ready) expect((m.reason ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("a ready method carries no leftover reason", () => {
    for (const m of buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" })) {
      expect(m.reason).toBeUndefined();
    }
  });

  it("publishes nothing but a client ID - a secret can never ride along", () => {
    // This endpoint is served unauthenticated, so the shape is the guard.
    const methods = buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" });
    for (const m of methods) {
      if (!m.config) continue;
      expect(Object.keys(m.config)).toEqual(["clientId"]);
    }
  });
});

describe("the divider rule", () => {
  it("no configured provider means no alternates - so no divider is reachable", () => {
    expect(alternateMethods(buildAuthMethods({ sessionReady: true }))).toEqual([]);
    expect(alternateMethods(emailOnlyMethods())).toEqual([]);
    expect(alternateMethods([])).toEqual([]);
  });

  it("a configured provider produces exactly one alternate", () => {
    const alts = alternateMethods(
      buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" })
    );
    expect(alts.map((m) => m.id)).toEqual(["google"]);
  });

  it("the primary method is never an alternate - it is the form, not a button", () => {
    const methods = buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" });
    expect(alternateMethods(methods).some((m) => m.id === "email")).toBe(false);
    expect(primaryMethod(methods).id).toBe("email");
  });

  it("a provider that is present but not ready is not an alternate", () => {
    const methods: AuthMethod[] = [
      { id: "email", kind: "credential", label: "Email", ready: true },
      {
        id: "google",
        kind: "oauth",
        label: "Google",
        ready: false,
        reason: "off",
        config: { clientId: "abc.apps" },
      },
    ];
    expect(alternateMethods(methods)).toEqual([]);
  });

  it("primaryMethod always answers, even for a broken list", () => {
    expect(primaryMethod([]).id).toBe("email");
    expect(primaryMethod([]).ready).toBe(false);
    expect((primaryMethod([]).reason ?? "").length).toBeGreaterThan(0);
  });
});

describe("resolving through the server's dependencies", () => {
  const deps = (clientId: string | undefined | null, sessionReady = true) => ({
    sessionReady: () => sessionReady,
    googleClientId: async () => clientId,
  });

  it("marks Google ready only when the resolver produces an id", async () => {
    expect(methodById(await authMethods(deps("abc.apps")), "google")?.ready).toBe(true);
    expect(methodById(await authMethods(deps(undefined)), "google")?.ready).toBe(false);
    expect(methodById(await authMethods(deps("")), "google")?.ready).toBe(false);
  });

  it("a vault read that throws degrades to email-only, never to a 500", async () => {
    const methods = await authMethods({
      sessionReady: () => true,
      googleClientId: async () => {
        throw new Error("supabase unreachable");
      },
    });
    expect(primaryMethod(methods).ready).toBe(true);
    expect(alternateMethods(methods)).toEqual([]);
  });

  it("a session check that throws is treated as not-ready, not as ready", async () => {
    const methods = await authMethods({
      sessionReady: () => {
        throw new Error("boom");
      },
      googleClientId: async () => "abc.apps",
    });
    expect(primaryMethod(methods).ready).toBe(false);
  });
});

describe("the browser re-validates whatever the wire delivered", () => {
  it("accepts the shape the route sends", () => {
    const wire = { methods: buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" }) };
    const decoded = decodeAuthMethods(wire);
    expect(decoded?.map((m) => m.id)).toEqual(["email", "google"]);
    expect(alternateMethods(decoded!).length).toBe(1);
  });

  it("drops config fields nobody declared, so a leak cannot reach the UI", () => {
    const decoded = decodeAuthMethods({
      methods: [
        { id: "email", kind: "credential", label: "Email", ready: true },
        {
          id: "google",
          kind: "oauth",
          label: "Google",
          ready: true,
          config: { clientId: "abc.apps", clientSecret: "shhh" },
        },
      ],
    });
    expect(Object.keys(methodById(decoded!, "google")!.config!)).toEqual(["clientId"]);
  });

  it("ignores method ids it does not know", () => {
    const decoded = decodeAuthMethods({
      methods: [
        { id: "email", kind: "credential", label: "Email", ready: true },
        { id: "apple", kind: "oauth", label: "Apple", ready: true },
      ],
    });
    expect(decoded?.map((m) => m.id)).toEqual(["email"]);
  });

  it("refuses to believe an oauth method that ships no client ID", () => {
    const decoded = decodeAuthMethods({
      methods: [
        { id: "email", kind: "credential", label: "Email", ready: true },
        { id: "google", kind: "oauth", label: "Google", ready: true },
      ],
    });
    expect(alternateMethods(decoded!)).toEqual([]);
    expect((methodById(decoded!, "google")!.reason ?? "").length).toBeGreaterThan(0);
  });

  it("rejects payloads with no email method at all", () => {
    expect(decodeAuthMethods({ methods: [] })).toBeNull();
    expect(decodeAuthMethods({})).toBeNull();
    expect(decodeAuthMethods(null)).toBeNull();
    expect(decodeAuthMethods("nope")).toBeNull();
  });
});

describe("the degraded list", () => {
  it("keeps email usable and surfaces why the rest is missing", () => {
    const methods = emailOnlyMethods("we could not check");
    expect(primaryMethod(methods).ready).toBe(true);
    expect(methodById(methods, "google")?.ready).toBe(false);
    expect(methodById(methods, "google")?.reason).toBe("we could not check");
    expect(methodById(methods, "google")?.config).toBeUndefined();
  });
});
