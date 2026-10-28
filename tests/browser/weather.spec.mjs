import { test, expect } from "@playwright/test";
import { scenarios } from "../../scripts/scenes/catalog.mjs";
import { sourceDirectory } from "../../scripts/scenes/catalog.mjs";
import { comparePixels } from "../../scripts/compare-scene.mjs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const weatherNames = Object.keys(scenarios).filter(name => scenarios[name].converted);
const panels = ["northstar", "base", "gym", "shop", "refuge", "trailmap", "news", "summit"];

// Keep visual/click tests on their selected scenario. The dedicated clock test
// below exercises the unchanged real 30-second interval separately.
test.beforeEach(async ({ context }, testInfo) => {
  if (testInfo.title.includes("30-second")) return;
  await context.addInitScript(() => {
    const interval = window.setInterval;
    window.setInterval = (callback, delay, ...args) => interval(callback, delay === 30000 ? 3600000 : delay, ...args);
  });
});

for (const weather of weatherNames) {
  for (const orientation of ["horizontal", "vertical"]) {
    test(`${weather} ${orientation}: cached preview loads and every landmark opens`, async ({ page }, testInfo) => {
      await page.setViewportSize(orientation === "vertical" ? { width: 390, height: 844 } : { width: 1440, height: 810 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.goto(`/?weather=${weather}`);
      await expect(page.locator(".experience")).toHaveAttribute("data-weather", weather);
      await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
      await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", `assets/weather/${weather}-${orientation}.svg`);
      await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
      await page.screenshot({ path: testInfo.outputPath(`${weather}-${orientation}.png`) });
      for (const panel of panels) {
        await page.locator(`[data-panel="${panel}"]`).click();
        await expect(page.locator("#mountain-panel")).toBeVisible();
        await expect(page.locator("#panel-title")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#mountain-panel")).not.toBeVisible();
      }
      expect(errors).toEqual([]);
    });

    test(`${weather} ${orientation}: browser render matches the PNG reference`, async ({ page, context }, testInfo) => {
      const viewport = orientation === "vertical" ? { width: 390, height: 844 } : { width: 1440, height: 810 };
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/?weather=${weather}`);
      await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
      const actual = await page.screenshot({ path: testInfo.outputPath("preview.png") });
      const referencePage = await context.newPage();
      await referencePage.setViewportSize(viewport);
      await referencePage.emulateMedia({ reducedMotion: "reduce" });
      await referencePage.route("**/assets/weather/*.scene.json.gz", route => route.abort());
      await referencePage.route("**/assets/weather/*.webp", route => {
        const filename = new URL(route.request().url()).pathname.split("/").pop().replace(/\.webp$/, ".png");
        return route.fulfill({ path: fileURLToPath(new URL(`../../${sourceDirectory}/${filename}`, import.meta.url)), contentType: "image/png" });
      });
      await referencePage.goto(`/?weather=${weather}`);
      await expect(referencePage.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
      const reference = await referencePage.screenshot({ path: testInfo.outputPath("original-png.png") });
      const a = await sharp(reference).removeAlpha().raw().toBuffer();
      const b = await sharp(actual).removeAlpha().raw().toBuffer();
      const metrics = comparePixels(a, b, viewport.width, viewport.height);
      console.log(`${weather}/${orientation} actual browser similarity: ${metrics.ssim.toFixed(6)}`);
      expect(metrics.ssim).toBeGreaterThanOrEqual(.975);
      expect(metrics.rmse).toBeLessThan(3);
      await referencePage.close();
    });
  }
}

for (const orientation of ["horizontal", "vertical"]) {
  test(`no JavaScript still renders the faithful ${orientation} preview`, async ({ browser }) => {
    const viewport = orientation === "vertical" ? { width: 390, height: 844 } : { width: 1440, height: 810 };
    const context = await browser.newContext({ javaScriptEnabled: false, viewport });
    const page = await context.newPage();
    await page.goto("/");
    const image = page.locator(".world noscript .scene-layer.is-visible img");
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("naturalWidth", orientation === "vertical" ? 941 : 1672);
    expect(await image.evaluate(element => new URL(element.currentSrc).pathname)).toBe(`/assets/weather/sunny-${orientation}.webp`);
    await context.close();
  });
}

test("the selected preview remains visible if the main script is unavailable", async ({ page }) => {
  await page.route("**/js/main.js*", route => route.abort());
  await page.goto("/?weather=rainy");
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
  const image = page.locator('[data-scene-layer="0"] img');
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("complete", true);
  await expect(image).toHaveJSProperty("naturalWidth", 1672);
});

test("a real 30-second tick changes weather without blanking the scene", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const interval = window.setInterval;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) window.__testWeatherDeadline = Date.now() + delay;
      return interval(callback, delay, ...args);
    };
  });
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible img")).toHaveJSProperty("complete", true);
  await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
  await page.evaluate(async () => {
    for (const assets of Object.values(window.MOUNTAIN_WEATHER_SCENES)) await window.MountainSceneCache.get(assets.horizontal);
  });
  await expect.poll(() => page.evaluate(() => window.__testWeatherDeadline)).toBeTruthy();
  const deadline = await page.evaluate(() => window.__testWeatherDeadline);
  await page.clock.pauseAt(new Date(deadline - 1));
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "sunny");
  await page.clock.runFor(1);
  await expect(page.locator(".experience")).not.toHaveAttribute("data-weather", "sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
});

test("all scenarios reuse preview surfaces and textures during hover and crossfades", async ({ page }) => {
  await page.addInitScript(() => {
    const NativePath2D = window.Path2D;
    window.__testPathCount = 0;
    window.Path2D = class extends NativePath2D {
      constructor(...args) { super(...args); window.__testPathCount++; }
    };
  });
  const referenceRequests = [];
  page.on("request", request => { if (/\.png(?:\?|$)/.test(request.url())) referenceRequests.push(request.url()); });
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
  const cached = await page.evaluate(async () => {
    for (const assets of Object.values(window.MOUNTAIN_WEATHER_SCENES)) {
      await window.MountainSceneCache.get(assets.horizontal);
      await mountainRenderer?.preload(assets.horizontal);
    }
    const source = window.MOUNTAIN_WEATHER_SCENES.sunny.horizontal;
    const sameSurface = await window.MountainSceneCache.get(source) === await window.MountainSceneCache.get(source);
    return { sameSurface, paths: window.__testPathCount, gpu: Boolean(mountainRenderer?.ready), textures: mountainRenderer?.textureCache.size };
  });
  expect(cached.sameSurface).toBe(true);
  expect(cached.paths).toBe(0);
  if (cached.gpu) expect(cached.textures).toBe(3);
  for (const weather of ["rainy", "snowy", "sunny"]) {
    await page.evaluate(name => changeWeather(name), weather);
    await expect(page.locator(".experience")).toHaveAttribute("data-weather", weather);
    await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
    if (cached.gpu) await expect.poll(() => page.evaluate(() => mountainRenderer.nextTexture === null && mountainRenderer.currentSource === weatherAsset(currentWeather))).toBe(true);
  }
  // Cancel a transition before it completes, including returning to its source.
  await page.evaluate(async () => { await changeWeather("rainy"); await changeWeather("sunny"); });
  if (cached.gpu) await expect.poll(() => page.evaluate(() => mountainRenderer.nextTexture === null && mountainRenderer.currentSource === weatherAsset("sunny"))).toBe(true);
  await page.mouse.move(760, 560);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__testPathCount)).toBe(cached.paths);
  expect(referenceRequests).toEqual([]);
});

test("desktop/mobile breakpoint swaps keep the correct composition and open panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
  await page.locator('[data-panel="refuge"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", "assets/weather/sunny-vertical.svg");
  await expect(page.locator("#mountain-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#mountain-panel")).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 810 });
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", "assets/weather/sunny-horizontal.svg");
  if (await page.evaluate(() => Boolean(mountainRenderer?.ready))) {
    await expect(page.locator(".experience")).toHaveClass(/has-webgl/);
    expect(await page.evaluate(() => mountainRenderer.currentSource)).toBe("assets/weather/sunny-horizontal.svg");
  }
});

test("losing WebGL retains the cached preview scene", async ({ page }) => {
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
  const lost = await page.evaluate(() => {
    const extension = mountainRenderer?.gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  if (lost) await expect(page.locator(".experience")).not.toHaveClass(/has-webgl/);
  await expect(page.locator(".scene-layer.is-visible .scene-raster")).toBeVisible();
  await page.locator('[data-panel="base"]').click();
  await expect(page.locator("#mountain-panel")).toBeVisible();
});

test("a real touch-device context uses cached previews without requiring WebGL", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto("/?weather=snowy");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", "assets/weather/snowy-vertical.svg");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
  await expect(page.locator(".experience")).not.toHaveClass(/has-webgl/);
  await page.locator('[data-panel="shop"]').tap();
  await expect(page.locator("#mountain-panel")).toBeVisible();
  await context.close();
});

const radarDetails = [
  ["Work", "work", "Building at BAX", "Currently working as a Backend Developer at BAX."],
  ["Gaming", "gaming", "Now playing", "Outlast 2, & streaming on YouTube."],
  ["Reading", "reading", "Currently reading", "The Eternaut, by Oesterheld and Solano López."],
  ["Chess", "chess", "Playing chess", "Trying to reach 2000 ELO in rapid at chess.com."],
  ["Running", "running", "First marathon", "Training for 42.2 km by the end of November 2026."],
  ["Mountain", "mountain", "Higher ground", "Next goal: Acatenango, 3,976 m, in March 2027."],
  ["French", "french", "Learning French", "Currently at B1, working on speaking and reading."],
  ["German", "german", "Learning German", "A2 level, struggling to communicate ideas."],
];

test("sound stays removed on load, panel clicks, and weather changes", async ({ page }) => {
  const musicRequests = [];
  const errors = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/weather-music.js")) musicRequests.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__testAudioContexts = 0;
    for (const name of ["AudioContext", "webkitAudioContext"]) {
      const NativeAudioContext = window[name];
      if (!NativeAudioContext) continue;
      window[name] = class extends NativeAudioContext {
        constructor(...args) {
          super(...args);
          window.__testAudioContexts++;
        }
      };
    }
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
  await page.locator('[data-panel="base"]').click();
  await expect(page.locator("#mountain-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#mountain-panel")).not.toBeVisible();
  await page.evaluate(() => changeWeather("rainy"));
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
  expect(musicRequests).toEqual([]);
  expect(await page.evaluate(() => window.__testAudioContexts)).toBe(0);
  expect(await page.evaluate(() => typeof window.createWeatherAudio)).toBe("undefined");
  expect(errors).toEqual([]);
});

test("trail-map descriptions work for every area with hover, keyboard, and clicks", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?weather=sunny");
  await page.locator('[data-panel="trailmap"]').click();
  const title = page.locator("#panel-title");
  const lead = page.locator("#panel-content .panel-lead");
  const defaultLead = "A compact view of what I’m pursuing, enjoying, learning, and building right now.";
  for (const [label, key, heading, description] of radarDetails) {
    const area = page.locator("[data-radar-area]").filter({ hasText: label });
    await area.locator(".radar-label-hit").hover();
    await expect(title).toHaveText(heading);
    await expect(lead).toHaveText(description);
    await expect(area).toHaveAttribute("data-radar-area", key);
    await page.mouse.move(0, 0);
    await area.focus();
    await expect(lead).toHaveText(description);
    await page.keyboard.press("Enter");
    expect(errors).toEqual([]);
    await expect(area).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expect(area).toHaveAttribute("aria-pressed", "false");
    await expect(title).toHaveText("Where to next?");
    await expect(lead).toHaveText(defaultLead);
  }
  const gaming = page.getByRole("button", { name: "Gaming, 2 out of 5", exact: true });
  await gaming.locator(".radar-label-hit").click();
  await expect(gaming).toHaveAttribute("aria-pressed", "true");
  await expect(lead).toHaveText(radarDetails[1][3]);
  await gaming.locator(".radar-label-hit").click();
  await expect(gaming).toHaveAttribute("aria-pressed", "false");
  await expect(lead).toHaveText(defaultLead);
  expect(errors).toEqual([]);
});

test("trail-map descriptions work for every area on touch devices", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?weather=sunny");
  await page.locator('[data-panel="trailmap"]').tap();
  for (const [label, key, heading, description] of radarDetails) {
    const area = page.locator("[data-radar-area]").filter({ hasText: label });
    await area.locator(".radar-label-hit").tap();
    await expect(page.locator("#panel-title")).toHaveText(heading);
    await expect(page.locator("#panel-content .panel-lead")).toHaveText(description);
    await expect(area).toHaveAttribute("data-radar-area", key);
    await expect(area).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-radar-area][aria-pressed="true"]')).toHaveCount(1);
  }
  expect(errors).toEqual([]);
  await context.close();
});

for (const weather of weatherNames) {
  for (const orientation of ["horizontal", "vertical"]) {
    test(`${weather} ${orientation}: runtime scenes use only the current WebP`, async ({ page }) => {
      const packedRequests = [];
      const previewRequests = new Set();
      page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith(".scene.json.gz")) packedRequests.push(pathname);
        if (pathname.endsWith(".webp")) previewRequests.add(pathname);
      });
      await page.addInitScript(() => {
        const NativePath2D = window.Path2D;
        window.__testPathCount = 0;
        window.Path2D = class extends NativePath2D {
          constructor(...args) { super(...args); window.__testPathCount++; }
        };
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(orientation === "vertical" ? { width: 390, height: 844 } : { width: 1440, height: 810 });
      await page.goto(`/?weather=${weather}`);
      await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
      expect(packedRequests).toEqual([]);
      expect(await page.evaluate(() => window.__testPathCount)).toBe(0);
      expect([...previewRequests]).toEqual([`/assets/weather/${weather}-${orientation}.webp`]);
      await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
    });
  }
}

async function openWeatherClock(page, idle = true) {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.addInitScript(idle => {
    Math.random = () => 0;
    window.__testSceneLoads = [];
    window.__testSceneReady = [];
    const interval = window.setInterval;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) window.__testWeatherDeadline = Date.now() + delay;
      return interval(callback, delay, ...args);
    };
    window.requestIdleCallback = idle
      ? callback => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0)
      : undefined;
    window.cancelIdleCallback = idle ? id => window.clearTimeout(id) : undefined;
    let cache;
    Object.defineProperty(window, "MountainSceneCache", {
      configurable: true,
      get: () => cache,
      set: value => {
        cache = {
          ...value,
          get(source) {
            window.__testSceneLoads.push(source);
            const promise = value.get(source);
            promise.then(() => {
              if (!window.__testSceneReady.includes(source)) window.__testSceneReady.push(source);
            }).catch(() => {});
            return promise;
          },
        };
      },
    });
  }, idle);
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
  await expect.poll(() => page.evaluate(() => window.__testWeatherDeadline)).toBeTruthy();
  const deadline = await page.evaluate(() => window.__testWeatherDeadline);
  await page.clock.pauseAt(new Date(deadline - 16000));
  return deadline;
}

for (const idle of [true, false]) {
  test(`30-second cycle defers preparation ${idle ? "with" : "without"} idle callbacks`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const deadline = await openWeatherClock(page, idle);
    expect(await page.evaluate(() => [...new Set(window.__testSceneLoads)])).toEqual(["assets/weather/sunny-horizontal.svg"]);
    await page.clock.runFor(2000);
    await expect.poll(() => page.evaluate(() => window.__testSceneReady)).toContain("assets/weather/rainy-horizontal.svg");
    expect(await page.evaluate(() => [...new Set(window.__testSceneLoads)])).toEqual([
      "assets/weather/sunny-horizontal.svg", "assets/weather/rainy-horizontal.svg",
    ]);
    await expect(page.locator(".experience")).toHaveAttribute("data-weather", "sunny");
    await page.clock.runFor(deadline - 1 - await page.evaluate(() => Date.now()));
    await expect(page.locator(".experience")).toHaveAttribute("data-weather", "sunny");
    await page.clock.runFor(1);
    await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
    await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "preview");
    expect(errors).toEqual([]);
  });
}

test("30-second preload follows the live composition after a breakpoint change", async ({ page }) => {
  await openWeatherClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-source", "assets/weather/sunny-vertical.svg");
  await page.clock.runFor(2000);
  await expect.poll(() => page.evaluate(() => window.__testSceneReady)).toContain("assets/weather/rainy-vertical.svg");
  const sources = await page.evaluate(() => window.__testSceneLoads);
  expect(sources).not.toContain("assets/weather/rainy-horizontal.svg");
  expect(sources).not.toContain("assets/weather/snowy-horizontal.svg");
  expect(sources).not.toContain("assets/weather/snowy-vertical.svg");
});

test("30-second preload replans when weather changes before the scheduled tick", async ({ page }) => {
  const deadline = await openWeatherClock(page);
  await page.evaluate(() => changeWeather("rainy"));
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
  await page.clock.runFor(deadline - 1 - await page.evaluate(() => Date.now()));
  await page.clock.runFor(1);
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "sunny");
  expect(await page.evaluate(() => window.__testSceneLoads)).not.toContain("assets/weather/snowy-horizontal.svg");
});

test("failed upcoming scenes keep the current scene and recover on a later 30-second tick", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/assets/weather/rainy-horizontal.webp", route => route.abort());
  await page.route("**/assets/weather/rainy-horizontal.scene.json.gz", route => route.abort());
  const deadline = await openWeatherClock(page);
  await page.clock.runFor(deadline - await page.evaluate(() => Date.now()));
  await page.evaluate(() => window.MountainSceneCache.get("assets/weather/rainy-horizontal.svg").catch(() => {}));
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "sunny");
  await expect(page.locator(".scene-layer.is-visible .scene-raster")).toBeVisible();
  await page.unroute("**/assets/weather/rainy-horizontal.webp");
  await page.unroute("**/assets/weather/rainy-horizontal.scene.json.gz");
  await page.clock.runFor(16000);
  await expect.poll(() => page.evaluate(() => window.__testSceneReady)).toContain("assets/weather/rainy-horizontal.svg");
  await page.clock.runFor(14000);
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
  expect(errors).toEqual([]);
});

test("a failed WebP uses the compiled vector fallback without blanking the scene", async ({ page }) => {
  const packedRequests = [];
  const errors = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith(".scene.json.gz")) packedRequests.push(new URL(request.url()).pathname);
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/assets/weather/rainy-horizontal.webp", route => route.abort());
  await page.goto("/?weather=sunny");
  await expect(page.locator(".scene-layer.is-visible")).toHaveClass(/is-rasterized/);
  await page.evaluate(() => changeWeather("rainy"));
  await expect(page.locator(".experience")).toHaveAttribute("data-weather", "rainy");
  await expect(page.locator(".scene-layer.is-visible")).toHaveAttribute("data-scene-renderer", "vector");
  await expect(page.locator(".scene-layer.is-visible .scene-raster")).toBeVisible();
  expect(packedRequests).toEqual(["/assets/weather/rainy-horizontal.scene.json.gz"]);
  expect(errors).toEqual([]);
});
