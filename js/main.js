const WEATHER_IMAGES = window.MOUNTAIN_WEATHER_SCENES;

const WEATHER_CHANGE_INTERVAL = 30 * 1000;
const WEATHER_PRELOAD_LEAD_TIME = WEATHER_CHANGE_INTERVAL / 2;
const weatherNames = Object.keys(WEATHER_IMAGES);

const experience = document.querySelector(".experience");
const world = document.querySelector("#world");
const mountainCanvas = document.querySelector("#mountain-canvas");
const sceneLayers = [...document.querySelectorAll("[data-scene-layer]")];
const weatherAnnouncement = document.querySelector("#weather-announcement");
const panel = document.querySelector("#mountain-panel");
const panelContent = document.querySelector("#panel-content");
const panelLocation = document.querySelector("#panel-location");
const panelLabel = panelLocation.closest("p");
const closeButton = document.querySelector("[data-close-panel]");
const hotspots = [...document.querySelectorAll("[data-panel]")];
const hoverTooltip = document.querySelector("#hover-tooltip");
const hoverTooltipText = document.querySelector("#hover-tooltip-text");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
const mobileScene = window.matchMedia("(max-width: 700px), (orientation: portrait)");

let visibleLayerIndex = 0;
let currentWeather = window.__MOUNTAIN_INITIAL_WEATHER || "sunny";
let weatherRequestId = 0;
let nextWeather = null;
let nextWeatherChangeAt = 0;
let weatherPreloadTimer;
let weatherPreloadIdle = null;
let closingTimer;
let focusResetTimer;
let mountainRenderer = null;
let focusedPanelName = null;

const PANEL_FOCUS_SCALE = {
  northstar: 1.62,
  base: 1.55,
  refuge: 1.52,
  trailmap: 1.58,
  shop: 1.55,
  news: 1.58,
};

const PANEL_PLACEMENTS = {
  northstar: "panel--bottom-left",
  base: "panel--top-left",
  summit: "panel--center",
  gym: "panel--center",
  trailmap: "panel--center",
  refuge: "panel--center-left",
  news: "panel--center",
  shop: "panel--center",
};
const PANEL_PLACEMENT_CLASSES = [...new Set(Object.values(PANEL_PLACEMENTS))];
const WIDE_PANEL_NAMES = new Set(["summit", "northstar", "gym"]);

function weatherAsset(weather) {
  const orientation = mobileScene.matches ? "vertical" : "horizontal";
  return WEATHER_IMAGES[weather][orientation];
}

function updateSceneBackdrop(weather) {
  const orientation = mobileScene.matches ? "vertical" : "horizontal";
  const source = new URL(WEATHER_IMAGES[weather].preview[orientation], document.baseURI);
  experience.style.setProperty("--scene-backdrop", `url("${source.href}")`);
}

/**
 * Selected landmarks use a cinematic focus transition. The whole `.world` is
 * the camera layer, so this works whether the visible scene is the WebGL canvas
 * or the fallback picture. The live hotspot supplies the focal point.
 */
function focusWorldOnPanel(name) {
  const hotspot = hotspots.find(
    (item) => item.dataset.panel === name && item.hasAttribute("data-focus-view"),
  );

  if (!hotspot) return;

  window.clearTimeout(focusResetTimer);
  focusedPanelName = name;
  const focusX = (hotspot.offsetLeft / world.clientWidth) * 100;
  const focusY = (hotspot.offsetTop / world.clientHeight) * 100;

  world.style.setProperty("--focus-x", `${focusX}%`);
  world.style.setProperty("--focus-y", `${focusY}%`);
  world.style.setProperty("--focus-scale", PANEL_FOCUS_SCALE[name] || 1.58);
  world.style.setProperty("--drift-x", "0px");
  world.style.setProperty("--drift-y", "0px");
  experience.classList.add("is-location-focused");
}

function clearWorldFocus() {
  experience.classList.remove("is-location-focused");
  focusedPanelName = null;
  window.clearTimeout(focusResetTimer);

  // Keep the same origin while zooming out, then restore the neutral origin.
  focusResetTimer = window.setTimeout(() => {
    if (experience.classList.contains("is-location-focused")) return;
    world.style.removeProperty("--focus-x");
    world.style.removeProperty("--focus-y");
    world.style.removeProperty("--focus-scale");
  }, 1400);
}

