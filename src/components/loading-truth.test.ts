import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P1: TWO SURFACES THAT LIED WHILE THEY WAITED.

describe("a failed transcript poll keeps the conversation on screen", () => {
  const sheet = read("src/components/activity/TranscriptSheet.tsx");

  it("THE REGRESSION: neither failure path blanks the list any more", () => {
    // One bad tick on hotel wifi turned a live negotiation into an empty
    // sheet, and the next tick silently refilled it - so the reader could not
    // tell what had happened.
    expect(sheet).not.toMatch(/setMessages\(\[\]\);/);
    // Both paths keep last-good, and only a FIRST load may render empty.
    expect(sheet.match(/setMessages\(\(prev\) => \(prev === null \? \[\] : prev\)\)/g)?.length).toBe(2);
  });

  it("a well-formed error body counts as a failed poll, not an empty thread", () => {
    // The subtler of the two: `Array.isArray(d.messages) ? d.messages : []`
    // reconciled a valid error JSON down to nothing.
    expect(sheet).toMatch(/if \(!Array\.isArray\(d\.messages\)\) \{/);
    expect(sheet).not.toMatch(/Array\.isArray\(d\.messages\) \? d\.messages : \[\]/);
  });

  it("and it SAYS it is not live, rather than pretending", () => {
    expect(sheet).toMatch(/setStale\(true\)/);
    expect(sheet).toMatch(/setStale\(false\)/); // cleared on a good tick
    expect(sheet).toMatch(/Showing the last update/);
  });

  it("an abort is still not a failure - it is the component replacing itself", () => {
    expect(sheet).toMatch(/name\?: string \}\)\?\.name === "AbortError"\) return;/);
  });
});

describe("the photo gallery reserves space instead of showing black", () => {
  const gallery = read("src/components/PhotoGallery.tsx");

  it("every frame gets a skeleton plate until its bytes land", () => {
    expect(gallery).toMatch(/const \[loaded, setLoaded\]/);
    expect(gallery).toMatch(/\{!loaded\[i\] && \(/);
    expect(gallery).toMatch(/className="skeleton absolute inset-3 rounded-2xl"/);
  });

  it("the image fades in rather than popping", () => {
    expect(gallery).toMatch(/transition-opacity/);
    expect(gallery).toMatch(/loaded\[i\] \? "opacity-100" : "opacity-0"/);
    expect(gallery).toMatch(/onLoad=\{\(\) => setLoaded\(/);
  });

  it("the broken-photo path is untouched - it still drops the frame", () => {
    expect(gallery).toMatch(/onError=\{\(\) => setOk\(/);
  });

  it("the plate is decorative, not announced to a screen reader", () => {
    expect(gallery).toMatch(/aria-hidden/);
  });
});
