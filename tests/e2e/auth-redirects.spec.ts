import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";

// Gate behaviour: who can stand where. Also the fixture's own guard - a
// cookie signed with the wrong secret must bounce, which proves mintSession
// forges nothing the real server would not itself have signed.

test.describe("signed-out routing @signedout", () => {
  test("/ redirects to the public homepage", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/welcome");
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("gated pages redirect to /login", async ({ page }) => {
    for (const path of ["/deals", "/profile", "/admin"]) {
      await page.goto(path);
      await page.waitForURL("**/login");
    }
  });

  test("/login renders its sign-in form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("input[type='email']").first()).toBeVisible();
  });
});

test("a session cookie signed with the WRONG secret bounces (fixture guard)", async ({
  page,
  context,
}) => {
  await signIn(context, "attacker@e2e.test", { secret: "not-the-server-secret" });
  await page.goto("/deals");
  // The middleware rejects the bad signature and treats the visit as signed out.
  await page.waitForURL("**/login");
});

test("a correctly signed cookie reaches the gated funnel", async ({ page, context }) => {
  await signIn(context);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
});
