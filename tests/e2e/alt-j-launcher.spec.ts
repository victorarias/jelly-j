import { expect, test, type Page } from "@playwright/test";
import {
  action,
  countEstablishedWebConnections,
  closeAboutTipIfFocused,
  createSession,
  createWebToken,
  deleteHarnessSessions,
  deleteSession,
  ensureNormalMode,
  harnessConfig,
  parseFloatingPaneStats,
  parseTabState,
  restartWebServerClean,
  stopWebServer,
  waitForStableLayout,
} from "./zellij-web-harness";

const presses = Number.parseInt(process.env.JJ_HARNESS_PRESSES ?? "2", 10);
const maxConnectionDelta = Number.parseInt(process.env.JJ_HARNESS_MAX_CONN_DELTA ?? "20", 10);

async function authenticateIfNeeded(page: Page, token: string) {
  const acknowledge = page.getByRole("button", { name: "Acknowledge" });
  if (await acknowledge.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await acknowledge.click();
  }

  const tokenInput = page.getByPlaceholder("Enter your security token");
  if (await tokenInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await tokenInput.fill(token);
    await page.getByRole("button", { name: "Authenticate" }).click();
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  restartWebServerClean();
  deleteHarnessSessions();
});

test.afterAll(() => {
  deleteHarnessSessions();
  stopWebServer();
});

test("minimal Alt+j smoke with bounded web connection growth", async ({ page }, testInfo) => {
  const session = createSession("jj-harness-smoke");
  const token = createWebToken();
  const baselineConnections = countEstablishedWebConnections();

  const snapshots: Array<{
    step: string;
    establishedWebConnections: number;
    stats: ReturnType<typeof parseFloatingPaneStats>;
  }> = [];

  try {
    await page.goto(`${harnessConfig.webBaseUrl}/${session}`);
    await authenticateIfNeeded(page, token);

    const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    await expect(terminalInput).toBeVisible();
    await terminalInput.click();

    closeAboutTipIfFocused(session);
    ensureNormalMode(session);

    const initialLayout = await waitForStableLayout(session);
    snapshots.push({
      step: "initial",
      establishedWebConnections: countEstablishedWebConnections(),
      stats: parseFloatingPaneStats(initialLayout),
    });

    for (let i = 1; i <= presses; i += 1) {
      await page.keyboard.press(harnessConfig.altKey);
      ensureNormalMode(session);
      const layout = await waitForStableLayout(session);
      snapshots.push({
        step: `press_${i}`,
        establishedWebConnections: countEstablishedWebConnections(),
        stats: parseFloatingPaneStats(layout),
      });
    }

    await testInfo.attach("zellij-layout-snapshots.json", {
      body: Buffer.from(JSON.stringify(snapshots, null, 2), "utf8"),
      contentType: "application/json",
    });

    const firstAfterPress = snapshots.find((s) => s.step === "press_1")?.stats;
    expect(firstAfterPress, "Expected to collect a snapshot after first Alt+j press.").toBeDefined();

    expect(
      firstAfterPress!.nonPluginFloatingPanes,
      `No non-plugin floating pane after first ${harnessConfig.altKey}. Check keybind/plugin loading.`,
    ).toBeGreaterThanOrEqual(1);

    const peakConnections = Math.max(...snapshots.map((s) => s.establishedWebConnections));
    expect(
      peakConnections,
      `Established localhost web connections jumped from ${baselineConnections} to ${peakConnections}.`,
    ).toBeLessThanOrEqual(baselineConnections + maxConnectionDelta);
  } finally {
    deleteSession(session);
    deleteHarnessSessions("jj-harness-smoke");
  }
});

