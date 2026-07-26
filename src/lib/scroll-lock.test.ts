import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// B5: the shared, ref-counted, iOS-safe body scroll lock. The old bug was five
// components each toggling body.overflow and restoring blindly, desyncing on
// overlap and (on iOS) detaching position:fixed elements. These pins verify the
// ref-count + exact restore contract that fixes it.
//
// The repo has no jsdom; we stub the tiny DOM surface the helper touches so the
// test stays in the default (node) environment like the rest of the suite. The
// module is re-imported per test so its module-level lock counter starts fresh.

const scrollToSpy = vi.fn();

beforeEach(() => {
  vi.resetModules();
  // A real CSSStyleDeclaration returns "" (not undefined) for unset properties.
  const style: Record<string, string> = {
    overflow: "",
    position: "",
    top: "",
    width: "",
    left: "",
    right: "",
  };
  (globalThis as any).document = { body: { style } };
  (globalThis as any).window = {
    scrollY: 0,
    pageYOffset: 0,
    scrollTo: scrollToSpy,
  };
  scrollToSpy.mockClear();
});

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

async function load() {
  return (await import("./scroll-lock")).lockBodyScroll;
}

describe("lockBodyScroll (B5)", () => {
  it("pins the body with position:fixed and top:-scrollY while locked", async () => {
    (globalThis as any).window.scrollY = 240;
    const lockBodyScroll = await load();
    const unlock = lockBodyScroll();
    const style = (globalThis as any).document.body.style;
    expect(style.position).toBe("fixed");
    expect(style.top).toBe("-240px");
    unlock();
  });

  it("does NOT toggle overflow - that is the WebKit trigger this file exists for", async () => {
    // A fixed body already cannot scroll. Toggling `overflow` on a scrolled
    // page is what makes iOS re-composite fixed elements against a stale
    // offset, which is how the bottom nav ended up halfway up the screen.
    (globalThis as any).window.scrollY = 300;
    const lockBodyScroll = await load();
    const unlock = lockBodyScroll();
    expect((globalThis as any).document.body.style.overflow).toBe("");
    unlock();
  });

  it("restores the exact scroll position on unlock", async () => {
    (globalThis as any).window.scrollY = 512;
    const lockBodyScroll = await load();
    const unlock = lockBodyScroll();
    unlock();
    expect(scrollToSpy).toHaveBeenCalledWith(0, 512);
    expect((globalThis as any).document.body.style.position).toBe("");
  });

  it("ref-counts: two overlapping locks only release the body on the LAST unlock", async () => {
    const lockBodyScroll = await load();
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    expect((globalThis as any).document.body.style.position).toBe("fixed");
    b();
    expect((globalThis as any).document.body.style.position).toBe("");
  });

  it("a double release is idempotent and never underflows the counter", async () => {
    const lockBodyScroll = await load();
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a(); // second release of the same lock must be a no-op
    expect((globalThis as any).document.body.style.position).toBe("fixed");
    b();
    expect((globalThis as any).document.body.style.position).toBe("");
  });
});
