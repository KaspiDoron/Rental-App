import { test, expect } from "@playwright/test";
import { signIn, asPlan } from "./fixtures/session";
import { dismissTour } from "./fixtures/init";

// W6.2 - the feedback box, end to end (owner report 5, item 18):
//
//   "Make sure that the feedback section page is working as expected, that I
//    have fully visible each and every feedback and it's categorized properly
//    and that the user can see my responses. Don't allow to add curses /
//    language which is not good behavior - we want safe words feedback page."
//
// Three journeys: a refused report reads as an answer and keeps the typed text
// recoverable; an honest "we could not save it" replaces the false promise of a
// thread; and a team reply is visibly unread on the row itself.

async function openFeedback(page: import("@playwright/test").Page) {
  await page.goto("/deals");
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
}

test.describe("feedback: safe words", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("an abusive report is refused politely, and the report is not lost", async ({ page }) => {
    await asPlan(page, "free");
    await page.route(
      (url) => url.pathname === "/api/feedback" ,
      (route) => {
        if (route.request().method() !== "POST") return route.fulfill({ json: { reports: [] } });
        return route.fulfill({
          status: 400,
          json: {
            error: "We read every report - please send this one again without the swearing.",
            rejected: "language",
            stored: false,
          },
        });
      }
    );
    await openFeedback(page);
    await page
      .getByPlaceholder(/What happened/)
      .fill("this app is completely broken and I am furious");
    await page.getByRole("button", { name: "Submit feedback" }).click();
    // A refusal is an ANSWER, not a crash - and it never quotes them back.
    await expect(page.getByText("Let's keep it clean")).toBeVisible();
    await expect(page.getByText(/without the swearing/)).toBeVisible();
    // ...and there is a way back to the text they typed.
    await page.getByRole("button", { name: "Edit my report" }).click();
    await expect(page.getByPlaceholder(/What happened/)).toHaveValue(
      "this app is completely broken and I am furious"
    );
  });

  test("a report the server could not save does NOT promise a thread", async ({ page }) => {
    await asPlan(page, "free");
    await page.route(
      (url) => url.pathname === "/api/feedback",
      (route) => {
        if (route.request().method() !== "POST") return route.fulfill({ json: { reports: [] } });
        return route.fulfill({
          json: {
            accepted: true,
            id: null,
            stored: false,
            anonymous: false,
            emailed: true,
            severity: "high",
            summary: "map blank",
          },
        });
      }
    );
    await openFeedback(page);
    await page.getByPlaceholder(/What happened/).fill("the map is blank on iOS 18");
    await page.getByRole("button", { name: "Submit feedback" }).click();
    await expect(page.getByText(/could not save your copy/)).toBeVisible();
    await expect(page.getByText("You can follow it under Your reports.")).toHaveCount(0);
  });

  // THIS TEST USED TO STUB THE THING UNDER TEST.
  //
  // It fulfilled GET /api/feedback with `unread: 1` unconditionally, for every
  // request, so the badge could not go away no matter what the client did - and
  // the client was erasing it with the very click that revealed it. The modal
  // PATCHed with the body "{}", which the route reads as "no id" and therefore
  // stamps `user_seen_at` on EVERY report; the reload then returned unread 0
  // for all of them, so the badge flashed for one round trip and died.
  //
  // The stub is now a tiny STATEFUL server: `seen` starts false, PATCH sets it,
  // and GET answers from it. That is the whole difference between a test that
  // asserts a fixture and a test that asserts the app.
  test("a team reply stays unread until the reporter opens THAT report", async ({ page }) => {
    await asPlan(page, "free");
    const patches: unknown[] = [];
    let seen = false;
    await page.route(
      (url) => url.pathname === "/api/feedback",
      async (route) => {
        const req = route.request();
        if (req.method() === "PATCH") {
          patches.push(req.postDataJSON());
          seen = true;
          return route.fulfill({ json: { ok: true } });
        }
        const unread = seen ? 0 : 1;
        return route.fulfill({
          json: {
            unread,
            byCategory: { bug: 1 },
            reports: [
              {
                id: 7,
                category: "bug",
                body: "the map is blank",
                status: "in-progress",
                severity: "high",
                summary: "map blank",
                created_at: new Date().toISOString(),
                unread,
                replies: [
                  {
                    id: 1,
                    feedback_id: 7,
                    author_role: "owner",
                    body: "Fixed in the next build - thank you!",
                    created_at: new Date().toISOString(),
                  },
                ],
              },
            ],
          },
        });
      }
    );
    await openFeedback(page);
    await page.getByRole("button", { name: /Your reports/ }).click();
    // THE ASSERTION THE OLD STUB COULD NOT MAKE: opening the tab does not mark
    // anything read, so the badge is still there to be seen.
    await expect(page.getByText("new reply")).toBeVisible();
    expect(patches).toHaveLength(0);

    // The owner's answer is really readable, which is the point of the thread.
    await page.getByRole("button", { name: /map blank/ }).click();
    await expect(page.getByText("Fixed in the next build - thank you!")).toBeVisible();
    await expect(page.getByText("WheelDeal team")).toBeVisible();

    // ...and reading it is what clears it - for that report, by id.
    await expect.poll(() => patches).toEqual([{ id: 7 }]);
    await expect(page.getByText("new reply")).toHaveCount(0);
  });

  test("a reply the server could not store does not paint as sent", async ({ page }) => {
    await asPlan(page, "free");
    await page.route(
      (url) => url.pathname === "/api/feedback",
      (route) =>
        route.fulfill({
          json: {
            unread: 0,
            byCategory: { bug: 1 },
            reports: [
              {
                id: 7,
                category: "bug",
                body: "the map is blank",
                status: "open",
                severity: "high",
                summary: "map blank",
                created_at: new Date().toISOString(),
                unread: 0,
                replies: [],
              },
            ],
          },
        })
    );
    // The field repro: a deployment with no `feedback_replies` table. Every
    // reply used to answer 200, paint, and vanish - which IS the owner's
    // complaint that users cannot see his responses.
    await page.route((url) => url.pathname === "/api/feedback/reply", (route) =>
      route.fulfill({
        status: 502,
        json: { ok: false, stored: false, error: "We could not save that reply just now - it was not sent. Please try again." },
      })
    );
    await openFeedback(page);
    await page.getByRole("button", { name: /Your reports/ }).click();
    await page.getByRole("button", { name: /map blank/ }).click();
    await page.getByPlaceholder("Reply to the team...").fill("any update on this?");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText(/could not save that reply/)).toBeVisible();
    // The text stays in the box, so it can be sent again rather than retyped.
    await expect(page.getByPlaceholder("Reply to the team...")).toHaveValue("any update on this?");
  });
});
