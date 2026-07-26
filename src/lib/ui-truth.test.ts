import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// SOURCE-LEVEL PINS for the eleven things reported on 26 Jul.
//
// Each of these is a property of the UI that no unit can observe: a stale focus
// effect, a fixed element's containing block, a chip that filters on data
// nobody has, an invalid Tailwind size that renders an invisible icon. They are
// all one careless edit away from coming back, so they are pinned where they
// live - the same discipline as hardening-invariants.test.ts.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("1 - a shop that replied is never filed under 'awaiting reply'", () => {
  const page = readCode("src/app/page.tsx");

  it("the panel reads the shop's last inbound message, which the API always sent", () => {
    expect(page).toMatch(/d\.lastByVendor/);
    expect(page).toMatch(/lastInboundText/);
  });

  it("replied shops get their own bucket, separate from the silent ones", () => {
    expect(page).toMatch(/const replied: Vendor\[\] = \[\]/);
    expect(page).toMatch(/statusGroups\.replied/);
  });

  it("'still to respond' counts only shops that have said nothing", () => {
    // stageCounts.messaged excludes `replied` by construction (the loop is an
    // if/else chain and `replied` is tested first).
    const groups = page.slice(page.indexOf("const statusGroups"), page.indexOf("return { messaged, replied"));
    expect(groups.indexOf("replied.push(v)")).toBeLessThan(groups.indexOf("messaged.push(v)"));
  });
});

describe("3 - alerts turn off as well as on", () => {
  it("the funnel uses the same controller as Profile, not a private copy", () => {
    const chip = readCode("src/components/AlertsChip.tsx");
    expect(chip).toMatch(/usePushAlerts/);
    expect(chip).toMatch(/disable\(\)/);
    expect(chip).toMatch(/role="switch"/);
  });

  it("the page no longer carries a second push implementation", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).not.toMatch(/enablePush/);
    expect(page).not.toMatch(/urlBase64ToUint8Array/);
    expect(page).toMatch(/<AlertsChip/);
  });
});

describe("5 - the bottom nav cannot drift into the middle of the screen", () => {
  it("it is portalled to <body> on its own compositing layer", () => {
    const bar = readCode("src/components/TabBar.tsx");
    expect(bar).toMatch(/<FixedLayer/);
    const layer = readCode("src/components/FixedLayer.tsx");
    expect(layer).toMatch(/createPortal\(/);
    expect(layer).toMatch(/translateZ\(0\)/);
    expect(layer).toMatch(/visualViewport/);
  });

  it("the scroll lock no longer toggles overflow", () => {
    const lock = readCode("src/lib/scroll-lock.ts");
    expect(lock).not.toMatch(/body\.style\.overflow\s*=\s*"hidden"/);
    expect(lock).toMatch(/body\.style\.position = "fixed"/);
  });
});

describe("6 - Will's chat keeps the keyboard, and his buttons go places", () => {
  it("the modal sets up focus ONCE, not on every parent render", () => {
    const modal = readCode("src/components/Modal.tsx");
    expect(modal).toMatch(/closeRef/);
    // The effect's dependency array must be empty - an inline onClose from the
    // parent would otherwise re-run it (and steal focus) on every poll tick.
    expect(modal).toMatch(/\}, \[\]\);/);
    expect(modal).not.toMatch(/\}, \[onClose\]\);/);
  });

  it("no icon is sized with a class Tailwind does not generate", () => {
    // `h-4.5` is not in the default scale, so the send icon rendered at zero
    // size - a blue circle with nothing in it.
    for (const f of [
      "src/components/will/WillSheet.tsx",
      "src/components/SearchSummaryBar.tsx",
      "src/components/landing/FeatureGrid.tsx",
    ]) {
      expect(readCode(f)).not.toMatch(/[hw]-\d+\.5\b/);
    }
  });

  it("the guidance actions navigate instead of only opening the chat", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/function goToSection/);
    // Every stage past dispatch offers at least one action that moves the user.
    const guides = page.slice(page.indexOf('step === "AGENTS_DISPATCHED"'));
    expect((guides.match(/goToSection\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("7 - the third KPI is worth a glance", () => {
  it("shows the cheapest bookable rate, not a savings total that reads 0", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/t\("Best price"\)/);
    expect(page).not.toMatch(/t\("Bargained"\)/);
  });
});

describe("8 - 'see the full activity feed' goes to the feed", () => {
  it("scrolls to the section rather than the top of the page", () => {
    const page = readCode("src/app/page.tsx");
    const link = page.slice(
      page.indexOf("See the full live activity feed") - 600,
      page.indexOf("See the full live activity feed")
    );
    expect(link).toMatch(/goToSection\("\[data-tour='views'\]", "activity"\)/);
    expect(link).not.toMatch(/window\.scrollTo\(\{ top: 0/);
  });
});

describe("10 - a filter with no data behind it is not tappable", () => {
  const filters = readCode("src/components/Filters.tsx");

  it("verified chips disable at a count of zero", () => {
    expect(filters).toMatch(/tagCounts/);
    expect(filters).toMatch(/disabled=\{n === 0\}/);
  });

  it("and when they DO filter, they actually filter", () => {
    const page = readCode("src/app/page.tsx");
    // Routed through soft() the predicate was OR'd with "is this shop live?",
    // so the tap could never remove anything.
    expect(page).toMatch(/list = list\.filter\(\(v\) => \(v\.verifiedTags \?\? \[\]\)\.includes\(f\.tag\)\)/);
  });
});

describe("11 - the custom composer says what it does", () => {
  const card = readCode("src/components/VendorCard.tsx");

  it("tells the traveller the text reaches the shop verbatim", () => {
    expect(card).toMatch(/Your words go straight to the shop/);
    expect(card).toMatch(/The shop will receive/);
  });

  it("the send button names the shop it is sending to", () => {
    expect(card).toMatch(/\$\{t\("Send to"\)\} \$\{vendor\.name\}/);
    expect(card).not.toMatch(/t\("Screen & send"\)/);
  });
});
