// The auth METHOD REGISTRY - one typed list that is the single source of truth
// for what the login screen renders AND for what the server is willing to accept.
//
// WHY THIS EXISTS
//
// "Which ways can someone sign in?" used to be an implicit fact scattered across
// four places that had no way to agree with each other: a nullable
// `googleClientId` field bolted onto a grab-bag config endpoint, a `useRef` div,
// a 2.5s `childElementCount` DOM probe, and a hand-written "OR" divider sitting
// in the page as a literal. Nothing connected them, so the divider happily
// rendered above a method that could never appear - a floating OR with an empty
// gap under it on every deployment without a Google client ID. That is not a
// conditional-render bug to patch; it is the absence of a list. Once the list is
// the thing that renders, the divider becomes a FUNCTION of how many alternate
// methods exist and an orphan stops being expressible. Every future provider
// (Apple, magic link, passkey) inherits that for free instead of reproducing the
// same orphan by construction.
//
// DELIBERATELY NOT `server-only`. The builder and the selectors below are pure
// and are imported by the login UI as well as by the API routes - having one
// `alternateMethods` shared by both is the whole point. The SERVER SECRETS stay
// out by construction: this module never imports runtime-config or session.
// Instead `authMethods()` takes its two resolvers as dependencies, which the two
// route handlers (and only they) supply. That keeps the client bundle free of
// `server-only` modules while still leaving exactly one place where a method
// list can be built.

export type AuthMethodId = "email" | "google";
export type AuthMethodKind = "credential" | "oauth";

/**
 * The only configuration a method may publish to the browser. Keeping this a
 * closed shape - and rebuilding it field by field in `sanitizeConfig` rather
 * than spreading whatever the caller passed - is what stops a secret from ever
 * riding along to a public endpoint when someone adds a provider later.
 */
export interface AuthMethodConfig {
  /** OAuth client identifier. Public by design; it only selects an account. */
  clientId?: string;
}

export interface AuthMethod {
  id: AuthMethodId;
  kind: AuthMethodKind;
  /** Button/label copy. English source string; the UI runs it through t(). */
  label: string;
  /** Whether the server will actually accept this method right now. */
  ready: boolean;
  /** Plain-English, user-safe reason. Guaranteed non-empty when !ready. */
  reason?: string;
  config?: AuthMethodConfig;
}

export interface AuthMethodInputs {
  /** SESSION_SECRET is usable, so a signed cookie can be issued at all. */
  sessionReady: boolean;
  /** Resolved Google OAuth client ID, if any. Blank/whitespace counts as none. */
  googleClientId?: string | null;
}

export interface AuthMethodDeps {
  sessionReady: () => boolean;
  googleClientId: () => Promise<string | undefined | null>;
}

// Copy lives here, next to the rule that decides when it is shown, so the UI can
// never invent a different explanation for the same server state. The email
// wording mirrors the 503 that /api/auth/login answers with, because it IS the
// same condition seen from the other side.
export const EMAIL_NOT_READY_REASON =
  "Server is not configured securely yet (owner: set SESSION_SECRET). Try again shortly.";
export const GOOGLE_NOT_READY_REASON =
  "Google sign-in is not configured on this server yet - use email below.";
export const METHODS_UNREACHABLE_REASON =
  "We could not check the other sign-in options - email below still works.";

const EMAIL_LABEL = "Continue with email";
const GOOGLE_LABEL = "Continue with Google";

/** Trim and treat blank as absent, so an empty vault row is not a client ID. */
function cleanId(v: string | null | undefined): string | undefined {
  const s = (v ?? "").trim();
  return s ? s : undefined;
}

/**
 * Rebuild the public config from scratch. Never spread an incoming object: the
 * whole reason this endpoint is safe to serve unauthenticated is that only
 * fields named here can reach a browser.
 */
function sanitizeConfig(config: AuthMethodConfig | undefined): AuthMethodConfig | undefined {
  const clientId = cleanId(config?.clientId);
  return clientId ? { clientId } : undefined;
}

/**
 * A not-ready method with no reason is an invisible dead end - the user sees
 * nothing and learns nothing, which is precisely the failure this whole module
 * was written to kill. So the invariant is enforced here rather than trusted at
 * every construction site.
 */
function withReason(m: AuthMethod, fallback: string): AuthMethod {
  const reason = (m.reason ?? "").trim();
  if (m.ready) return reason ? m : { ...m, reason: undefined };
  return { ...m, reason: reason || fallback };
}

/**
 * Pure registry construction. Everything that decides which methods exist lives
 * in this one function, so a route, a test and the UI can never disagree about
 * what a given server state means.
 */