test("Alt+j opens on focused new tab and does not stack blank assistants", async ({ page }, testInfo) => {
  const session = createSession("jj-harness-multitab");
  const token = createWebToken();

  const snapshots: Array<{
    step: string;
    stats: ReturnType<typeof parseFloatingPaneStats>;
    tab: ReturnType<typeof parseTabState>;
  }> = [];

  try {
    await page.goto(`${harnessConfig.webBaseUrl}/${session}`);
    await authenticateIfNeeded(page, token);

    const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    await expect(terminalInput).toBeVisible();
    await terminalInput.click();

    closeAboutTipIfFocused(session);
    ensureNormalMode(session);

    await page.keyboard.press(harnessConfig.altKey);
    ensureNormalMode(session);
    snapshots.push({
      step: "tab1_press1",
      stats: parseFloatingPaneStats(await waitForStableLayout(session, 8_000)),
      tab: parseTabState(await waitForStableLayout(session, 8_000)),
    });

    action(session, "new-tab");
    ensureNormalMode(session);
    snapshots.push({
      step: "after_new_tab",
      stats: parseFloatingPaneStats(await waitForStableLayout(session, 8_000)),
      tab: parseTabState(await waitForStableLayout(session, 8_000)),
    });

    for (let i = 1; i <= 3; i += 1) {
      await page.keyboard.press(harnessConfig.altKey);
      ensureNormalMode(session);
      const layout = await waitForStableLayout(session, 8_000);
      snapshots.push({
        step: `newtab_press_${i}`,
        stats: parseFloatingPaneStats(layout),
        tab: parseTabState(layout),
      });
    }

    await testInfo.attach("multitab-snapshots.json", {
      body: Buffer.from(JSON.stringify(snapshots, null, 2), "utf8"),
      contentType: "application/json",
    });

    const firstPressOnNewTab = snapshots.find((s) => s.step === "newtab_press_1");
    expect(firstPressOnNewTab).toBeDefined();
    expect(firstPressOnNewTab!.tab.focusedTabIndex).not.toBeNull();
    expect(
      firstPressOnNewTab!.tab.jellyTabIndices,
      "Expected Alt+j to bring Jelly J into the focused new tab on first press.",
    ).toContain(firstPressOnNewTab!.tab.focusedTabIndex!);
    expect(
      firstPressOnNewTab!.stats.jellyLikeFloatingPanes,
      "Expected first Alt+j press on new tab to show Jelly J as floating (not docked).",
    ).toBeGreaterThanOrEqual(1);
    expect(
      firstPressOnNewTab!.tab.jellyDockedInFocusedTab,
      "Jelly J appeared docked in focused tab on first new-tab press; expected floating.",
    ).toBe(false);

    const maxBlank = Math.max(...snapshots.map((s) => s.stats.blankFloatingPanes));
    expect(maxBlank, "Blank floating panes stacked while toggling on new tab.").toBe(0);

    const maxJellyLike = Math.max(...snapshots.map((s) => s.stats.jellyLikeFloatingPanes));
    expect(maxJellyLike, "Multiple Jelly J panes detected across presses.").toBeLessThanOrEqual(1);
  } finally {
    deleteSession(session);
    deleteHarnessSessions("jj-harness-multitab");
  }
});

test("Alt+j opens floating in new tab even after assistant was hidden in prior tab", async ({ page }) => {
  const session = createSession("jj-harness-hidden-move");
  const token = createWebToken();

  try {
    await page.goto(`${harnessConfig.webBaseUrl}/${session}`);
    await authenticateIfNeeded(page, token);

    const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    await expect(terminalInput).toBeVisible();
    await terminalInput.click();

    closeAboutTipIfFocused(session);
    ensureNormalMode(session);

    // Tab 1: show Jelly, then hide it (suppressed state path).
    await page.keyboard.press(harnessConfig.altKey);
    ensureNormalMode(session);
    await waitForStableLayout(session, 8_000);

    await page.keyboard.press(harnessConfig.altKey);
    ensureNormalMode(session);
    await waitForStableLayout(session, 8_000);

    // Tab 2: first press should restore as floating, not docked.
    action(session, "new-tab");
    ensureNormalMode(session);
    await waitForStableLayout(session, 8_000);

    await page.keyboard.press(harnessConfig.altKey);
    ensureNormalMode(session);
    const layout = await waitForStableLayout(session, 8_000);
    const stats = parseFloatingPaneStats(layout);
    const tab = parseTabState(layout);

    expect(tab.focusedTabIndex).not.toBeNull();
    expect(tab.jellyTabIndices).toContain(tab.focusedTabIndex!);
    expect(stats.jellyLikeFloatingPanes).toBeGreaterThanOrEqual(1);
    expect(tab.jellyDockedInFocusedTab).toBe(false);
  } finally {
    deleteSession(session);
    deleteHarnessSessions("jj-harness-hidden-move");
  }
});
