import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { layouts, hotspotStyles } from "../scripts/scenes/layouts.mjs";
import { scenarios, minimumSimilarity, minimumRegionSimilarity } from "../scripts/scenes/catalog.mjs";
import { comparePixels } from "../scripts/compare-scene.mjs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const themes = Object.keys(scenarios).filter(name => scenarios[name].converted);
const landmarks = ["base", "trailmap", "news", "gym", "summit", "refuge", "shop", "northstar", "terrain"];
for (const theme of themes) {
  for (const orientation of ["horizontal", "vertical"]) {
    test(`${theme}/${orientation} retains verified detail in editable vector paths`, async () => {
      const svg = await readFile(new URL(`../assets/weather/${theme}-${orientation}.svg`, import.meta.url), "utf8");
      assert.ok(svg.length < 40_000_000, `Vector scene unexpectedly large: ${svg.length}`);
      assert.doesNotMatch(svg, /<image|data:image|\.png|<script|<foreignObject/);
      for (const name of landmarks) assert.match(svg, new RegExp(`id="layer-${name}"`));
      const report = JSON.parse(await readFile(new URL(`../docs/fidelity/${theme}-${orientation}.json`, import.meta.url), "utf8"));
      assert.equal(createHash("sha256").update(svg).digest("hex"), report.svgSha256);
      const packed = await readFile(new URL(`../assets/weather/${theme}-${orientation}.scene.json.gz`, import.meta.url));
      const compiled = JSON.parse(gunzipSync(packed));
      assert.equal(compiled.sourceSha256, report.svgSha256);
      assert.equal(compiled.layers.reduce((count, layer) => count + layer.paths.length + (layer.clip ? 1 : 0), 0), report.paths);
      assert.deepEqual(compiled.layers.map(layer => layer.name).sort(), landmarks.map(name => `layer-${name}`).sort());
      assert.ok(report.metrics.ssim >= minimumSimilarity);
      for (const metrics of Object.values(report.regionMetrics)) assert.ok(metrics.ssim >= minimumRegionSimilarity);
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(new Set(ids).size, ids.length, "SVG identifiers must be unique");
      for (const ref of [...svg.matchAll(/(?:href="#|url\(#)([^"\)]+)/g)]) assert.ok(ids.includes(ref[1]), `Unresolved SVG reference: ${ref[1]}`);
      for (const [name, region] of Object.entries(layouts[theme][orientation].landmarks)) {
        for (const value of [region.x, region.y, region.hitWidth, region.hitHeight]) assert.ok(value > 0 && value < 100, `Invalid ${name} hit region`);
      }
    });
  }
}

test("generated hotspot styles match the geometry source", async () => {
  assert.equal(await readFile(new URL("../css/scene-hotspots.css", import.meta.url), "utf8"), hotspotStyles());
});

test("responsive scene selection agrees across pictures, CSS, and runtime", async () => {
  const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
  const query = main.match(/const mobileScene = window.matchMedia\("([^"]+)"\)/)?.[1];
  assert.ok(query, "Missing responsive scene query");
  const pictures = [...html.matchAll(/<source\b[^>]*media="([^"]+)"/g)];
  assert.equal(pictures.length, 3);
  for (const picture of pictures) assert.equal(picture[1], query);
  assert.ok(styles.includes(`@media ${query} {`));
  assert.ok(hotspotStyles().includes(`@media ${query} {`));
});

test("the fidelity metric distinguishes matching and changed pixels", () => {
  const image = Buffer.alloc(8 * 8 * 3, 100);
  assert.equal(comparePixels(image, image, 8, 8).ssim, 1);
  assert.equal(comparePixels(image, image, 8, 8).rmse, 0);
  const changed = Buffer.alloc(image.length, 200);
  assert.ok(comparePixels(image, changed, 8, 8).ssim < .81);
  assert.equal(comparePixels(image, changed, 8, 8).rmse, 100);
});