export function buildAuthMethods(inputs: AuthMethodInputs): AuthMethod[] {
  const clientId = cleanId(inputs.googleClientId);

  const email: AuthMethod = withReason(
    {
      id: "email",
      kind: "credential",
      label: EMAIL_LABEL,
      ready: Boolean(inputs.sessionReady),
    },
    EMAIL_NOT_READY_REASON
  );

  const google: AuthMethod = withReason(
    {
      id: "google",
      kind: "oauth",
      label: GOOGLE_LABEL,
      // Google is only ready if we can ALSO issue a session afterwards -
      // otherwise the button works and the exchange 503s, which is a worse
      // experience than never showing it.
      ready: Boolean(inputs.sessionReady && clientId),
      config: sanitizeConfig({ clientId }),
    },
    clientId ? EMAIL_NOT_READY_REASON : GOOGLE_NOT_READY_REASON
  );

  return [email, google];
}

/**
 * Server-side resolve. Dependencies are injected because this module must stay
 * importable from client components (see the header); the two API routes are the
 * only callers and both pass the same pair, so there is still exactly one
 * resolution path.
 */
export async function authMethods(deps: AuthMethodDeps): Promise<AuthMethod[]> {
  let googleClientId: string | undefined | null = null;
  try {
    googleClientId = await deps.googleClientId();
  } catch {
    // A vault read that fails must degrade to "Google not configured", never to
    // a 500 on the login screen's only probe.
    googleClientId = null;
  }
  let sessionReady = false;
  try {
    sessionReady = deps.sessionReady();
  } catch {
    sessionReady = false;
  }
  return buildAuthMethods({ sessionReady, googleClientId });
}

/** The always-present method. Synthesised if a caller hands us a broken list. */
export function primaryMethod(methods: AuthMethod[]): AuthMethod {
  const email = methods.find((m) => m.id === "email");
  if (email) return email;
  return buildAuthMethods({ sessionReady: false }).find((m) => m.id === "email")!;
}

/**
 * THE DIVIDER RULE. An "OR" separator is meaningful only when there is something
 * on the far side of it, so the set of things on the far side is defined once,
 * here, and the divider is derived from its length. A method that is not `ready`
 * is not an alternate - it has no button - which is why a deployment with no
 * Google client ID returns [] and the divider becomes unreachable rather than
 * merely un-rendered.
 */
export function alternateMethods(methods: AuthMethod[]): AuthMethod[] {
  return methods.filter((m) => m.kind === "oauth" && m.ready);
}

export function methodById(methods: AuthMethod[], id: AuthMethodId): AuthMethod | undefined {
  return methods.find((m) => m.id === id);
}

/** The degraded list used whenever the registry could not be read at all. */
export function emailOnlyMethods(reason: string = METHODS_UNREACHABLE_REASON): AuthMethod[] {
  const methods = buildAuthMethods({ sessionReady: true });
  return methods.map((m) => (m.id === "google" ? { ...m, ready: false, reason, config: undefined } : m));
}

/**
 * Trust boundary for the browser: re-validate and re-sanitize whatever came off
 * the wire before the UI renders it. The response is same-origin, but the client
 * still refuses unknown method ids and drops any config field other than
 * clientId, so a future server change can never quietly widen what the login
 * page will act on. Returns null when the payload is not a usable list.
 */
export function decodeAuthMethods(raw: unknown): AuthMethod[] | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { methods?: unknown } | null)?.methods)
      ? (raw as { methods: unknown[] }).methods
      : null;
  if (!list) return null;

  const out: AuthMethod[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = r.id;
    if (id !== "email" && id !== "google") continue;
    const kind: AuthMethodKind = id === "google" ? "oauth" : "credential";
    const ready = r.ready === true;
    const label =
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim()
        : id === "google"
          ? GOOGLE_LABEL
          : EMAIL_LABEL;
    const config = sanitizeConfig(
      r.config && typeof r.config === "object"
        ? { clientId: (r.config as Record<string, unknown>).clientId as string | undefined }
        : undefined
    );
    // An oauth method with no client ID cannot render a button, so it is not
    // ready no matter what the server said - the client keeps its own guard.
    const usable = id === "google" ? ready && Boolean(config?.clientId) : ready;
    out.push(
      withReason(
        {
          id,
          kind,
          label,
          ready: usable,
          reason: typeof r.reason === "string" ? r.reason : undefined,
          config,
        },
        id === "google" ? GOOGLE_NOT_READY_REASON : EMAIL_NOT_READY_REASON
      )
    );
  }
  if (!out.some((m) => m.id === "email")) return null;
  return out;
}