/**
 * WEATHER SWITCH
 * The incoming weather loads into the hidden <picture>. Once decoded, the two
 * layers crossfade. The browser chooses the horizontal or vertical source.
 */
async function changeWeather(weather) {
  if (!WEATHER_IMAGES[weather] || weather === currentWeather) return;

  const requestId = ++weatherRequestId;
  const nextLayerIndex = visibleLayerIndex === 0 ? 1 : 0;
  const nextLayer = sceneLayers[nextLayerIndex];
  const nextSource = nextLayer.querySelector("source");
  const nextImage = nextLayer.querySelector("img");
  const assets = WEATHER_IMAGES[weather];

  nextSource.srcset = assets.preview.vertical;
  nextImage.src = assets.preview.horizontal;

  const reveal = () => {
    // Ignore an older load if the visitor selected another weather quickly.
    if (requestId !== weatherRequestId) return;

    sceneLayers[visibleLayerIndex].classList.remove("is-visible");
    nextLayer.classList.add("is-visible");
    visibleLayerIndex = nextLayerIndex;
    currentWeather = weather;
    experience.dataset.weather = weather;
    updateSceneBackdrop(weather);
    mountainRenderer?.transitionTo(weatherAsset(weather));
    queueNextWeather();

    weatherAnnouncement.textContent = `${weather[0].toUpperCase()}${weather.slice(1)} weather is now active.`;
  };

  try {
    const painted = await window.MountainSceneCache.paint(nextLayer, weatherAsset(weather), () => requestId === weatherRequestId);
    if (painted) {
      reveal();
      if (focusedPanelName) focusWorldOnPanel(focusedPanelName);
    }
  } catch (error) {
    // Keep the complete outgoing scene if an incoming file fails to decode.
    console.warn("Weather change unavailable; retaining the current scene.", error);
  }
}

/** Choose any weather except the one currently visible. */
function getRandomWeather(exclude) {
  const choices = weatherNames.filter((weather) => weather !== exclude);
  return choices[Math.floor(Math.random() * choices.length)];
}

// The pre-render bootstrap in index.html selected and mounted this scene.
const initialWeather = window.__MOUNTAIN_INITIAL_WEATHER || currentWeather;
experience.dataset.weather = initialWeather;
updateSceneBackdrop(initialWeather);
window.MountainSceneCache.paint(sceneLayers[visibleLayerIndex], weatherAsset(initialWeather), () => currentWeather === initialWeather && weatherRequestId === 0).catch(() => {
  // The original <picture> remains a working no-canvas fallback.
});

/**
 * WEBGL LIQUID HOVER
 * Fine-pointer desktops progressively replace the picture with a GPU-rendered
 * copy. Everything else keeps the image implementation and all functionality.
 */
if (
  !reducedMotion.matches &&
  finePointer.matches &&
  mountainCanvas &&
  window.MountainRenderer
) {
  mountainRenderer = new window.MountainRenderer(mountainCanvas);
  mountainRenderer.initialize(weatherAsset(initialWeather)).then(async (enabled) => {
    if (enabled) {
      // Covers a rare breakpoint change while the first texture was decoding.
      await mountainRenderer.setSource(weatherAsset(currentWeather));
      if (focusedPanelName) focusWorldOnPanel(focusedPanelName);
    }
  });

  mountainCanvas.addEventListener("mountainsceneready", (event) => {
    if (event.detail.source === weatherAsset(currentWeather)) experience.classList.add("has-webgl");
  });

  mountainCanvas.addEventListener("mountaincontextlost", () => {
    experience.classList.remove("has-webgl");
  });
}

