import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededWorkspace } from "./fixtures/seeds";
import { dismissTour, hitTest } from "./fixtures/init";

// Wave 1.5's second half: "Ask Will", the status FAB and the "See Pro
// features" pill used to park on hand-rolled bottom offsets and overlap on
// 375px. Whatever of the stack is on screen must be individually TAPPABLE -
// visible is not the question, reachable is.

test.describe("bottom-right stack", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("every floating chip on screen is tappable and none overlap", async ({ page }) => {
    await seedLiveHunt(page, seededWorkspace(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    // The "Ask Will" summon chip only exists after the guide banner is
    // dismissed for the stage - do that like a person would, if it's up.
    const dismiss = page.getByRole("button", { name: "Dismiss" }).first();
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    // Scroll the status panel off-screen so the status FAB has a reason to
    // mount - the exact configuration of the owner's overlap screenshot.
    await page.locator('[data-tour="vendors"]').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);

    const candidates: { label: string; selector: string }[] = [
      { label: "Ask Will chip", selector: 'button[aria-label="Ask Will"]' },
      { label: "status FAB", selector: ".wd-status-fab" },
    ];
    const boxes: { label: string; box: { x: number; y: number; width: number; height: number } }[] =
      [];
    for (const c of candidates) {
      const loc = page.locator(c.selector).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      expect(await hitTest(page, c.selector), `${c.label} is covered by another layer`).toBe(true);
      const box = await loc.boundingBox();
      if (box) boxes.push({ label: c.label, box });
    }
    // At least one member of the stack must actually be on screen, or this
    // spec is testing nothing.
    expect(boxes.length, "no floating stack member rendered at all").toBeGreaterThan(0);
    // Pairwise: no two stacked chips may overlap (the 375px screenshot bug).
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `${boxes[i].label} overlaps ${boxes[j].label}`).toBe(false);
      }
    }
  });
});
