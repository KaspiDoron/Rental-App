import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthMethodList } from "./AuthMethodList";
import { buildAuthMethods, emailOnlyMethods } from "../../lib/auth/methods";

// The test harness compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the app itself uses Next's automatic runtime. Publishing
// React globally lets both this file and the components under test render here
// without changing how they build.
(globalThis as Record<string, unknown>).React = React;

// WHY THIS FILE EXISTS
//
// The reported symptom was an "OR" divider floating above nothing. It was not a
// missing `&&`: the divider was a literal in the page, gated on a state that had
// no relationship to whether any alternate method would ever appear. These tests
// render the component that replaced it and assert the only thing that matters -
// a separator appears if and only if there is something on the other side of it.

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/** The divider is the only element in the app carrying role="separator". */
const dividers = (html: string) => (html.match(/role="separator"/g) ?? []).length;

const noop = () => {};

describe("the divider exists only when something is on the other side of it", () => {
  it("renders NO divider when the server offers no alternate method", () => {
    const html = render(
      <AuthMethodList
        methods={buildAuthMethods({ sessionReady: true })}
        state="ready"
        onCredential={noop}
      />
    );
    expect(dividers(html)).toBe(0);
  });

  it("renders exactly one divider when Google is configured", () => {
    const html = render(
      <AuthMethodList
        methods={buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" })}
        state="ready"
        onCredential={noop}
      />
    );
    expect(dividers(html)).toBe(1);
    expect(html).toContain("OR");
  });

  it("renders NO divider while the method list is still being probed", () => {
    // Promising a separator before we know there is anything to separate is the
    // original bug in miniature, so the probing state shows a placeholder in the
    // shape of the button and nothing else.
    const html = render(
      <AuthMethodList methods={[]} state="probing" onCredential={noop} />
    );
    expect(dividers(html)).toBe(0);
    expect(html).toContain('role="status"');
    expect(html).toContain("skeleton");
  });

  it("renders NO divider when the probe failed - just the reason and the form", () => {
    const html = render(
      <AuthMethodList
        methods={emailOnlyMethods("We could not check the other options.")}
        state="failed"
        probeError="We could not check the other options."
        onCredential={noop}
      />
    );
    expect(dividers(html)).toBe(0);
    expect(html).toContain("We could not check the other options.");
  });

  it("renders NO divider for a provider the server says is not ready", () => {
    const html = render(
      <AuthMethodList
        methods={buildAuthMethods({ sessionReady: true, googleClientId: "" })}
        state="ready"
        onCredential={noop}
      />
    );
    expect(dividers(html)).toBe(0);
  });
});

describe("a deployment with no Google key degrades instead of breaking", () => {
  it("says why, in words, instead of leaving an empty gap", () => {
    const methods = buildAuthMethods({ sessionReady: true });
    const html = render(
      <AuthMethodList methods={methods} state="ready" onCredential={noop} />
    );
    const reason = methods.find((m) => m.id === "google")!.reason!;
    expect(html).toContain(reason);
    expect(dividers(html)).toBe(0);
  });

  it("does not throw and does not render a provider button", () => {
    const html = render(
      <AuthMethodList methods={buildAuthMethods({ sessionReady: true })} state="ready" onCredential={noop} />
    );
    expect(html).not.toContain("aria-busy");
  });
});

describe("errors always have somewhere to appear", () => {
  it("shows a handshake error when there are alternates", () => {
    const html = render(
      <AuthMethodList
        methods={buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" })}
        state="ready"
        error="Sign-in was closed before it finished."
        onCredential={noop}
      />
    );
    expect(html).toContain("Sign-in was closed before it finished.");
  });

  it("shows a handshake error even when every alternate has dropped out", () => {
    const html = render(
      <AuthMethodList
        methods={emailOnlyMethods()}
        state="failed"
        error="Google sign-in failed."
        onCredential={noop}
      />
    );
    expect(dividers(html)).toBe(0);
    expect(html).toContain("Google sign-in failed.");
  });
});

describe("the provider button is mobile-safe by construction", () => {
  const html = () =>
    render(
      <AuthMethodList
        methods={buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" })}
        state="ready"
        onCredential={noop}
      />
    );

  it("never asserts a fixed pixel width that could overflow a 320px viewport", () => {
    // The GSI iframe width is measured from the container at render time; the
    // markup must therefore contain no hard-coded width on the container.
    expect(html()).not.toMatch(/width:\s*320/);
    expect(html()).toContain("min-w-0");
  });

  it("reserves a 44px tap target and clips the provider iframe", () => {
    expect(html()).toContain("min-h-[44px]");
    expect(html()).toContain("overflow-hidden");
  });

  it("announces itself as busy while the provider button has not painted", () => {
    expect(html()).toContain('aria-busy="true"');
  });
});
