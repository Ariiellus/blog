import { test, expect } from "@playwright/test";

const sizes = [
  [1440, 810, "horizontal"],
  [1024, 768, "horizontal"],
  [800, 1000, "vertical"],
  [320, 900, "vertical"],
  [700, 400, "vertical"],
  [701, 400, "horizontal"],
  [1280, 360, "horizontal"],
  [1440, 810, "horizontal"],
];

for (const weather of ["sunny", "rainy", "snowy"]) {
  test(`${weather}: resizing preserves scene proportions, landmarks, and open panels`, async ({ page, context }) => {
    await context.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = (callback, delay, ...args) => interval(callback, delay === 30000 ? 3600000 : delay, ...args);
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 810 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/?weather=${weather}`);
    await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
    await page.locator('[data-panel="gym"]').click();
    await expect(page.locator("#mountain-panel")).toBeVisible();

    for (const [width, height, orientation] of sizes) {
      await page.setViewportSize({ width, height });
      // Dynamic viewport units can settle one rendering frame after DevTools
      // reports the new size, especially when no scene breakpoint changes.
      await expect.poll(() => page.locator(".experience").evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(height);
      await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", `assets/weather/${weather}-${orientation}.svg`);
      await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
      const geometry = await page.evaluate(() => {
        const world = document.querySelector("#world").getBoundingClientRect();
        const experience = document.querySelector(".experience").getBoundingClientRect();
        const panel = document.querySelector("#mountain-panel").getBoundingClientRect();
        const landmarks = [...document.querySelectorAll(".hotspot")].map(element => {
          const box = element.getBoundingClientRect();
          return { name: element.dataset.panel, x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
        return { ratio: world.width / world.height, experience: { width: experience.width, height: experience.height }, panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom }, landmarks };
      });
      expect(geometry.ratio).toBeCloseTo(orientation === "vertical" ? 941 / 1672 : 1672 / 941, 4);
      expect(geometry.experience.width).toBeCloseTo(width, 0);
      expect(geometry.experience.height).toBeCloseTo(height, 0);
      for (const landmark of geometry.landmarks) {
        expect(landmark.x, `${landmark.name} x at ${width}×${height}`).toBeGreaterThan(0);
        expect(landmark.x, `${landmark.name} x at ${width}×${height}`).toBeLessThan(width);
        expect(landmark.y, `${landmark.name} y at ${width}×${height}`).toBeGreaterThan(0);
        expect(landmark.y, `${landmark.name} y at ${width}×${height}`).toBeLessThan(height);
      }
      expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
      expect(geometry.panel.top).toBeGreaterThanOrEqual(0);
      expect(geometry.panel.right).toBeLessThanOrEqual(width);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(height);
      await expect(page.locator("#mountain-panel")).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#mountain-panel")).not.toBeVisible();
    await page.locator('[data-panel="shop"]').click();
    await expect(page.locator("#mountain-panel")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
