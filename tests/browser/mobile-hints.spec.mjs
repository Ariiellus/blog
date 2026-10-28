import { test, expect } from "@playwright/test";

const panels = ["northstar", "base", "gym", "shop", "refuge", "trailmap", "news", "summit"];

async function openTouchPage(browser, weather = "sunny", options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...options });
  await context.addInitScript(() => {
    const interval = window.setInterval;
    window.setInterval = (callback, delay, ...args) => interval(callback, delay === 30000 ? 3600000 : delay, ...args);
  });
  const page = await context.newPage();
  await page.goto(`/?weather=${weather}`);
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
  return { context, page };
}

for (const weather of ["sunny", "rainy", "snowy"]) {
  test(`${weather}: touch markers pulse and every landmark opens with a tap`, async ({ browser }, testInfo) => {
    const { context, page } = await openTouchPage(browser, weather);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const markers = await page.locator(".hotspot").evaluateAll(elements => elements.map(element => {
      const hint = getComputedStyle(element, "::after");
      const rect = element.getBoundingClientRect();
      return { content: hint.content, animation: hint.animationName, duration: hint.animationDuration, delay: hint.animationDelay, pointerEvents: hint.pointerEvents, width: rect.width, height: rect.height };
    }));
    expect(markers).toHaveLength(8);
    expect(new Set(markers.map(marker => marker.delay)).size).toBe(8);
    for (const marker of markers) {
      expect(marker.content).toBe('""');
      expect(marker.animation).toBe("touch-landmark-pulse");
      expect(marker.duration).toBe("4s");
      expect(marker.pointerEvents).toBe("none");
      expect(marker.width).toBeGreaterThanOrEqual(44);
      expect(marker.height).toBeGreaterThanOrEqual(44);
    }
    const pulse = await page.locator(".hotspot").first().evaluate(element => {
      const animation = element.getAnimations({ subtree: true }).find(item => item.animationName === "touch-landmark-pulse");
      animation.pause();
      animation.currentTime = 0;
      const low = Number(getComputedStyle(element, "::after").opacity);
      animation.currentTime = 2000;
      const high = Number(getComputedStyle(element, "::after").opacity);
      animation.play();
      return { low, high };
    });
    expect(pulse.high).toBeGreaterThan(pulse.low);
    await page.screenshot({ path: testInfo.outputPath(`${weather}-touch-hints.png`) });
    for (const panel of panels) {
      await page.locator(`[data-panel="${panel}"]`).tap();
      await expect(page.locator("#mountain-panel")).toBeVisible();
      expect(await page.locator(".hotspot").first().evaluate(element => getComputedStyle(element, "::after").animationPlayState)).toBe("paused");
      expect(await page.locator(".hotspot").first().evaluate(element => getComputedStyle(element, "::after").visibility)).toBe("hidden");
      await page.locator("[data-close-panel]").tap();
      await expect(page.locator("#mountain-panel")).not.toBeVisible();
      await expect(page.locator(".experience")).not.toHaveClass(/is-panel-open/);
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("small phones retain visible markers and 44px touch targets", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser, "sunny", { viewport: { width: 320, height: 568 } });
  const viewport = page.viewportSize();
  const boxes = await page.locator(".hotspot").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
  }));
  for (const box of boxes) {
    expect(box.x).toBeGreaterThan(12);
    expect(box.x).toBeLessThan(viewport.width - 12);
    expect(box.y).toBeGreaterThan(12);
    expect(box.y).toBeLessThan(viewport.height - 12);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

test("reduced-motion touch visitors see steady discoverability markers", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser, "sunny", { reducedMotion: "reduce" });
  const hints = await page.locator(".hotspot").evaluateAll(elements => elements.map(element => {
    const hint = getComputedStyle(element, "::after");
    return { animation: hint.animationName, opacity: Number(hint.opacity), visibility: hint.visibility };
  }));
  for (const hint of hints) {
    expect(hint.animation).toBe("none");
    expect(hint.opacity).toBeGreaterThan(0);
    expect(hint.visibility).toBe("visible");
  }
  await context.close();
});

test("mouse desktops do not show touch markers", async ({ page }) => {
  await page.goto("/?weather=sunny");
  const contents = await page.locator(".hotspot").evaluateAll(elements => elements.map(element => getComputedStyle(element, "::after").content));
  expect(contents.every(content => content === "none")).toBe(true);
});