// After 30 seconds, and every 30 seconds thereafter, the mountain changes.
window.MountainSceneCache.get(weatherAsset(initialWeather)).finally(() => {
  nextWeatherChangeAt = performance.now() + WEATHER_CHANGE_INTERVAL;
  queueNextWeather();
  window.setInterval(() => {
    const weather = nextWeather || getRandomWeather(currentWeather);
    nextWeatherChangeAt = performance.now() + WEATHER_CHANGE_INTERVAL;
    changeWeather(weather).finally(() => {
      if (nextWeather === weather) queueNextWeather();
      else warmWeatherScenes();
    });
  }, WEATHER_CHANGE_INTERVAL);
}).catch(() => {});

/**
 * PANEL SYSTEM
 * Each landmark points to <template id="panel-[name]">. Its content is cloned
 * into one native dialog for built-in focus management and Escape-key support.
 */
function initializeRadarChart() {
  const radarChart = panelContent.querySelector("[data-radar-chart]");
  if (!radarChart) return;

  const areas = [...radarChart.querySelectorAll("[data-radar-area]")];
  const intro = panelContent.querySelector(".panel-intro");
  const introTitle = panelContent.querySelector(".panel-intro h1");
  const introLead = panelContent.querySelector(".panel-intro .panel-lead");
  const defaultTitle = introTitle.innerHTML;
  const defaultLead = introLead.textContent;
  const content = {
    work: ["Building", "at BAX", "Currently working as a Backend Developer at BAX."],
    gaming: ["Now", "playing", "Outlast 2, & streaming on YouTube."],
    reading: ["Currently", "reading", "The Eternaut, by Oesterheld and Solano López."],
    running: ["First", "marathon", "Training for 42.2 km by the end of November 2026."],
    mountain: ["Higher", "ground", "Next goal: Acatenango, 3,976 m, in March 2027."],
    french: ["Learning", "French", "Currently at B1, working on speaking and reading."],
    german: ["Learning", "German", "A2 level, struggling to communicate ideas."],
    chess: ["Playing", "chess", "Trying to reach 2000 ELO in rapid at chess.com."],
  };
  let selectedArea = null;
  let visibleArea = null;
  let hoverOutTimer = null;

  const updatePressedStates = () => {
    areas.forEach((area) => area.setAttribute("aria-pressed", String(area === selectedArea)));
  };

  const showArea = (area, duration = 300) => {
    if (visibleArea === area) return;
    visibleArea = area;

    areas.forEach((item) => {
      item.classList.toggle("is-active", item === area);
    });

    if (!area) {
      introTitle.innerHTML = defaultTitle;
      introLead.textContent = defaultLead;
    } else {
      const [heading, emphasis, lead] = content[area.dataset.radarArea];
      const emphasizedText = document.createElement("em");
      emphasizedText.textContent = emphasis;
      introTitle.replaceChildren(`${heading} `, emphasizedText);
      introLead.textContent = lead;
    }

    intro.style.setProperty("--radar-copy-duration", `${duration}ms`);
    intro.classList.remove("is-radar-copy-changing");
    void intro.offsetWidth;
    intro.classList.add("is-radar-copy-changing");
  };

  const showImmediately = (area) => {
    window.clearTimeout(hoverOutTimer);
    showArea(area, 300);
  };

  const restoreSelectedAreaAfterDelay = () => {
    window.clearTimeout(hoverOutTimer);
    hoverOutTimer = window.setTimeout(() => showArea(selectedArea, 800), 1000);
  };

  areas.forEach((area) => {
    const toggleSelection = () => {
      window.clearTimeout(hoverOutTimer);
      selectedArea = selectedArea === area ? null : area;
      updatePressedStates();
      showArea(selectedArea, 300);
    };
    area.addEventListener("pointerenter", () => showImmediately(area));
    area.addEventListener("pointerleave", restoreSelectedAreaAfterDelay);
    area.addEventListener("focus", () => showImmediately(area));
    area.addEventListener("blur", restoreSelectedAreaAfterDelay);
    area.addEventListener("click", toggleSelection);
    area.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleSelection();
    });
  });

  panelContent.onclick = (event) => {
    if (event.target.closest(".radar-area")) return;
    window.clearTimeout(hoverOutTimer);
    selectedArea = null;
    updatePressedStates();
    showArea(null, 800);
  };
}

