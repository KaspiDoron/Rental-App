import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// THE ~1s DEAD TAB HOP (owner report 3, item 11).
//
// Every TabBar tap used to be a full-document `window.location.href`
// navigation: the old page held frozen until the destination's whole JS
// bundle re-downloaded and re-parsed, behind a mount-only page fade, with the
// navigation veil destroyed at document commit. Client routing keeps the
// React tree alive, prefetch warms the other tabs, and the route-level
// loading.tsx files paint the brand heartbeat on the very first frame.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const TAB_PAGES = ["src/app/page.tsx", "src/app/deals/page.tsx", "src/app/profile/page.tsx"];

describe("tab hops are client navigations", () => {
  it("no tab target navigates with window.location.href", () => {
    for (const p of TAB_PAGES) {
      const src = readCode(p);
      // The ONLY full-document navigations left are auth (/login) - cookies
      // genuinely need a fresh document there.
      const hard = [...src.matchAll(/window\.location\.href = "([^"]+)"/g)].map((m) => m[1]);
      expect(hard.every((h) => h === "/login"), `${p} hard-navigates to ${hard}`).toBe(true);
      expect(src).toMatch(/router\.push\(/);
    }
  });

  it("the TabBar prefetches the other tabs on mount", () => {
    const bar = readCode("src/components/TabBar.tsx");
    expect(bar).toMatch(/router\.prefetch\(path\)/);
    expect(bar).toMatch(/\["\/", "\/deals", "\/profile"\]/);
    // The instant-feedback veil stays on the tap itself.
    expect(bar).toMatch(/if \(it\.id !== active\) startNav\(\);/);
  });

  it("the Trips re-open handoff survives client navigation", () => {
    // deals writes wd_search then router.pushes home; the home page reads it
    // in a MOUNT effect, which re-runs on client remounts - the pins hold the
    // two halves of that contract.
    const deals = readCode("src/app/deals/page.tsx");
    expect(deals).toMatch(/saveSearch\(sessionStorage, "wd_search", d\.payload\)/);
    expect(deals).toMatch(/startNav\(\);\s*\n\s*router\.push\("\/"\)/);
    const home = readCode("src/app/page.tsx");
    expect(home).toMatch(/sessionStorage\.getItem\("wd_search"\)/);
  });
});

describe("the first frame of a hop is the heartbeat", () => {
  it("every tab route has an instant loading fallback", () => {
    for (const p of ["src/app/loading.tsx", "src/app/deals/loading.tsx", "src/app/profile/loading.tsx"]) {
      expect(existsSync(join(process.cwd(), p)), p).toBe(true);
      expect(read(p)).toMatch(/<BrandPulseVeil \/>/);
    }
  });

  it("heavy on-demand surfaces stay out of the route's first parse", () => {
    const home = readCode("src/app/page.tsx");
    expect(home).toMatch(/const MapView = dynamic\(/);
    expect(home).toMatch(/const ThreadDashboard = dynamic\(/);
    expect(home).not.toMatch(/^import \{ ThreadDashboard \}/m);
  });
});
