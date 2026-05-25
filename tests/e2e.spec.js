// SAGE end-to-end tests.
// Run with `engine=basic` so we don't depend on Pollinations being up —
// the deterministic parser is what gives us deterministic test outcomes.
//
// `page.clock` is used to pin "now" to a known date so chrono produces
// stable results regardless of when CI runs.

const { test, expect } = require("/usr/local/lib/node_modules/playwright/test.js");

// Saturday May 23 2026 at 10:00 local. All tests are anchored here.
const NOW = new Date("2026-05-23T10:00:00");
const APP_URL = "/app/?engine=basic";

test.describe("SAGE end-to-end", () => {
  test.beforeEach(async ({ page }) => {
    // Mock "now" before any page script runs so chrono parses deterministically.
    await page.clock.install({ time: NOW });
    await page.goto(APP_URL);
    // Clear once after the page exists; do NOT use addInitScript or page.reload()
    // in test bodies would wipe persisted state we want to verify.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator("#mode-text")).toHaveText("Basic mode", { timeout: 5000 });
  });

  async function send(page, message) {
    await page.fill('[data-testid="chat-input"]', message);
    await page.click('[data-testid="send-btn"]');
    // Wait for the typing indicator to clear by waiting for the last bot bubble
    // to have non-empty text (the typing dots get replaced with the reply).
    await page.waitForFunction(() => {
      const bubbles = document.querySelectorAll('.message--bot .bubble');
      const last = bubbles[bubbles.length - 1];
      return last && last.textContent.trim().length > 0 && !last.querySelector('.typing');
    }, { timeout: 8000 });
  }

  test("01 — page loads with chat starter and zero events", async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText(/sage/i);
    await expect(page.locator('.message--bot .bubble').first()).toContainText(/Tell me what's on your mind/i);
    await expect(page.locator('[data-testid="stat-count"]')).toContainText("0 events");
    await expect(page.locator('[data-testid="stat-hours"]')).toContainText("0.0 h");
    await expect(page.locator('[data-testid="stat-deadlines"]')).toContainText("0 high-priority");
  });

  test("02 — adding event via text input creates a real event", async ({ page }) => {
    await send(page, "study calculus tomorrow 2pm to 4pm");
    await expect(page.locator('.event')).toHaveCount(1);
    const ev = page.locator('.event').first();
    await expect(ev).toContainText("calculus");
    await expect(ev).toContainText(/2:00.*4:00/);
  });

  test("03 — event lands on the correct day cell", async ({ page }) => {
    await send(page, "dentist appointment Tuesday at 3pm");
    // NOW is Sat 2026-05-23 → next Tuesday is 2026-05-26
    const dayCell = page.locator('[data-testid="day-2026-05-26"]');
    await expect(dayCell.locator('.event')).toHaveCount(1);
    await expect(dayCell.locator('.event')).toContainText(/dentist/i);
  });

  test("04 — events persist after a page reload (localStorage)", async ({ page }) => {
    await send(page, "team meeting Monday 10am to 11am");
    await expect(page.locator('.event')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.event')).toHaveCount(1);
    await expect(page.locator('.event').first()).toContainText(/meeting/i);
  });

  test("05 — past-tense dates are ignored (no phantom events)", async ({ page }) => {
    await send(page, "yesterday I was at the library studying");
    await expect(page.locator('.event')).toHaveCount(0);
    await expect(page.locator('.message--bot .bubble').last()).toContainText(/got it|anything you want me to add/i);
  });

  test("06 — deadline phrasing → high priority & end-of-day default", async ({ page }) => {
    await send(page, "my chem essay is due Friday");
    await expect(page.locator('.event')).toHaveCount(1);
    const ev = page.locator('.event').first();
    await expect(ev).toHaveClass(/event--high/);
    // 23:00 end-of-day default → "11:00 PM"
    await expect(ev.locator('.event-time')).toContainText("11:00");
  });

  test("07 — multi-event extraction from one sentence", async ({ page }) => {
    await send(page, "dentist Tuesday at 3pm and gym Wednesday at 6am");
    await expect(page.locator('.event')).toHaveCount(2);
    await expect(page.locator('.event').filter({ hasText: /dentist/i })).toHaveCount(1);
    await expect(page.locator('.event').filter({ hasText: /gym/i })).toHaveCount(1);
  });

  test("08 — overlapping events surface a conflict toast", async ({ page }) => {
    await send(page, "math study Monday 2pm to 4pm");
    await send(page, "interview Monday 3pm to 5pm");
    // The second add should overlap the first
    await expect(page.locator('.event')).toHaveCount(2);
    // The toast appears briefly — assert it shows at least once
    await expect(page.locator('#toast.toast--show')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/overlaps/i);
  });

  test("09 — .ics export downloads a valid VCALENDAR with all events", async ({ page }) => {
    await send(page, "yoga Saturday at 9am");
    await send(page, "lunch with mom Sunday at noon");
    await page.click("#sync-btn");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('button[data-act="export-ics"]'),
    ]);
    const path = await download.path();
    const fs = require("fs");
    const ics = fs.readFileSync(path, "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:SAGE Schedule");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toMatch(/SUMMARY:.*yoga/i);
    expect(ics).toMatch(/SUMMARY:.*lunch/i);
  });

  test("10 — Clear wipes all events from calendar and localStorage", async ({ page }) => {
    await send(page, "essay due Friday");
    await send(page, "party Saturday night");
    await expect(page.locator('.event').first()).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.click("#reset-btn");
    await expect(page.locator('.event')).toHaveCount(0);
    await expect(page.locator('[data-testid="stat-count"]')).toContainText("0 events");
    // Reload and confirm storage was wiped
    await page.reload();
    await expect(page.locator('.event')).toHaveCount(0);
  });

  // ---------- new features ----------

  test("11 — quick-add via day '+' button opens form and creates event", async ({ page }) => {
    // NOW=Sat May 23 → current week is May 17–23. Use Saturday (today) for simplicity.
    await page.click('[data-testid="add-2026-05-23"]');
    await expect(page.locator('[data-testid="add-modal"]')).toBeVisible();
    await page.fill('[data-testid="qa-title"]', "Morning workout");
    await page.selectOption('[data-testid="qa-category"]', "health");
    await page.click('[data-testid="add-confirm"]');
    await expect(page.locator('[data-testid="add-modal"]')).toHaveCount(0);
    const cell = page.locator('[data-testid="day-2026-05-23"]');
    await expect(cell.locator('.event')).toHaveCount(1);
    await expect(cell.locator('.event').first()).toContainText(/morning workout/i);
    await expect(cell.locator('.event').first()).toHaveClass(/event--health/);
  });

  test("12 — edit event: rename + recategorize persists", async ({ page }) => {
    await send(page, "team standup Monday 10am to 11am");
    await page.click('.event >> nth=0');
    await expect(page.locator('[data-testid="event-modal"]')).toBeVisible();
    await page.click('[data-testid="edit-btn"]');
    await page.fill('[data-testid="ef-title"]', "Eng all-hands");
    await page.selectOption('[data-testid="ef-category"]', "work");
    await page.click('[data-testid="save-edit-btn"]');
    await expect(page.locator('[data-testid="event-modal"]')).toHaveCount(0);
    const ev = page.locator('.event').first();
    await expect(ev).toContainText(/eng all-hands/i);
    await expect(ev).toHaveClass(/event--work/);
    await page.reload();
    await expect(page.locator('.event').first()).toContainText(/eng all-hands/i);
  });

  test("13 — search filter highlights matches and dims the rest", async ({ page }) => {
    await send(page, "study calc Monday 2pm to 4pm");
    await send(page, "gym Tuesday 6am");
    await send(page, "lunch Wednesday at noon");
    await page.fill('[data-testid="search-input"]', "calc");
    // Matching event gets event--matched, non-matching get dimmed
    await expect(page.locator('.event--matched')).toHaveCount(1);
    await expect(page.locator('.event--matched').first()).toContainText(/calc/i);
    await expect(page.locator('.event--dimmed')).toHaveCount(2);
  });

  test("14 — Day view toggle renders an hour grid", async ({ page }) => {
    await send(page, "yoga Monday 8am to 9am");
    // Switch to day view via the segmented button
    await page.click("#view-day");
    await expect(page.locator(".calendar")).toHaveAttribute("data-view-mode", "day");
    // The day-view container should appear
    await expect(page.locator(".day-view")).toBeVisible();
    // And the event should appear in the hour grid for Monday
    // Navigate to Monday May 25 (next Monday from May 23)
    await page.click("#next-week"); // in day view, this is "next day" — May 24
    await page.click("#next-week"); // May 25
    await expect(page.locator(".day-view-event")).toHaveCount(1);
    await expect(page.locator(".day-view-event").first()).toContainText(/yoga/i);
  });

  test("15 — Today panel shows the next event with a countdown", async ({ page }) => {
    // Add an event later today (2pm) — NOW is 10am
    await send(page, "team sync today at 2pm");
    await expect(page.locator('[data-testid="today-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="today-next"]')).toContainText(/team sync/i);
    const cd = await page.locator('[data-testid="today-countdown"]').textContent();
    // Countdown should mention "in" + hours/minutes
    expect(cd).toMatch(/in\s+\d+h/i);
  });

  test("16 — Find-free-time command returns slot suggestions", async ({ page }) => {
    await send(page, "find me 2 hours free this week");
    const lastBot = page.locator('.message--bot .bubble').last();
    await expect(lastBot).toContainText(/found\s+\d+\s+free\s+slot/i);
  });

  test("17 — Undo restores a deleted event", async ({ page }) => {
    await send(page, "history paper Tuesday 3pm to 4pm");
    await expect(page.locator('.event')).toHaveCount(1);
    await page.click('.event >> nth=0');
    await page.click('[data-testid="delete-btn"]');
    await expect(page.locator('.event')).toHaveCount(0);
    // Undo toast should appear with an Undo button
    const toastEl = page.locator('[data-testid="toast"]');
    await expect(toastEl).toBeVisible();
    await expect(toastEl).toContainText(/removed/i);
    await toastEl.locator(".toast-action").click();
    await expect(page.locator('.event')).toHaveCount(1);
    await expect(page.locator('.event').first()).toContainText(/history paper/i);
  });

  test("18 — Help modal opens with the '?' key shortcut", async ({ page }) => {
    await page.locator("body").click();  // ensure no input is focused
    await page.keyboard.press("?");
    await expect(page.locator("#help-modal")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator("#help-modal")).toContainText(/shortcuts/i);
    await page.keyboard.press("Escape");
    await expect(page.locator("#help-modal")).toHaveAttribute("aria-hidden", "true");
  });

  test("19 — Clicking a starter chip prefills the chat input", async ({ page }) => {
    const chip = page.locator('[data-testid="starter-chips"] .chip').first();
    const prompt = await chip.getAttribute("data-prompt");
    await chip.click();
    await expect(page.locator('[data-testid="chat-input"]')).toHaveValue(prompt);
  });
});
