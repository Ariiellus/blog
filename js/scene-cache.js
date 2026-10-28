/** Cache generated previews at their original resolution. Camera movement,
 * hover effects and crossfades then reuse a cached surface, not SVG DOM paths.
 * All six source SVGs remain independently editable; no bitmap is embedded.
 */
(function installSceneCache() {
  "use strict";
  const surfaces = new Map();

  async function preview(source) {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Scene unavailable: ${source}`));
    });
    image.src = source.replace(/\.svg$/, ".webp");
    await loaded;
    if (image.decode) await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("2D scene surface unavailable");
    context.drawImage(image, 0, 0);
    canvas.dataset.renderer = "preview";
    return canvas;
  }

  async function drawVector(source) {
    const response = await fetch(source.replace(/\.svg$/, ".scene.json.gz"));
    if (!response.ok || !response.body) throw new Error(`Vector scene unavailable: ${source}`);
    const scene = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
    if (scene.version !== 1 || !scene.layers?.length) throw new Error("Unsupported scene instructions");
    const canvas = document.createElement("canvas");
    canvas.width = scene.width;
    canvas.height = scene.height;
    // Software rasterization avoids expensive GPU tessellation of intricate
    // multi-contour paths. The finished bitmap is composited/uploaded only once.
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("2D vector surface unavailable");
    let budgetStarted = performance.now();
    for (const layer of scene.layers) {
      context.save();
      context.setTransform(1, 0, 0, 1, layer.x, layer.y);
      if (layer.clip) context.clip(new Path2D(layer.clip));
      for (const [fill, contours] of layer.paths) {
        context.fillStyle = fill;
        context.fill(new Path2D(contours));
        if (performance.now() - budgetStarted > 8) {
          await new Promise(resolve => window.setTimeout(resolve, 0));
          budgetStarted = performance.now();
        }
      }
      context.restore();
    }
    canvas.dataset.renderer = "vector";
    return canvas;
  }

  function get(source) {
    if (surfaces.has(source)) return surfaces.get(source);
    const promise = (async () => {
      try { return await preview(source); } catch (error) {
        if (!source.endsWith(".svg") || !window.Path2D || !window.DecompressionStream) throw error;
        console.warn("Scene preview unavailable; using its compiled vector.", error);
        return drawVector(source);
      }
    })().catch(error => {
      surfaces.delete(source);
      throw error;
    });
    surfaces.set(source, promise);
    return promise;
  }

  async function paint(layer, source, shouldCommit = () => true) {
    const surface = await get(source);
    if (!shouldCommit()) return false;
    let canvas = layer.querySelector(".scene-raster");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "scene-raster";
      canvas.setAttribute("aria-hidden", "true");
      layer.append(canvas);
    }
    canvas.width = surface.width;
    canvas.height = surface.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return false;
    context.drawImage(surface, 0, 0);
    layer.classList.add("is-rasterized");
    layer.dataset.sceneSource = source;
    layer.dataset.sceneRenderer = surface.dataset.renderer;
    return true;
  }
  window.MountainSceneCache = Object.freeze({ get, paint });
})();