function getPanelLaunchPoint(event, source) {
  if (event?.detail > 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    return { x: event.clientX, y: event.clientY };
  }

  if (!source) return null;
  const sourceRect = source.getBoundingClientRect();
  return {
    x: sourceRect.left + sourceRect.width / 2,
    y: sourceRect.top + sourceRect.height / 2,
  };
}

function openPanel(name, launchPoint = null) {
  const template = document.querySelector(`#panel-${name}`);
  if (!template) return;

  window.clearTimeout(closingTimer);
  panel.classList.add("is-preparing");
  panel.classList.remove("is-open", "is-closing");
  panelContent.replaceChildren(template.content.cloneNode(true));
  panelContent.onclick = null;
  initializeRadarChart();
  panelLabel.hidden = false;
  panelLocation.textContent = template.dataset.location ?? "";
  panel.classList.remove(...PANEL_PLACEMENT_CLASSES);
  panel.classList.add(PANEL_PLACEMENTS[name] || "panel--center");
  panel.classList.toggle("panel--wide", WIDE_PANEL_NAMES.has(name));
  focusWorldOnPanel(name);

  if (!panel.open) panel.showModal();
  experience.classList.add("is-panel-open");

  // Measure the panel in its final position, then offset its collapsed state so
  // its center begins exactly where the visitor clicked.
  panel.classList.add("is-open");
  const finalRect = panel.getBoundingClientRect();
  panel.classList.remove("is-open");

  if (launchPoint && !reducedMotion.matches) {
    const deltaX = launchPoint.x - (finalRect.left + finalRect.width / 2);
    const deltaY = launchPoint.y - (finalRect.top + finalRect.height / 2);
    panel.style.setProperty("--panel-launch-x", `${deltaX}px`);
    panel.style.setProperty("--panel-launch-y", `${deltaY}px`);
    panel.style.setProperty("--panel-launch-scale", "0.08");
  } else {
    panel.style.removeProperty("--panel-launch-x");
    panel.style.removeProperty("--panel-launch-y");
    panel.style.removeProperty("--panel-launch-scale");
  }

  void panel.offsetWidth;
  panel.classList.remove("is-preparing");

  // Let the browser paint the starting state before transitioning it in.
  window.requestAnimationFrame(() => panel.classList.add("is-open"));
  history.replaceState(null, "", `#${name}`);
}

function closePanel() {
  if (!panel.open || panel.classList.contains("is-closing")) return;

  panel.classList.remove("is-open");
  panel.classList.add("is-closing");
  clearWorldFocus();
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  closingTimer = window.setTimeout(() => {
    panel.classList.remove("is-closing");
    panel.close();
  }, 380);
}

function showHoverTooltip(event, hotspot) {
  if (!hoverTooltip || !hoverTooltipText || !finePointer.matches) return;

  const hotspotRect = hotspot.getBoundingClientRect();
  const pointerX = event?.clientX ?? hotspotRect.left + hotspotRect.width / 2;
  const pointerY = event?.clientY ?? hotspotRect.top + hotspotRect.height / 2;
  const gap = 16;

  hoverTooltipText.textContent = hotspot.dataset.tooltip;
  hoverTooltip.classList.add("is-visible");

  const tooltipWidth = hoverTooltip.offsetWidth;
  const tooltipHeight = hoverTooltip.offsetHeight;
  const x = Math.min(pointerX + gap, window.innerWidth - tooltipWidth - 12);
  const y = pointerY + gap + tooltipHeight > window.innerHeight
    ? pointerY - tooltipHeight - gap
    : pointerY + gap;

  hoverTooltip.style.setProperty("--tooltip-x", `${Math.max(12, x)}px`);
  hoverTooltip.style.setProperty("--tooltip-y", `${Math.max(12, y)}px`);
}

function hideHoverTooltip() {
  hoverTooltip?.classList.remove("is-visible");
}

hotspots.forEach((hotspot) => {
  const updateHover = (event) => {
    mountainRenderer?.setHoverFromElement(event, hotspot);
    showHoverTooltip(event, hotspot);
  };

  hotspot.addEventListener("pointerenter", updateHover);
  hotspot.addEventListener("pointermove", updateHover);
  hotspot.addEventListener("pointerleave", () => {
    mountainRenderer?.clearHover();
    hideHoverTooltip();
  });
  hotspot.addEventListener("focus", () => updateHover(null));
  hotspot.addEventListener("blur", () => {
    mountainRenderer?.clearHover();
    hideHoverTooltip();
  });
  hotspot.addEventListener("click", (event) => {
    mountainRenderer?.clearHover();
    hideHoverTooltip();
    openPanel(hotspot.dataset.panel, getPanelLaunchPoint(null, hotspot));
  });
});

document.querySelectorAll("[data-panel-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    mountainRenderer?.clearHover();
    hideHoverTooltip();
    openPanel(link.dataset.panelLink, getPanelLaunchPoint(event, link));
  });
});

closeButton.addEventListener("click", closePanel);
panel.addEventListener("close", () => experience.classList.remove("is-panel-open"));

// Only a click on the dimmed backdrop—not inside the card—closes the dialog.
panel.addEventListener("click", (event) => {
  if (event.target === panel) closePanel();
});

// Intercept Escape so the native dialog uses the soft exit animation.
panel.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePanel();
});

/**
 * SUBTLE PARALLAX
 * The world and hotspots move as one, so the hit regions stay on landmarks.
 */
if (!reducedMotion.matches && finePointer.matches) {
  experience.addEventListener("pointermove", (event) => {
    const x = event.clientX / window.innerWidth - 0.5;
    const y = event.clientY / window.innerHeight - 0.5;
    world.style.setProperty("--drift-x", `${x * -8}px`);
    world.style.setProperty("--drift-y", `${y * -6}px`);
  });

  experience.addEventListener("pointerleave", () => {
    world.style.setProperty("--drift-x", "0px");
    world.style.setProperty("--drift-y", "0px");
  });
}

// If the browser crosses the mobile breakpoint, swap the WebGL texture to the
// matching composition. The DOM <picture> fallback does this automatically.
mobileScene.addEventListener("change", () => {
  const requestId = ++weatherRequestId;
  const source = weatherAsset(currentWeather);
  updateSceneBackdrop(currentWeather);
  sceneLayers[visibleLayerIndex].classList.remove("is-rasterized");
  experience.classList.remove("has-webgl");
  if (focusedPanelName) focusWorldOnPanel(focusedPanelName);
  window.MountainSceneCache.paint(sceneLayers[visibleLayerIndex], source, () => requestId === weatherRequestId).then(async (painted) => {
    if (painted && requestId === weatherRequestId) await mountainRenderer?.setSource(source);
  }).catch(() => {});
  warmWeatherScenes();
});

// Direct links such as index.html#shop open their panel automatically.
const initialPanel = window.location.hash.slice(1);
if (document.querySelector(`#panel-${initialPanel}`)) {
  window.addEventListener("load", () => openPanel(initialPanel), { once: true });
}

// Prepare only the upcoming weather in the current composition after startup.
// Later transitions reuse decoded surfaces and already-uploaded GPU textures.
function warmWeatherScenes() {
  window.clearTimeout(weatherPreloadTimer);
  if (weatherPreloadIdle !== null) window.cancelIdleCallback?.(weatherPreloadIdle);
  weatherPreloadIdle = null;
  if (!nextWeather || !nextWeatherChangeAt) return;

  const weather = nextWeather;
  const source = weatherAsset(weather);
  const preload = async () => {
    weatherPreloadIdle = null;
    if (weather !== nextWeather || source !== weatherAsset(weather)) return;
    try {
      await window.MountainSceneCache.get(source);
      if (weather === nextWeather && source === weatherAsset(weather) && mountainRenderer?.ready) {
        await mountainRenderer.preload(source);
      }
    } catch (_) {
      // A missing preload must not blank or stop the current scene.
    }
  };
  const delay = Math.max(0, nextWeatherChangeAt - performance.now() - WEATHER_PRELOAD_LEAD_TIME);
  weatherPreloadTimer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      weatherPreloadIdle = window.requestIdleCallback(preload, { timeout: 1000 });
    } else {
      preload();
    }
  }, delay);
}

function queueNextWeather() {
  nextWeather = getRandomWeather(currentWeather);
  warmWeatherScenes();
}
