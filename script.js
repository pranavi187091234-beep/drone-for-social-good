/* =====================================================================
   Drones for Social Good: everything that moves on the website

   How this file is organised
    1. Config
    2. Simulator and readTankSensor()
    3. App panel feed polling, and the online copy
    4. Theme toggle
    5. Scroll engine
    6. Three.js scene construction
    7. Camera track for the normal site
    8. Film timeline, renderFilm(p)
    9. Film stills for reduced motion
   10. Render loop and start-up

   Important idea: the simulator (sections 1 to 3) does not need the 3D
   scene. If Three.js cannot load or WebGL fails, alerts still work.
   ===================================================================== */
"use strict";

/* =====================================================================
   1. CONFIG
   ===================================================================== */

// Empty means "same website". The receiver (receiver/server.py) serves this
// site, so /events and /api/events are on the same address as the page.
const RECEIVER_BASE = "";

// The automatic simulator fires at a random moment in this window.
const AUTO_MIN_MS = 60000;
const AUTO_MAX_MS = 120000;

const FEED_POLL_MS = 5000;

// The fixed parts of every alert message.
const EVENT_DEVICE = "Drone-Scout-01";
const EVENT_ESP_BOARD = "ESP (demo)";
const EVENT_TANK = "Tank 2";
const EVENT_NAME = "WATER_DROP_DETECTED";
const EVENT_SEVERITY = "error";

// The small script in <head> of index.html sets one of these classes.
const IS_MOTION = document.documentElement.classList.contains("motion");
const IS_REDUCED = !IS_MOTION;

/** Shortcut for finding a page element by its id. */
function byId(id) {
  return document.getElementById(id);
}

/* =====================================================================
   2. SIMULATOR AND readTankSensor()
   ===================================================================== */

const simulator = { tank2Leaking: false };

// ===== REPLACE THIS FUNCTION WHEN A REAL SENSOR IS CONNECTED =====
// In this demo the answer comes from the simulator above, not from a real tank.
// A real sensor (flow sensor, float switch, or drip sensor) would replace the
// simulator: this function would return true when that sensor detects a drop.
// When that happens, SENSOR_SOURCE below must change to "real_sensor", so that
// every alert says truthfully where it came from.
function readTankSensor() { return simulator.tank2Leaking; }
const SENSOR_SOURCE = "simulator";

/** The words for the alert source, so nobody mistakes a demo for a real detection. */
function sourceWords(source) {
  return source === "real_sensor" ? "real sensor" : "simulator (demo)";
}

function setSendStatus(text) {
  const el = byId("send-status");
  if (el) el.textContent = text;
}

/** Reads the sensor. Only if it says "drop detected" does it send an alert. */
async function checkSensorAndSend() {
  if (!readTankSensor()) return;

  // The same message format is used by the simulator and by a real sensor.
  const message = {
    device: EVENT_DEVICE,
    esp_board: EVENT_ESP_BOARD,
    tank: EVENT_TANK,
    event: EVENT_NAME,
    severity: EVENT_SEVERITY,
    source: SENSOR_SOURCE,
    timestamp: new Date().toISOString()
  };

  setSendStatus("Sending the demo alert to the receiver.");

  let answer;
  try {
    answer = await fetchWithTimeout(RECEIVER_BASE + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    });
  } catch (err) {
    if (err.name === "AbortError") {
      // The message went out but no answer came back, so it may have arrived.
      // We cannot honestly say "sent" or "not sent".
      setSendStatus("Not confirmed. The receiver did not answer in time.");
    } else {
      setSendStatus("Not sent. Could not reach the receiver. Start it and try again (see README).");
    }
    return;
  }

  // Only say "sent" when the receiver has really said yes.
  const response = answer.response;
  const reply = answer.reply;

  if (response.ok && reply && reply.ok === true) {
    const clock = new Date().toLocaleTimeString();
    setSendStatus("Sent to the app at " + clock + ". Source: " + sourceWords(SENSOR_SOURCE) + ".");
  } else if (reply && typeof reply.error === "string") {
    setSendStatus("Not sent. The receiver said: " + reply.error);
  } else {
    setSendStatus("Not sent. The receiver replied with an error (code " + response.status + ").");
  }
}

function showAlertBadge() {
  const badge = byId("alert-badge");
  if (!badge) return;
  badge.textContent = "Drop detected · " + EVENT_TANK + " · Source: " + sourceWords(SENSOR_SOURCE);
  badge.hidden = false;
}

function hideAlertBadge() {
  const badge = byId("alert-badge");
  if (badge) badge.hidden = true;
}

/** Marks Tank 2 as leaking, shows it on screen and sends the alert. */
async function simulateDrop() {
  simulator.tank2Leaking = true;
  showAlertBadge();
  requestSceneRender(); // Updates the drip and the light on the ESP board.
  if (IS_ONLINE_COPY) {
    addBrowserOnlyAlert();
    return;
  }
  await checkSensorAndSend();
  refreshFeed();
}

/** Stops the leak on this page only. It never changes anything on the receiver. */
function resetSimulator() {
  simulator.tank2Leaking = false;
  hideAlertBadge();
  requestSceneRender();
  armAutoTimer();
  if (IS_ONLINE_COPY) {
    clearBrowserOnlyAlerts();
    return;
  }
  setSendStatus("Reset done. The simulated leak has stopped on this page. Alerts already sent stay in the app.");
}

// The automatic simulator: a setTimeout that sets itself up again each time.
let autoTimerId = null;

function armAutoTimer() {
  if (autoTimerId !== null) clearTimeout(autoTimerId);
  const delay = AUTO_MIN_MS + Math.random() * (AUTO_MAX_MS - AUTO_MIN_MS);
  autoTimerId = setTimeout(function () {
    armAutoTimer();
    simulateDrop();
  }, delay);
}

function wireSimulatorButtons() {
  const dropButton = byId("simulate-drop");
  const resetButton = byId("reset-sim");
  if (dropButton) {
    dropButton.addEventListener("click", function () {
      armAutoTimer(); // A click restarts the wait for the automatic simulator.
      simulateDrop();
    });
  }
  if (resetButton) resetButton.addEventListener("click", resetSimulator);
  armAutoTimer();
}

/* =====================================================================
   3. APP PANEL FEED POLLING
   Everything from the server is written with textContent, never innerHTML,
   so a strange message can never run as code on this page.
   ===================================================================== */

let lastEventsJson = null;
let lastStatusJson = null;
let lastBannerText = null;
let feedRequestNumber = 0;

// How long to wait for the receiver. It is shorter than the 5 seconds between
// polls, so a request with no answer always fails before the next poll starts.
const FETCH_TIMEOUT_MS = 4000;

/**
 * Asks the receiver for something, and gives up if it takes too long.
 * The timer keeps running until the whole reply has been read, because a reply
 * can also stall halfway through.
 * Gives back { response, reply }, where reply is the JSON answer, or null if the
 * answer was not JSON. Giving up shows as an error with the name "AbortError".
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const settings = Object.assign({ cache: "no-store", signal: controller.signal }, options);
    const response = await fetch(url, settings);
    let reply = null;
    try {
      reply = await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw err;
      reply = null; // The receiver answered, but not with JSON.
    }
    return { response: response, reply: reply };
  } finally {
    clearTimeout(timer);
  }
}

const EVENT_WORDS = { WATER_DROP_DETECTED: "Water drop detected" };
const SEVERITY_PILLS = {
  error: { cls: "pill-red", text: "Error" },
  warning: { cls: "pill-amber", text: "Warning" },
  ok: { cls: "pill-green", text: "OK" }
};

function makeSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function formatTime(iso) {
  const when = new Date(iso);
  return isNaN(when.getTime()) ? String(iso) : when.toLocaleString();
}

function renderFeedList(events) {
  const list = byId("feed-list");
  if (!list) return;
  list.textContent = "";

  if (events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "feed-empty";
    empty.textContent = "No alerts yet.";
    list.appendChild(empty);
    return;
  }

  events.forEach(function (item) {
    const row = document.createElement("li");
    row.className = "feed-item" + (item.cleared ? " is-cleared" : "");
    row.appendChild(makeSpan("feed-time", formatTime(item.timestamp)));
    row.appendChild(makeSpan("feed-device", String(item.device)));
    row.appendChild(makeSpan("feed-tank", String(item.tank)));
    row.appendChild(makeSpan("feed-event", EVENT_WORDS[item.event] || String(item.event)));

    const severity = SEVERITY_PILLS[item.severity];
    if (severity && !item.cleared) row.appendChild(makeSpan("pill " + severity.cls, severity.text));

    if (item.source === "real_sensor") {
      row.appendChild(makeSpan("pill pill-real", "Real sensor"));
    } else {
      row.appendChild(makeSpan("pill pill-sim", "Simulator (demo)"));
    }

    if (item.cleared) row.appendChild(makeSpan("feed-event", "Cleared"));
    else if (item.acknowledged) row.appendChild(makeSpan("feed-event", "Acknowledged"));

    list.appendChild(row);
  });
}

/** The sentence saying where an alert came from, so a demo is never taken for real. */
function bannerSourceSentence(source) {
  if (source === "simulator") return "Source: simulator (demo, not a real detection).";
  if (source === "real_sensor") return "Source: real sensor.";
  return "Source: unknown.";
}

/**
 * Builds one sentence for each different device and source that has an open
 * error. It reads the errors themselves, because a tank's status only tells us
 * about its newest event, and that may be a different one. If a tank has both a
 * simulator alert and a real sensor alert, both get named.
 */
function buildBannerLines(tanks, events) {
  const lines = [];

  tanks.forEach(function (tank) {
    if (tank.status !== "Error") return;

    const openErrors = events.filter(function (item) {
      return item.tank === tank.tank && item.severity === "error" && !item.cleared;
    });

    // The error may be older than the newest 100 events we were sent.
    if (openErrors.length === 0) {
      lines.push(tank.tank + " has an older error that has not been cleared. Its newest event came from " +
        (tank.device || "an unknown device") + ". " + bannerSourceSentence(tank.source) +
        (tank.acknowledged ? " Acknowledged." : ""));
      return;
    }

    const groups = new Map();
    openErrors.forEach(function (item) {
      const key = JSON.stringify([item.device, item.source]);
      if (!groups.has(key)) {
        groups.set(key, { device: item.device, source: item.source, acknowledged: true });
      }
      if (!item.acknowledged) groups.get(key).acknowledged = false;
    });

    groups.forEach(function (group) {
      lines.push(group.device + " reported a water drop at " + tank.tank + ". " +
        bannerSourceSentence(group.source) + (group.acknowledged ? " Acknowledged." : ""));
    });
  });

  return lines;
}

function renderTankStatus(tanks, events) {
  const holder = byId("feed-tanks");
  const banner = byId("feed-banner");

  if (holder) {
    holder.textContent = "";
    tanks.forEach(function (tank) {
      const chip = document.createElement("div");
      chip.className = "tank-chip";
      chip.dataset.status = tank.status;
      // The status is written as words as well as colour.
      chip.textContent = tank.tank + ": " + tank.status + (tank.acknowledged ? " (acknowledged)" : "");
      holder.appendChild(chip);
    });
  }

  if (banner) {
    // The banner is a role="alert", so screen readers read it out when it
    // changes. We only touch it if the words have really changed.
    const bannerText = buildBannerLines(tanks, events).join(" ");
    if (bannerText !== lastBannerText) {
      lastBannerText = bannerText;
      banner.textContent = bannerText;
      banner.hidden = bannerText === "";
    }
  }
}

/** Fetches the newest alerts. When it fails, the last known rows stay on screen. */
async function refreshFeed() {
  if (IS_ONLINE_COPY) {
    renderBrowserOnlyFeed();
    return;
  }

  feedRequestNumber += 1;
  const thisRequest = feedRequestNumber;
  const statusLine = byId("feed-status");

  try {
    const answers = await Promise.all([
      fetchWithTimeout(RECEIVER_BASE + "/api/events"),
      fetchWithTimeout(RECEIVER_BASE + "/api/status")
    ]);
    const allGood = answers.every(function (answer) { return answer.response.ok && answer.reply; });
    if (!allGood) throw new Error("The receiver replied with an error.");

    // A newer request has started, so its answer is the one to show.
    if (thisRequest !== feedRequestNumber) return;

    const events = Array.isArray(answers[0].reply.events) ? answers[0].reply.events : [];
    const tanks = Array.isArray(answers[1].reply.tanks) ? answers[1].reply.tanks : [];

    // Only touch the page when something has changed.
    const eventsJson = JSON.stringify(events);
    const statusJson = JSON.stringify(tanks);
    if (eventsJson !== lastEventsJson) renderFeedList(events);
    // The banner reads the events as well as the status, so either one can change it.
    if (eventsJson !== lastEventsJson || statusJson !== lastStatusJson) {
      renderTankStatus(tanks, events);
    }
    lastEventsJson = eventsJson;
    lastStatusJson = statusJson;

    if (statusLine) {
      // Shown to the minute, so a screen reader is not interrupted every five seconds.
      const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      statusLine.textContent = "Last updated " + clock + ". Live data from the receiver.";
    }
  } catch (err) {
    if (thisRequest !== feedRequestNumber) return;
    if (statusLine) {
      statusLine.textContent = "Could not reach the receiver. Start it to see live alerts (see README).";
    }
  }
}

/* ----- The online copy (for example on GitHub Pages) -----
   A public host can show these web pages, but it cannot run receiver/server.py.
   The receiver only runs over plain http on the team's laptop, so a page opened
   over https is always an online copy. A browser also blocks an https page from
   talking to a plain http laptop.
   So the online copy sends nothing. The demo alert stays inside this browser,
   is still labelled as simulator, and disappears when the page reloads.
   Add ?online-copy=1 to the address to try this on the laptop. */
const IS_ONLINE_COPY = location.protocol === "https:" ||
  new URLSearchParams(location.search).get("online-copy") === "1";

const MAX_BROWSER_ALERTS = 20;
const browserAlerts = [];

/** Changes the words that only make sense when the laptop receiver is running. */
function useOnlineCopyWording() {
  const replacements = {
    "feed-intro": "This online copy has no receiver, so nothing is sent or stored. Alerts here are simulated in your browser and disappear when you reload. At our live demo, a receiver on a laptop fills this panel.",
    "sim-hint": "Reset stops the simulated leak and marks the demo alerts as cleared.",
    "preview-chip": "Preview only. Press Simulate drop to see a demo alert."
  };
  Object.keys(replacements).forEach(function (id) {
    const el = byId(id);
    if (el) el.textContent = replacements[id];
  });

  // The full app needs the receiver, so the link would lead nowhere here.
  const appLink = byId("open-app");
  if (appLink) appLink.remove();
}

function addBrowserOnlyAlert() {
  if (!readTankSensor()) return;
  browserAlerts.push({
    device: EVENT_DEVICE,
    esp_board: EVENT_ESP_BOARD,
    tank: EVENT_TANK,
    event: EVENT_NAME,
    severity: EVENT_SEVERITY,
    source: SENSOR_SOURCE,
    timestamp: new Date().toISOString(),
    acknowledged: false,
    cleared: false
  });
  if (browserAlerts.length > MAX_BROWSER_ALERTS) browserAlerts.shift();
  renderBrowserOnlyFeed();
  setSendStatus("Shown in the app panel at " + new Date().toLocaleTimeString() +
    ". Source: " + sourceWords(SENSOR_SOURCE) + ". Nothing left your browser.");
}

function clearBrowserOnlyAlerts() {
  browserAlerts.forEach(function (item) { item.cleared = true; });
  renderBrowserOnlyFeed();
  setSendStatus("Reset done. The simulated leak has stopped and the demo alerts are cleared.");
}

/** Shows this browser's demo alerts using the same drawing code as live alerts. */
function renderBrowserOnlyFeed() {
  const newestFirst = browserAlerts.slice().reverse();
  const tanks = ["Tank 1", "Tank 2", "Tank 3"].map(function (name) {
    const own = newestFirst.filter(function (item) { return item.tank === name; });
    const hasOpenError = own.some(function (item) { return !item.cleared; });
    return {
      tank: name,
      status: hasOpenError ? "Error" : (own.length > 0 ? "OK" : "No data"),
      acknowledged: false
    };
  });

  renderFeedList(newestFirst);
  renderTankStatus(tanks, newestFirst);

  const statusLine = byId("feed-status");
  if (statusLine) statusLine.textContent = "Online demo. No receiver is connected and no real sensor is involved.";
}

/* =====================================================================
   4. THEME TOGGLE
   ===================================================================== */

const THEME_KEY = "dfsg-theme";

function currentThemeName() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function updateThemeButton() {
  const button = byId("theme-toggle");
  if (!button) return;
  const next = currentThemeName() === "dark" ? "light" : "dark";
  button.textContent = next === "dark" ? "Dark" : "Light";
  button.setAttribute("aria-label", "Switch to " + next + " theme");
}

function setTheme(themeName) {
  document.documentElement.dataset.theme = themeName;
  updateThemeButton();
  // The film blends from and to the theme's look, so the scene must know about it.
  normalEnvironmentApplied = false;
  requestSceneRender();
}

function wireThemeToggle() {
  updateThemeButton();
  const button = byId("theme-toggle");
  if (button) {
    button.addEventListener("click", function () {
      const next = currentThemeName() === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* storage may be blocked */ }
      setTheme(next);
    });
  }

  // If the visitor never chose a theme, follow their device setting.
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  onMediaChange(darkQuery, function () {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* storage may be blocked */ }
    if (saved !== "light" && saved !== "dark") setTheme(darkQuery.matches ? "dark" : "light");
  });
}

/** Older browsers use addListener instead of addEventListener on media queries. */
function onMediaChange(query, handler) {
  if (query.addEventListener) query.addEventListener("change", handler);
  else if (query.addListener) query.addListener(handler);
}

/* =====================================================================
   5. SCROLL ENGINE
   Works out which section is on screen and how far through each pinned
   section the visitor has scrolled. Everything else reads these numbers.
   ===================================================================== */

/* ----- Small maths helpers, used by every section below ----- */

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Where p sits between a and b, as a number from 0 to 1. */
function range(p, a, b) {
  return clamp((p - a) / (b - a), 0, 1);
}

/** Like range, but it starts and ends gently. */
function smoothstep(p, a, b) {
  const t = range(p, a, b);
  return t * t * (3 - 2 * t);
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function mix3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* ----- Section measuring ----- */

const sectionList = [];        // One record per <section>, in page order.
const sectionsById = {};       // The same records, found by id.
let activeSectionId = "hero";
let viewportHeight = window.innerHeight;
let needsMeasure = true;

function collectSections() {
  document.querySelectorAll("section[data-section]").forEach(function (el) {
    const record = {
      id: el.id,
      el: el,
      stage: el.querySelector(".pin-stage"),
      steps: Array.from(el.querySelectorAll(".pin-step")),
      dots: Array.from(el.querySelectorAll(".pin-dots span")),
      isPin: el.classList.contains("pin") && IS_MOTION,
      startY: 0,      // Page position of the top of the section.
      height: 0,
      scrollRange: 1, // How many pixels of scrolling the pin lasts.
      progress: 0,    // 0 to 1 through the pin.
      stepIndex: 0
    };
    sectionList.push(record);
    sectionsById[el.id] = record;
  });
}

/** Measures every section. Runs at start-up, on resize and after fonts load. */
function measureSections() {
  needsMeasure = false;
  viewportHeight = window.innerHeight;
  filmDom.iconCentre = null; // The film's phone icon may have moved.
  const scrolled = window.pageYOffset;
  sectionList.forEach(function (record) {
    const rect = record.el.getBoundingClientRect();
    record.startY = rect.top + scrolled;
    record.height = rect.height;
    if (record.isPin && record.stage) {
      record.scrollRange = Math.max(1, rect.height - record.stage.offsetHeight);
    }
  });
  buildCameraStops();
}

/** Reads the scroll position. Sets the active section, pin progress and steps. */
function updateScrollState() {
  if (needsMeasure) measureSections();
  const scrolled = window.pageYOffset;

  // The active section is the one that holds the middle line of the screen.
  const middle = scrolled + viewportHeight / 2;
  let nextActive = activeSectionId;
  sectionList.forEach(function (record) {
    if (middle >= record.startY && middle < record.startY + record.height) nextActive = record.id;
  });

  if (nextActive !== activeSectionId || !document.body.dataset.activeSection) {
    activeSectionId = nextActive;
    // Without WebGL, #film holds a normal stills panel, so the top bar must stay.
    const noFilmScene = document.documentElement.classList.contains("no-webgl");
    document.body.dataset.activeSection =
      activeSectionId === "film" && noFilmScene ? "film-stills" : activeSectionId;
  }

  sectionList.forEach(function (record) {
    if (!record.isPin) return;
    record.progress = clamp((scrolled - record.startY) / record.scrollRange, 0, 1);
    if (record.steps.length === 0) return;

    // Active step = floor(progress * number of steps), kept inside the list.
    const index = clamp(Math.floor(record.progress * record.steps.length), 0, record.steps.length - 1);
    if (index !== record.stepIndex) {
      record.stepIndex = index;
      record.steps.forEach(function (step, i) { step.classList.toggle("is-active", i === index); });
      record.dots.forEach(function (dot, i) { dot.classList.toggle("is-active", i === index); });
    }
  });

  updatePreviewChip();
  return scrolled;
}

/** The amber chip that says the scrolling drop is only a preview. */
function updatePreviewChip() {
  const chip = byId("preview-chip");
  const demo = sectionsById.demo;
  if (!chip || !demo) return;
  const show = IS_MOTION && activeSectionId === "demo" && !simulator.tank2Leaking && demo.progress >= 1 / 3;
  if (chip.hidden === show) chip.hidden = !show;
}

/** Fades cards in as they enter the view. */
function wireRevealCards() {
  const cards = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    cards.forEach(function (card) { card.classList.add("is-visible"); });
    return;
  }
  const watcher = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        watcher.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });
  cards.forEach(function (card) { watcher.observe(card); });
}

/* =====================================================================
   6. THREE.JS SCENE CONSTRUCTION
   World layout: y is up, the ground is y = 0, and 1 unit is about 1 metre.
   ===================================================================== */

// World positions that the camera tracks and the film rely on.
const PAD_POS = [1, 0.45, 5];                 // Drone sitting on its home pad.
const TANK2_POS = [5.5, 0, -3.5];
const LEAK_POS = [6.3, 1.0, -2.7];            // Leak point, at the base of Tank 2.
const SOIL_Y = 0.06;                          // Where the drop lands.
const RIPPLE_Y = 0.08;
const HOVER_POS = [6.3, 4.2, -2.7];           // Hover point above Tank 2.

// Everything below stays empty if WebGL is not available.
let renderer = null;
let scene = null;
let camera = null;
let sky = null;
let sunLight = null;
let hemiLight = null;
let groundMaterial = null;
let windowMaterial = null;
let drone = null;
let dropGroup = null;
let rippleRings = [];
let tankLabels = [];
let hasScene = false;
let viewW = 1;
let viewH = 1;
let lensPullback = 1;      // Moves the camera back on tall, narrow screens.
let isWideLayout = true;   // True when the panels sit on the left of the screen.
let normalEnvironmentApplied = false;
const THEME_ENVS = {};
const ENVS = {};
let filmEnvScratch = null;

/** A colour for materials and lights. Converts a web colour to the renderer's linear colours. */
function col(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/** Repeatable random numbers. The same seed gives the same campus on every visit. */
function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addBox(parent, size, pos, material, options) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  const opts = options || {};
  mesh.castShadow = opts.cast !== false;
  mesh.receiveShadow = opts.receive !== false;
  parent.add(mesh);
  return mesh;
}

/** A flat rectangle lying on the ground. */
function addFlat(parent, width, depth, pos, material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** A round pipe between two points. */
function addPipe(parent, a, b, radius, material) {
  const from = new THREE.Vector3(a[0], a[1], a[2]);
  const to = new THREE.Vector3(b[0], b[1], b[2]);
  const direction = to.clone().sub(from);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** A text label that always faces the camera. The text is drawn on a small canvas. */
const labelRedraws = [];
function makeLabelSprite(text, worldHeight) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 44;
  const padX = 26;
  const pixelHeight = 80;
  const font = "600 " + fontPx + 'px "Space Grotesk", "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width + padX * 2 + 20);
  canvas.height = pixelHeight;

  const texture = new THREE.CanvasTexture(canvas);
  texture.encoding = THREE.sRGBEncoding;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(13, 21, 32, 0.92)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffc61a";
    ctx.fillRect(0, 0, 8, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2 + 4, canvas.height / 2 + 2);
    texture.needsUpdate = true;
  }
  draw();
  labelRedraws.push(draw); // Drawn again once the web fonts have arrived.

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false
  }));
  sprite.scale.set(worldHeight * canvas.width / canvas.height, worldHeight, 1);
  sprite.renderOrder = 20;
  sprite.userData.baseScale = sprite.scale.clone();
  return sprite;
}

/** A soft round glow, used for the ESP light and around the drop. */
function makeGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/* ----- Lighting moods. Sky and fog colours are used exactly as written. ----- */

function makeEnv(spec) {
  return {
    skyTop: new THREE.Color(spec.skyTop),
    skyHorizon: new THREE.Color(spec.skyHorizon),
    skyCurve: spec.skyCurve,
    fog: new THREE.Color(spec.fog),
    fogDensity: spec.fogDensity,
    sun: col(spec.sun),
    sunIntensity: spec.sunIntensity,
    sunDir: new THREE.Vector3(spec.sunDir[0], spec.sunDir[1], spec.sunDir[2]).normalize(),
    hemiSky: col(spec.hemiSky),
    hemiGround: col(spec.hemiGround),
    hemiIntensity: spec.hemiIntensity,
    ground: col(spec.ground),
    exposure: spec.exposure,
    windowGlow: spec.windowGlow
  };
}

function buildEnvironments() {
  // Fog equals the horizon, and the horizon equals the page background,
  // so the far edge of the campus melts into the page.
  THEME_ENVS.light = makeEnv({
    skyTop: "#a8cbea", skyHorizon: "#eef2f6", skyCurve: 0.8, fog: "#eef2f6", fogDensity: 0.0068,
    sun: "#fff4e2", sunIntensity: 1.75, sunDir: [0.55, 0.8, 0.35],
    hemiSky: "#dfe9f5", hemiGround: "#8d8f78", hemiIntensity: 0.62,
    ground: "#6f9455", exposure: 0.82, windowGlow: 0
  });
  THEME_ENVS.dark = makeEnv({
    skyTop: "#0d1830", skyHorizon: "#060a13", skyCurve: 0.9, fog: "#060a13", fogDensity: 0.0105,
    sun: "#b4c6ea", sunIntensity: 1.3, sunDir: [-0.45, 0.8, 0.4],
    hemiSky: "#4a5c86", hemiGround: "#12161f", hemiIntensity: 1.15,
    ground: "#3f6349", exposure: 1.1, windowGlow: 1.0
  });
  // Film moods. The dawn sun is low and behind the campus, on the far side of
  // the garden, so the drone's long shadow falls across the grass towards the camera.
  ENVS.dawn = makeEnv({
    skyTop: "#7d9ccb", skyHorizon: "#ffc79a", skyCurve: 0.62, fog: "#f6c6a0", fogDensity: 0.0105,
    sun: "#ffad6b", sunIntensity: 2.3, sunDir: [0.8, 0.25, -0.45],
    hemiSky: "#c7b7c6", hemiGround: "#584838", hemiIntensity: 0.55,
    ground: "#71865a", exposure: 0.86, windowGlow: 0.3
  });
  ENVS.morning = makeEnv({
    skyTop: "#8db5e0", skyHorizon: "#ffe0b8", skyCurve: 0.7, fog: "#f8e2c6", fogDensity: 0.0078,
    sun: "#ffd29a", sunIntensity: 2.0, sunDir: [0.72, 0.55, -0.42],
    hemiSky: "#d7dfe8", hemiGround: "#6a5a45", hemiIntensity: 0.58,
    ground: "#74925a", exposure: 0.84, windowGlow: 0.05
  });
  ENVS.gold = makeEnv({
    skyTop: "#7fb0e4", skyHorizon: "#fff0d2", skyCurve: 0.75, fog: "#fbeeda", fogDensity: 0.0066,
    sun: "#ffe2b0", sunIntensity: 1.9, sunDir: [0.5, 0.75, 0.2],
    hemiSky: "#dfe6ea", hemiGround: "#70604a", hemiIntensity: 0.56,
    ground: "#769557", exposure: 0.82, windowGlow: 0
  });
  // Dusk has an amber line low on the horizon, a cool blue sky and a cool main light.
  ENVS.dusk = makeEnv({
    skyTop: "#1e2c58", skyHorizon: "#f0a35e", skyCurve: 0.42, fog: "#d99a70", fogDensity: 0.0072,
    sun: "#b8c6e8", sunIntensity: 1.7, sunDir: [-0.72, 0.42, 0.3],
    hemiSky: "#7c88b0", hemiGround: "#3b3330", hemiIntensity: 1.25,
    ground: "#5f7f5c", exposure: 1.1, windowGlow: 1.0
  });
  filmEnvScratch = makeEnv({
    skyTop: "#000000", skyHorizon: "#000000", skyCurve: 1, fog: "#000000", fogDensity: 0,
    sun: "#000000", sunIntensity: 0, sunDir: [0, 1, 0],
    hemiSky: "#000000", hemiGround: "#000000", hemiIntensity: 0,
    ground: "#000000", exposure: 1, windowGlow: 0
  });
}

/** Mixes two moods. Writes into out, and reads nothing from earlier frames. */
function blendEnv(a, b, t, out) {
  out.skyTop.copy(a.skyTop).lerp(b.skyTop, t);
  out.skyHorizon.copy(a.skyHorizon).lerp(b.skyHorizon, t);
  out.skyCurve = lerp(a.skyCurve, b.skyCurve, t);
  out.fog.copy(a.fog).lerp(b.fog, t);
  out.fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  out.sun.copy(a.sun).lerp(b.sun, t);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, t).normalize();
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
  out.ground.copy(a.ground).lerp(b.ground, t);
  out.exposure = lerp(a.exposure, b.exposure, t);
  out.windowGlow = lerp(a.windowGlow, b.windowGlow, t);
  return out;
}

/** Puts a mood on the scene: sky, fog, sun, soft light, ground tint and exposure. */
function applyEnvironment(env) {
  sky.material.uniforms.topColor.value.copy(env.skyTop);
  sky.material.uniforms.horizonColor.value.copy(env.skyHorizon);
  sky.material.uniforms.curve.value = env.skyCurve;
  scene.fog.color.copy(env.fog);
  scene.fog.density = env.fogDensity;
  sunLight.color.copy(env.sun);
  sunLight.intensity = env.sunIntensity;
  sunLight.position.copy(sunLight.target.position).addScaledVector(env.sunDir, 90);
  hemiLight.color.copy(env.hemiSky);
  hemiLight.groundColor.copy(env.hemiGround);
  hemiLight.intensity = env.hemiIntensity;
  groundMaterial.color.copy(env.ground);
  windowMaterial.emissiveIntensity = env.windowGlow;
  renderer.toneMappingExposure = env.exposure;
}

function applyThemeEnvironment() {
  applyEnvironment(THEME_ENVS[currentThemeName()]);
  normalEnvironmentApplied = true;
}

/* ----- The campus, piece by piece ----- */

/** Gives each face its own flat direction, which keeps the low-poly look. */
function facetedGeometry(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.computeVertexNormals();
  return flat;
}

function buildSky() {
  // A huge ball seen from the inside. Its colours skip tone mapping, so the
  // horizon really is the page background colour.
  sky = new THREE.Mesh(
    new THREE.SphereGeometry(420, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        topColor: { value: new THREE.Color(0xa8cbea) },
        horizonColor: { value: new THREE.Color(0xeef2f6) },
        curve: { value: 0.8 }
      },
      vertexShader: [
        "varying vec3 vDirection;",
        "void main() {",
        "  vDirection = normalize(position);",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 topColor;",
        "uniform vec3 horizonColor;",
        "uniform float curve;",
        "varying vec3 vDirection;",
        "void main() {",
        "  float height = clamp(normalize(vDirection).y / 0.6, 0.0, 1.0);",
        "  gl_FragColor = vec4(mix(horizonColor, topColor, pow(height, curve)), 1.0);",
        "}"
      ].join("\n")
    })
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
}

function buildGround() {
  // A faint speckled texture, so the grass does not look like flat paint.
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 256, 256);
  const random = makeSeededRandom(7);
  for (let i = 0; i < 2600; i += 1) {
    const shade = Math.floor(205 + random() * 50);
    ctx.fillStyle = "rgb(" + shade + "," + shade + "," + shade + ")";
    ctx.fillRect(random() * 256, random() * 256, 1 + random() * 3, 1 + random() * 3);
  }
  const speckle = new THREE.CanvasTexture(canvas);
  speckle.wrapS = THREE.RepeatWrapping;
  speckle.wrapT = THREE.RepeatWrapping;
  speckle.repeat.set(130, 130);
  speckle.encoding = THREE.sRGBEncoding;

  groundMaterial = new THREE.MeshLambertMaterial({ color: 0x6f9455, map: speckle });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(460, 64), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function buildRoad() {
  // The road runs along x at z = 12 and is 6 units wide.
  const asphalt = new THREE.MeshLambertMaterial({ color: col("#3e434b") });
  const pavement = new THREE.MeshLambertMaterial({ color: col("#a9a79f") });
  const paint = new THREE.MeshLambertMaterial({ color: col("#ece7d6") });
  const concrete = new THREE.MeshLambertMaterial({ color: col("#b7b2a6") });

  addFlat(scene, 500, 6, [0, 0.02, 12], asphalt);
  addFlat(scene, 500, 0.7, [0, 0.03, 8.65], pavement);
  addFlat(scene, 500, 0.7, [0, 0.03, 15.35], pavement);

  // Dashed centre line, drawn as one instanced mesh.
  const dashCount = 46;
  const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 0.16), paint, dashCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < dashCount; i += 1) {
    dummy.position.set(-92 + i * 4, 0.035, 12);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.updateMatrix();
    dashes.setMatrixAt(i, dummy.matrix);
  }
  dashes.instanceMatrix.needsUpdate = true;
  dashes.receiveShadow = true;
  dashes.frustumCulled = false; // Three.js r128 would judge all the dashes by the first one.
  scene.add(dashes);

  // A path from the school door to the gate at the road.
  addFlat(scene, 3.2, 12, [-14, 0.015, 3], concrete);

  // The gate: two pillars and a beam.
  const gateMaterial = new THREE.MeshStandardMaterial({ color: col("#50565f"), roughness: 0.7 });
  addBox(scene, [0.7, 3, 0.7], [-16.6, 1.5, 8.2], gateMaterial);
  addBox(scene, [0.7, 3, 0.7], [-11.4, 1.5, 8.2], gateMaterial);
  addBox(scene, [5.9, 0.35, 0.4], [-14, 2.85, 8.2], gateMaterial);
}

function buildSchool() {
  // Centre (-14, 0, -8), 24 wide, 10 tall and 10 deep, with the front facing +z.
  const walls = new THREE.MeshLambertMaterial({ color: col("#d9cfbe") });
  const trim = new THREE.MeshLambertMaterial({ color: col("#a69a86") });
  const roof = new THREE.MeshLambertMaterial({ color: col("#8d8a84") });
  const door = new THREE.MeshStandardMaterial({ color: col("#3a4a5a"), roughness: 0.5 });

  addBox(scene, [24, 9.8, 10], [-14, 4.9, -8], walls);
  addBox(scene, [24.3, 0.2, 10.3], [-14, 9.9, -8], roof);
  addBox(scene, [24.2, 0.5, 10.2], [-14, 0.25, -8], trim);
  addBox(scene, [24.12, 0.14, 10.12], [-14, 3.62, -8], trim, { cast: false });
  addBox(scene, [24.12, 0.14, 10.12], [-14, 6.82, -8], trim, { cast: false });

  // Parapet: a low wall around the flat roof.
  addBox(scene, [24.3, 0.6, 0.25], [-14, 10.3, -3.0], trim);
  addBox(scene, [24.3, 0.6, 0.25], [-14, 10.3, -13.0], trim);
  addBox(scene, [0.25, 0.6, 10.3], [-26.05, 10.3, -8], trim);
  addBox(scene, [0.25, 0.6, 10.3], [-1.95, 10.3, -8], trim);

  // Door and canopy.
  addBox(scene, [2.6, 2.8, 0.12], [-14, 1.4, -2.96], door, { cast: false });
  addBox(scene, [4.2, 0.2, 1.8], [-14, 3.05, -2.2], trim);

  // Windows, one instanced mesh. They glow a little at night and at dusk.
  windowMaterial = new THREE.MeshStandardMaterial({
    color: col("#34506b"),
    roughness: 0.2,
    metalness: 0.3,
    emissive: col("#ffc777"),
    emissiveIntensity: 0
  });
  const placements = [];
  const rows = [2.05, 5.25, 8.3];
  rows.forEach(function (rowY, rowIndex) {
    for (let i = 0; i < 12; i += 1) {
      const x = -25 + i * 2;
      const behindDoor = rowIndex === 0 && x > -17 && x < -11;
      if (!behindDoor) placements.push([x, rowY, -2.97, 0]);
      placements.push([x, rowY, -13.03, 0]);
    }
    for (let i = 0; i < 4; i += 1) {
      const z = -11.6 + i * 2.4;
      placements.push([-26.03, rowY, z, Math.PI / 2]);
      placements.push([-1.97, rowY, z, Math.PI / 2]);
    }
  });
  const windows = new THREE.InstancedMesh(new THREE.BoxGeometry(1.25, 1.55, 0.08), windowMaterial, placements.length);
  const dummy = new THREE.Object3D();
  placements.forEach(function (place, i) {
    dummy.position.set(place[0], place[1], place[2]);
    dummy.rotation.set(0, place[3], 0);
    dummy.updateMatrix();
    windows.setMatrixAt(i, dummy.matrix);
  });
  windows.instanceMatrix.needsUpdate = true;
  windows.frustumCulled = false;
  scene.add(windows);
}

/** One water tank. Its origin is on the ground (or roof) under the middle of the tank. */
function buildTank(x, y, z, labelText, labelOffset) {
  const group = new THREE.Group();
  group.position.set(x, y, z);

  const body = new THREE.MeshStandardMaterial({ color: col("#2b3440"), roughness: 0.62 });
  const rib = new THREE.MeshStandardMaterial({ color: col("#1d242d"), roughness: 0.7 });
  const lid = new THREE.MeshStandardMaterial({ color: col("#bfc5c9"), roughness: 0.55 });
  const steel = new THREE.MeshStandardMaterial({ color: col("#7d858c"), roughness: 0.45, metalness: 0.4 });

  // The tank sits on a short stand, so its base is at y = 1.0. The platform is
  // narrower than the tank, so a drop falling from the outer edge has a clear path.
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.12, 24), steel);
  platform.position.y = 0.94;
  platform.castShadow = true;
  group.add(platform);
  // The legs sit on the x and z axes, well away from the leak point on the +x, +z side,
  // so the drop and its ripple ring have clear ground around them.
  [[0.74, 0], [-0.74, 0], [0, 0.74], [0, -0.74]].forEach(function (leg) {
    addBox(group, [0.13, 0.9, 0.13], [leg[0], 0.45, leg[1]], steel);
  });

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 36), body);
  tank.position.y = 2.1;
  tank.castShadow = true;
  tank.receiveShadow = true;
  group.add(tank);

  for (let i = 0; i < 5; i += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.115, 0.028, 8, 44), rib);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.3 + i * 0.4;
    group.add(ring);
  }

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.13, 0.22, 36), lid);
  cap.position.y = 3.31;
  cap.castShadow = true;
  group.add(cap);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.14, 16), lid);
  knob.position.y = 3.49;
  group.add(knob);

  // Small outlet pipe at the base, on the side that faces +x and +z.
  addPipe(group, [0.62, 1.08, 0.62], [0.87, 1.08, 0.87], 0.055, steel);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.09, 12), steel);
  nozzle.position.set(0.8, 1.07, 0.8);
  group.add(nozzle);

  scene.add(group);

  const label = makeLabelSprite(labelText, 0.72);
  label.position.set(x + labelOffset[0], y + labelOffset[1], z + labelOffset[2]);
  scene.add(label);
  tankLabels.push(label);
  return group;
}

function buildGarden(isSmallScreen) {
  // Soil patch: centre (9, 0.05, -1), 12 by 9. It reaches under the leak point.
  const soil = new THREE.MeshLambertMaterial({ color: col("#5d4632") });
  addFlat(scene, 12, 9, [9, 0.05, -1], soil);

  // The beds stay east of x = 8, so the low film shot along x = 7 sees the
  // soil under the leak with nothing in the way.
  const wood = new THREE.MeshLambertMaterial({ color: col("#8a6a48") });
  const bedSoil = new THREE.MeshLambertMaterial({ color: col("#3f2f22") });
  const bedCentres = [];
  [9.45, 12.65].forEach(function (x) {
    [-3.9, -1.1, 1.7].forEach(function (z) { bedCentres.push([x, z]); });
  });
  bedCentres.forEach(function (bed) {
    addBox(scene, [2.75, 0.3, 2.05], [bed[0], 0.2, bed[1]], wood);
    addBox(scene, [2.5, 0.04, 1.8], [bed[0], 0.36, bed[1]], bedSoil, { cast: false });
  });

  const perBed = isSmallScreen ? 6 : 12;
  const plantCount = bedCentres.length * perBed;
  const leaf = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const plants = new THREE.InstancedMesh(facetedGeometry(new THREE.IcosahedronGeometry(0.2, 0)), leaf, plantCount);
  const random = makeSeededRandom(21);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const greens = ["#3f8a3e", "#58a03f", "#2f7a48", "#73a845"];
  let index = 0;
  bedCentres.forEach(function (bed) {
    for (let i = 0; i < perBed; i += 1) {
      const across = (i % 4) - 1.5;
      const along = Math.floor(i / 4) - 1;
      const size = 0.7 + random() * 0.65;
      dummy.position.set(bed[0] + across * 0.58 + random() * 0.1, 0.48 + size * 0.1, bed[1] + along * 0.55 + random() * 0.1);
      dummy.rotation.set(random() * 3, random() * 3, random() * 3);
      dummy.scale.set(size, size * 1.2, size);
      dummy.updateMatrix();
      plants.setMatrixAt(index, dummy.matrix);
      tint.copy(col(greens[Math.floor(random() * greens.length)]));
      plants.setColorAt(index, tint);
      index += 1;
    }
  });
  plants.instanceMatrix.needsUpdate = true;
  if (plants.instanceColor) plants.instanceColor.needsUpdate = true;
  plants.castShadow = true;
  plants.frustumCulled = false;
  scene.add(plants);
}

function buildIrrigation() {
  // A thin pipe from Tank 3, along the ground, then down the side of the garden.
  const pipe = new THREE.MeshStandardMaterial({ color: col("#2d6fa8"), roughness: 0.5 });
  const y = 0.1;
  addPipe(scene, [18.3, y, -10.2], [14.8, y, -5.8], 0.06, pipe);
  addPipe(scene, [14.8, y, -5.8], [14.8, y, 2.6], 0.06, pipe);
  [-8, -4.4, -1.1, 1.9].forEach(function (z, i) {
    // The first riser stands on the slanted part of the pipe.
    const x = i === 0 ? 16.55 : 14.8;
    addPipe(scene, [x, y, z], [x, 0.62, z], 0.035, pipe);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), pipe);
    head.position.set(x, 0.66, z);
    scene.add(head);
  });
}

function buildPad() {
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(1.25, 40),
    new THREE.MeshLambertMaterial({ color: col("#8f9a7c") })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(PAD_POS[0], 0.012, PAD_POS[2]);
  pad.receiveShadow = true;
  scene.add(pad);
}

/** True if a tree here would block the road, the buildings or a film shot. */
function treeBlocked(x, z) {
  function inside(x0, x1, z0, z1) { return x > x0 && x < x1 && z > z0 && z < z1; }
  return inside(-32, 3, -19, 2) ||      // School and the space around it.
    (z > 6.5 && z < 18) ||              // Road and pavements.
    inside(-1, 29, -19, 7) ||           // Garden, Tank 2, Tank 3 and the pipe.
    inside(-24, 14, 0, 8);              // Drone pad and the flight past the school.
}

function buildTrees(isSmallScreen) {
  const random = makeSeededRandom(1402);
  const target = isSmallScreen ? 26 : 56;
  // A few placed by hand, so the low shots have tree shapes behind the tanks.
  const spots = [[-33, -3], [-34, -12], [-29, -21], [-14, -22], [-1, -21], [4, -20], [11, -22], [18, -21], [29, -14], [31, -3], [30, 5]];
  let attempts = 0;
  while (spots.length < target && attempts < 2000) {
    attempts += 1;
    const x = -75 + random() * 150;
    const z = -60 + random() * 105;
    if (!treeBlocked(x, z)) spots.push([x, z]);
  }

  const trunkMaterial = new THREE.MeshLambertMaterial({ color: col("#5a4332") });
  const crownMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.24, 1, 7), trunkMaterial, spots.length);
  const cones = new THREE.InstancedMesh(facetedGeometry(new THREE.ConeGeometry(1, 1, 8)), crownMaterial, spots.length);
  const balls = new THREE.InstancedMesh(facetedGeometry(new THREE.IcosahedronGeometry(1, 1)), crownMaterial, spots.length);

  const dummy = new THREE.Object3D();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const tint = new THREE.Color();
  const greens = ["#3d7a43", "#2f6b3e", "#4f8a45", "#5b9448"];

  spots.forEach(function (spot, i) {
    const size = 0.85 + random() * 0.45;
    const trunkHeight = 1.5 * size;
    dummy.rotation.set(0, random() * 6.28, 0);
    dummy.position.set(spot[0], trunkHeight / 2, spot[1]);
    dummy.scale.set(size, trunkHeight, size);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);

    tint.copy(col(greens[Math.floor(random() * greens.length)]));
    if (random() < 0.45) {
      const coneHeight = 4 * size;
      dummy.position.set(spot[0], trunkHeight + coneHeight / 2 - 0.2, spot[1]);
      dummy.scale.set(1.7 * size, coneHeight, 1.7 * size);
      dummy.updateMatrix();
      cones.setMatrixAt(i, dummy.matrix);
      balls.setMatrixAt(i, hidden);
    } else {
      const crown = 1.9 * size;
      dummy.position.set(spot[0], trunkHeight + crown * 0.75, spot[1]);
      dummy.scale.set(crown, crown * 1.05, crown);
      dummy.updateMatrix();
      balls.setMatrixAt(i, dummy.matrix);
      cones.setMatrixAt(i, hidden);
    }
    cones.setColorAt(i, tint);
    balls.setColorAt(i, tint);
  });

  [trunks, cones, balls].forEach(function (mesh) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  });
}

function buildDrone(glowTexture) {
  // The local origin is the middle of the body, and the skids reach y = -0.45,
  // so the drone sits on the ground at y = 0.45. Its front faces +z.
  // It is a generic camera quadcopter with no branding.
  drone = new THREE.Group();
  drone.rotation.order = "YXZ"; // Turn first, then tip forward and bank.

  const shell = new THREE.MeshStandardMaterial({ color: col("#e8ebee"), roughness: 0.42 });
  const dark = new THREE.MeshStandardMaterial({ color: col("#20262e"), roughness: 0.55 });
  const blade = new THREE.MeshStandardMaterial({ color: col("#14181e"), roughness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: col("#e9a800"), roughness: 0.5 });

  function castAll(mesh) { mesh.castShadow = true; drone.add(mesh); return mesh; }

  const upper = castAll(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), shell));
  upper.scale.set(0.32, 0.14, 0.42);
  upper.position.y = 0.015;
  const lower = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.56), dark));
  lower.position.y = -0.055;
  const stripe = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.5), accent));
  stripe.position.y = 0.145;

  // Four arms, four motors and four rotors. Rotors reach 0.8 from the middle.
  const rotors = [];
  const rotorDiscMaterials = [];
  [[0.52, 0.52, 1], [-0.52, 0.52, -1], [0.52, -0.52, -1], [-0.52, -0.52, 1]].forEach(function (place) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.7), dark);
    arm.position.set(place[0] * 0.56, 0, place[1] * 0.56);
    arm.rotation.y = Math.atan2(place[0], place[1]);
    castAll(arm);

    const motor = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 14), dark));
    motor.position.set(place[0], 0.05, place[1]);

    const rotor = new THREE.Group();
    rotor.position.set(place[0], 0.125, place[1]);
    rotor.userData.direction = place[2];
    const blades = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.008, 0.05), blade);
    rotor.add(blades);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8), dark);
    rotor.add(hub);
    drone.add(rotor);
    rotors.push(rotor);

    // A faint disc, the blur of the spinning blades. It stays still, so a
    // separate mesh keeps it from turning with the rotor.
    const discMaterial = new THREE.MeshBasicMaterial({
      color: 0x20262e,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.28, 28), discMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(place[0], 0.125, place[1]);
    drone.add(disc);
    rotorDiscMaterials.push(discMaterial);
  });

  // Landing skids: two rails with four struts. The rails touch y = -0.45.
  [0.3, -0.3].forEach(function (x) {
    const rail = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.86, 8), dark));
    rail.rotation.x = Math.PI / 2;
    rail.position.set(x, -0.43, 0);
    [0.24, -0.24].forEach(function (z) {
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.36, 6), dark);
      strut.position.set(x * 0.8, -0.26, z);
      strut.rotation.z = x > 0 ? 0.17 : -0.17;
      castAll(strut);
    });
  });

  // Small nav lights: green at the front and red at the back.
  const navFront = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: col("#35d07f"), toneMapped: false }));
  navFront.position.set(0, 0.02, 0.43);
  drone.add(navFront);
  const navBack = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: col("#ff5a4a"), toneMapped: false }));
  navBack.position.set(0, 0.02, -0.43);
  drone.add(navBack);

  // The camera: a small gimbal under the front of the drone.
  const gimbalY = -0.2;
  const mount = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 10), dark));
  mount.position.set(0, -0.14, 0.32);
  const gimbal = castAll(new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), dark));
  gimbal.position.set(0, gimbalY, 0.32);
  const lens = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.046, 0.06, 14), new THREE.MeshStandardMaterial({ color: col("#0c1014"), roughness: 0.12, metalness: 0.5 })));
  lens.rotation.x = Math.PI / 2 + 0.5;
  lens.position.set(0, gimbalY - 0.03, 0.385);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.03, 14), new THREE.MeshBasicMaterial({ color: col("#4f8fc4"), toneMapped: false }));
  glass.rotation.x = 0.5;
  glass.position.set(0, gimbalY - 0.046, 0.416);
  drone.add(glass);

  // The ESP board: a green circuit board under the body, behind the camera.
  // It is a labelled demo part.
  const espGroup = new THREE.Group();
  espGroup.position.set(0, -0.19, -0.07);
  drone.add(espGroup);
  const pcbGreen = new THREE.MeshStandardMaterial({ color: col("#1f8a4c"), roughness: 0.55 });
  const chipBlack = new THREE.MeshStandardMaterial({ color: col("#14181c"), roughness: 0.4 });
  const pinGold = new THREE.MeshStandardMaterial({ color: col("#d4b264"), roughness: 0.35, metalness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.02, 0.26), pcbGreen);
  pcb.castShadow = true;
  espGroup.add(pcb);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.022, 0.11), chipBlack);
  chip.position.set(-0.03, -0.02, 0);
  espGroup.add(chip);
  [-0.11, 0.11].forEach(function (z) {
    for (let i = 0; i < 8; i += 1) {
      const pin = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.03, 0.016), pinGold);
      pin.position.set(-0.14 + i * 0.04, -0.022, z);
      espGroup.add(pin);
    }
  });
  [[-0.14, -0.11], [0.14, -0.11], [-0.14, 0.11], [0.14, 0.11]].forEach(function (post) {
    const standoff = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.07, 6), dark);
    standoff.position.set(post[0], 0.04, post[1]);
    espGroup.add(standoff);
  });

  // The light on the ESP board, with a soft glow so it reads from far away.
  const espLed = new THREE.Mesh(
    new THREE.SphereGeometry(0.024, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x1a2a20, toneMapped: false })
  );
  espLed.position.set(0.12, -0.022, 0.05);
  espGroup.add(espLed);
  // Normal blending, not additive: additive light can only add to what is behind
  // it, so over a bright sky a red glow would wash out to pale pink or white.
  const espGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
    fog: false
  }));
  espGlow.position.copy(espLed.position);
  espGlow.scale.set(0.5, 0.5, 1);
  espGlow.renderOrder = 15;
  espGroup.add(espGlow);

  // Labels with thin pointer lines. Each one is switched on by the camera track.
  function addPartLabel(text, partPos, labelPos) {
    const holder = new THREE.Group();
    const sprite = makeLabelSprite(text, 0.13);
    sprite.position.set(labelPos[0], labelPos[1], labelPos[2]);
    holder.add(sprite);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(partPos[0], partPos[1], partPos[2]),
        new THREE.Vector3(labelPos[0], labelPos[1], labelPos[2])
      ]),
      new THREE.LineBasicMaterial({ color: 0xffc61a, depthTest: false, transparent: true, toneMapped: false, fog: false })
    );
    line.renderOrder = 19;
    holder.add(line);
    holder.visible = false;
    drone.add(holder);
    return holder;
  }
  const espLabel = addPartLabel("ESP board (demo)", [0.05, -0.22, -0.2], [0.05, -0.3, -0.75]);
  const cameraLabel = addPartLabel("Camera", [0.04, -0.22, 0.34], [0.62, -0.36, 0.52]);

  drone.userData = {
    rotors: rotors,
    rotorDiscMaterials: rotorDiscMaterials,
    espLed: espLed,
    espGlow: espGlow,
    espLabel: espLabel,
    cameraLabel: cameraLabel
  };
  drone.position.set(PAD_POS[0], PAD_POS[1], PAD_POS[2]);
  scene.add(drone);
}

function buildDropAndRipple(glowTexture) {
  // A teardrop: a sphere that is stretched, with its top squeezed to a point.
  const geometry = new THREE.SphereGeometry(0.09, 16, 12);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i) / 0.09;
    const squeeze = y > 0 ? 1 - 0.72 * y : 1;
    positions.setX(i, positions.getX(i) * squeeze);
    positions.setZ(i, positions.getZ(i) * squeeze);
    positions.setY(i, positions.getY(i) * (y > 0 ? 1.75 : 1.05));
  }
  geometry.computeVertexNormals();

  dropGroup = new THREE.Group();
  const drop = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: col("#8fd3ff"),
    emissive: col("#2f9bff"),
    emissiveIntensity: 1.1,
    roughness: 0.12,
    metalness: 0
  }));
  drop.castShadow = true;
  dropGroup.add(drop);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xa8dcff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false
  }));
  halo.scale.set(0.5, 0.5, 1);
  dropGroup.add(halo);
  dropGroup.position.set(LEAK_POS[0], LEAK_POS[1], LEAK_POS[2]);
  dropGroup.visible = false;
  scene.add(dropGroup);

  // Two thin flat rings on the soil, where the drop lands.
  const ringSizes = [[0.47, 0.55], [0.25, 0.3]];
  rippleRings = ringSizes.map(function (size) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(size[0], size[1], 56),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(LEAK_POS[0], RIPPLE_Y, LEAK_POS[2]);
    ring.visible = false;
    scene.add(ring);
    return ring;
  });
}

const RIPPLE_PALE = { r: 0, g: 0, b: 0 };
const RIPPLE_RED = { r: 0, g: 0, b: 0 };

/** Shows the drop at a height and size, or hides it. */
function showDrop(visible, y, size) {
  dropGroup.visible = visible;
  if (!visible) return;
  dropGroup.position.y = y;
  dropGroup.scale.setScalar(Math.max(size, 0.001));
}

/** Sets the two rings. red runs from 0 (water-pale) to 1 (alert red). */
function showRipple(scale, opacity, red) {
  const visible = opacity > 0.001;
  rippleRings.forEach(function (ring, i) {
    ring.visible = visible;
    if (!visible) return;
    ring.scale.setScalar(scale);
    ring.material.opacity = i === 0 ? opacity : opacity * 0.8;
    ring.material.color.setRGB(
      lerp(RIPPLE_PALE.r, RIPPLE_RED.r, red),
      lerp(RIPPLE_PALE.g, RIPPLE_RED.g, red),
      lerp(RIPPLE_PALE.b, RIPPLE_RED.b, red)
    );
  });
}

/** Sets the light on the ESP board from its three possible states. */
function showEspLight(blink, red, glowSize) {
  const nodes = drone.userData;
  const size = glowSize === undefined ? 0.5 : glowSize;
  nodes.espGlow.scale.set(size, size, 1);
  const led = nodes.espLed.material.color;
  // Off is a dark green, a blink is a bright pale green, and an alert is red.
  const r = lerp(lerp(0.1, 0.72, blink), 1.0, red);
  const g = lerp(lerp(0.16, 1.0, blink), 0.05, red);
  const b = lerp(lerp(0.12, 0.8, blink), 0.05, red);
  led.setRGB(r, g, b);
  // The glow uses stronger colours, so it still reads as green or red over the sky.
  nodes.espGlow.material.color.setRGB(lerp(0.1, 1.0, red), lerp(1.0, 0.03, red), lerp(0.3, 0.03, red));
  nodes.espGlow.material.opacity = Math.max(blink, red) * 0.95;
}

function setTankLabelsVisible(visible) {
  tankLabels.forEach(function (label) { label.visible = visible; });
}

/** Builds the whole scene. Returns false if WebGL or Three.js is not available. */
function buildScene() {
  const canvas = byId("scene");
  if (typeof THREE === "undefined" || !canvas) return false;

  // On a sharp screen the extra pixels already smooth the edges, so we skip the
  // costly antialiasing. "high-performance" asks a laptop with two graphics chips
  // to use the stronger one.
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: (window.devicePixelRatio || 1) < 1.5,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance"
  });
  const isSmallScreen = window.innerWidth < 768;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Shadows are redrawn every few frames, not every frame. See motionFrame.
  renderer.shadowMap.autoUpdate = false;

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xeef2f6, 0.0068);
  camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.2, 900);

  // The sun's shadow camera covers the whole campus.
  sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
  sunLight.castShadow = true;
  sunLight.target.position.set(-3, 0, -1);
  sunLight.shadow.mapSize.set(isSmallScreen ? 768 : 1024, isSmallScreen ? 768 : 1024);
  sunLight.shadow.camera.left = -48;
  sunLight.shadow.camera.right = 48;
  sunLight.shadow.camera.top = 48;
  sunLight.shadow.camera.bottom = -48;
  sunLight.shadow.camera.near = 5;
  sunLight.shadow.camera.far = 230;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.03;
  scene.add(sunLight);
  scene.add(sunLight.target);

  hemiLight = new THREE.HemisphereLight(0xffffff, 0x777777, 0.6);
  scene.add(hemiLight);

  const whiteRed = col("#d42020");
  RIPPLE_RED.r = whiteRed.r; RIPPLE_RED.g = whiteRed.g; RIPPLE_RED.b = whiteRed.b;
  const palePale = col("#bfe6ff");
  RIPPLE_PALE.r = palePale.r; RIPPLE_PALE.g = palePale.g; RIPPLE_PALE.b = palePale.b;

  const glowTexture = makeGlowTexture();

  buildSky();
  buildGround();
  buildRoad();
  buildSchool();
  buildGarden(isSmallScreen);
  buildIrrigation();
  buildPad();
  buildTrees(isSmallScreen);

  // Tank 1 on the roof, Tank 2 by the garden, and Tank 3 by the irrigation line.
  // The label for Tank 2 sits to one side, because the drone hovers right above that tank.
  buildTank(-20, 10, -8, "Tank 1", [0, 4.5, 0]);
  buildTank(TANK2_POS[0], TANK2_POS[1], TANK2_POS[2], "Tank 2", [1.7, 3.5, -1.7]);
  buildTank(19, 0, -11, "Tank 3", [0, 4.5, 0]);

  buildDrone(glowTexture);
  buildDropAndRipple(glowTexture);
  buildEnvironments();
  applyThemeEnvironment();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      labelRedraws.forEach(function (redraw) { redraw(); });
      requestSceneRender();
    });
  }

  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    hasScene = false;
  });
  canvas.addEventListener("webglcontextrestored", function () {
    hasScene = true;
    requestSceneRender();
  });

  return true;
}

/**
 * The browser prepares a graphic the first time it is drawn, and that can freeze the
 * picture for a second. The drop and the ripple first appear late in the film, so that
 * freeze would land in the middle of it. Drawing everything once at load, before anyone
 * sees it, moves that wait to the start. If this fails, the site still works.
 */
function prepareAllGraphics() {
  const undo = [];
  scene.traverse(function (object) {
    undo.push({ object: object, visible: object.visible, culled: object.frustumCulled });
    object.visible = true;
    object.frustumCulled = false;
  });
  try {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
  } catch (err) {
    // Nothing to do: each graphic will simply be prepared when it is first drawn.
  }
  undo.forEach(function (saved) {
    saved.object.visible = saved.visible;
    saved.object.frustumCulled = saved.culled;
  });
}

/** Matches the drawing size and the lens to the canvas. */
function resizeRenderer() {
  if (!renderer) return;
  const canvas = renderer.domElement;
  viewW = Math.max(1, canvas.clientWidth);
  viewH = Math.max(1, canvas.clientHeight);
  const sharpest = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(sharpest * QUALITY_LEVELS[qualityLevel].scale);
  renderer.setSize(viewW, viewH, false);
  camera.aspect = viewW / viewH;
  fitCameraLens();
  // A phone on its side keeps its panel on the left, like a desktop.
  isWideLayout = viewW >= 900 || (viewH <= 500 && viewW > viewH);
}

/**
 * On a tall phone, the same lens would see too little from side to side.
 * So the lens gets wider up to a limit, and past that the camera moves back.
 * The film and the normal site share this, so their shots always match.
 */
function fitCameraLens() {
  const aspect = camera.aspect;
  const wantedSideView = 0.5; // tan(half the side angle) on a normal laptop-shaped screen.
  let fov = 42;
  if (aspect < 1.3) {
    fov = Math.min(68, 2 * Math.atan(wantedSideView / aspect) * 180 / Math.PI);
  }
  camera.fov = fov;
  const sideView = Math.tan(fov * Math.PI / 360) * aspect;
  lensPullback = Math.max(1, wantedSideView / sideView);
  camera.updateProjectionMatrix();
}

/**
 * Moves the picture so the subject clears the panels. weight 0 means no shift.
 * extraLift (0 to 1) raises the picture further on narrow screens. The Live
 * demo needs it, so the tank's base and the falling drop stay above the panel.
 */
function applyViewOffset(weight, extraLift) {
  if (weight <= 0.0001) {
    if (camera.view && camera.view.enabled) camera.clearViewOffset();
    return;
  }
  if (isWideLayout) {
    camera.setViewOffset(viewW, viewH, -viewW * 0.16 * weight, 0, viewW, viewH);
  } else {
    const lift = 0.18 * weight + 0.05 * (extraLift || 0);
    camera.setViewOffset(viewW, viewH, 0, viewH * lift, viewW, viewH);
  }
}

/**
 * Points the camera. The drift arguments add the small handheld movement.
 * pullback is optional. It replaces the normal distance from the subject.
 */
function pointCamera(pos, look, driftX, driftY, driftZ, pullback) {
  const k = pullback === undefined ? lensPullback : pullback;
  camera.position.set(
    look[0] + (pos[0] - look[0]) * k + (driftX || 0),
    Math.max(0.32, look[1] + (pos[1] - look[1]) * k) + (driftY || 0),
    look[2] + (pos[2] - look[2]) * k + (driftZ || 0)
  );
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateMatrixWorld();
  sky.position.copy(camera.position);
}

/** Spins the rotors. speed runs from 0 (still) to 1 (full speed). */
function spinRotors(speed, dt) {
  const nodes = drone.userData;
  nodes.rotors.forEach(function (rotor) {
    rotor.rotation.y += rotor.userData.direction * speed * 34 * dt;
  });
  nodes.rotorDiscMaterials.forEach(function (material) {
    material.opacity = 0.03 + 0.2 * speed;
  });
}

/* =====================================================================
   7. CAMERA TRACK FOR THE NORMAL SITE
   Each key says where the camera is, what it looks at, and where the drone is.
   ===================================================================== */

// The film's last frame and the app panel's first key are the same numbers,
// so nothing jumps when the film ends.
const WIDE_CAM = [14, 26, 34];
const WIDE_LOOK = [-1, 0, -3];
const FINAL_DRONE = [6.3, 5.4, -2.7];
const FINAL_YAW = 2.6;

/** The wide shot, turned around its target by an angle, for the slow orbit. */
function orbitKey(angle) {
  const dx = WIDE_CAM[0] - WIDE_LOOK[0];
  const dz = WIDE_CAM[2] - WIDE_LOOK[2];
  const radius = Math.sqrt(dx * dx + dz * dz);
  const start = Math.atan2(dx, dz);
  return {
    cam: [WIDE_LOOK[0] + Math.sin(start + angle) * radius, WIDE_CAM[1], WIDE_LOOK[2] + Math.cos(start + angle) * radius],
    look: WIDE_LOOK,
    drone: FINAL_DRONE,
    yaw: FINAL_YAW
  };
}

const DEMO_KEY = { cam: [12.6, 3.6, 3.2], look: [6.2, 2.0, -2.9], drone: HOVER_POS, yaw: 0.8 };

const SITE_KEYS = {
  // Low and looking past the drone towards Tank 2 and the garden, with open sky above.
  hero: [{ cam: [-2.6, 2.5, 10.8], look: [1.4, 3.7, 5], drone: [1, 5, 5], yaw: -0.5 }],
  question: [{ cam: [10, 14, 26], look: [-1, 1, -2], drone: [2.5, 6.5, 4.5], yaw: 0.35 }],
  focus: [{ cam: [16, 8, 8], look: [5.5, 1, -3.5], drone: [8.6, 4.8, -0.4], yaw: 0.9 }],
  plan: [
    // Tank 2, then the irrigation line at Tank 3, then the garden, then Tank 1 on the roof.
    { cam: [12.8, 4.9, 3.8], look: [5.5, 1.7, -3.5], drone: [7.9, 4.5, -1.5], yaw: 0.8 },
    { cam: [28, 6.6, 0.6], look: [16.8, 0.9, -8.4], drone: [18.4, 3.9, -6.2], yaw: 0.9 },
    { cam: [17.6, 6.6, 7.6], look: [10, 0.4, -0.8], drone: [11.2, 3.8, 1.2], yaw: 0.7 },
    { cam: [-11.5, 14.6, 0.5], look: [-20, 11.7, -8], drone: [-16.4, 12.9, -5], yaw: 0.8 }
  ],
  inside: [
    // A three-quarter view, the ESP board from beneath, the camera from the
    // front and beneath, then far enough back to see the drone and Tank 2.
    { cam: [3.4, 4.9, 8.1], look: [1, 4, 5], drone: [1, 4, 5], yaw: 0 },
    { cam: [2.0, 2.65, 6.35], look: [1.05, 3.88, 4.9], drone: [1, 4, 5], yaw: 0 },
    { cam: [1.4, 3.2, 7.7], look: [1.1, 3.85, 5.3], drone: [1, 4, 5], yaw: 0 },
    { cam: [11, 7, 15], look: [2.6, 3.6, 3.8], drone: [1, 4, 5], yaw: 0 }
  ],
  demo: [
    { cam: [15.2, 5.2, 6.2], look: [6.6, 2.0, -2.4], drone: HOVER_POS, yaw: 0.8 },
    DEMO_KEY
  ],
  "app-panel": [orbitKey(0)],
  safety: [orbitKey(-0.2)],
  parts: [orbitKey(-0.4)],
  answer: [orbitKey(-0.62)]
};

let cameraStops = [];

/** Turns the keys above into a list of page positions, using the measured sections. */
function buildCameraStops() {
  const stops = [];
  function addStop(y, key) { stops.push({ y: y, key: key }); }

  function addFlowSection(id) {
    const record = sectionsById[id];
    const keys = SITE_KEYS[id];
    if (!record || !keys) return;
    const centre = Math.max(0, record.startY + record.height / 2 - viewportHeight / 2);
    addStop(Math.max(0, centre - viewportHeight * 0.1), keys[0]);
    addStop(centre + viewportHeight * 0.1, keys[0]);
  }

  /** Each step holds still in its middle, and the camera moves between steps. */
  function addPinSection(id) {
    const record = sectionsById[id];
    const keys = SITE_KEYS[id];
    if (!record || !keys) return;
    keys.forEach(function (key, i) {
      const size = record.scrollRange / keys.length;
      addStop(record.startY + size * (i + 0.2), key);
      addStop(record.startY + size * (i + 0.8), key);
    });
  }

  addFlowSection("hero");
  addFlowSection("question");
  addFlowSection("focus");
  addPinSection("plan");
  addPinSection("inside");

  // Demo: arrive at Tank 2 during its first step, then hold there.
  const demo = sectionsById.demo;
  const film = sectionsById.film;
  if (demo && film) {
    addStop(demo.startY, SITE_KEYS.demo[0]);
    addStop(demo.startY + demo.scrollRange * 0.26, DEMO_KEY);
    // Holds while the demo stage scrolls away, ready for the film to take over.
    addStop(film.startY, DEMO_KEY);
    addStop(film.startY + film.scrollRange, SITE_KEYS["app-panel"][0]);
  }

  addFlowSection("app-panel");
  addFlowSection("safety");
  addFlowSection("parts");
  addFlowSection("answer");

  stops.sort(function (a, b) { return a.y - b.y; });
  cameraStops = stops;
}

/** Works out the camera and drone for one scroll position. */
function siteTrackAt(scrolled) {
  const stops = cameraStops;
  if (stops.length === 0) return null;
  if (scrolled <= stops[0].y) return { cam: stops[0].key.cam, look: stops[0].key.look, drone: stops[0].key.drone, yaw: stops[0].key.yaw };

  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (scrolled <= b.y) {
      const s = b.y > a.y ? smoothstep(scrolled, a.y, b.y) : 1;
      const dronePos = mix3(a.key.drone, b.key.drone, s);
      // The drone climbs in a gentle arc, so it clears the school when it crosses over.
      const dx = b.key.drone[0] - a.key.drone[0];
      const dz = b.key.drone[2] - a.key.drone[2];
      dronePos[1] += Math.sin(Math.PI * s) * Math.min(3, Math.sqrt(dx * dx + dz * dz) * 0.15);
      return {
        cam: mix3(a.key.cam, b.key.cam, s),
        look: mix3(a.key.look, b.key.look, s),
        drone: dronePos,
        yaw: lerp(a.key.yaw, b.key.yaw, s)
      };
    }
  }
  const last = stops[stops.length - 1].key;
  return { cam: last.cam, look: last.look, drone: last.drone, yaw: last.yaw };
}

/** Which labels show. The Camera label needs step 3 of "Inside the drone". */
function updateLabelsForSite() {
  const nodes = drone.userData;
  // #film is the active section a little before and after the film owns the
  // camera, and no labels may show during that time. Reduced motion keeps them.
  setTankLabelsVisible(!(IS_MOTION && activeSectionId === "film"));
  const inside = sectionsById.inside;
  const inInside = activeSectionId === "inside";
  nodes.espLabel.visible = inInside;
  nodes.cameraLabel.visible = inInside && (IS_REDUCED || (inside && inside.stepIndex === 2));
}

/** Tank labels keep a readable size as the camera moves away from them. */
function updateTankLabelScale() {
  tankLabels.forEach(function (label) {
    const distance = camera.position.distanceTo(label.position);
    const s = clamp(distance / 15, 0.55, 2.6);
    const base = label.userData.baseScale;
    label.scale.set(base.x * s, base.y * s, 1);
  });
}

/** Everything the 3D scene does on the normal site, outside the film. */
function renderSiteFrame(scrolled, timeSeconds, dt) {
  if (!normalEnvironmentApplied) applyThemeEnvironment();

  const shot = siteTrackAt(scrolled);
  if (!shot) return;
  // The extra lift grows as the camera arrives at Tank 2, and is gone by the film.
  const demoRecord = sectionsById.demo;
  const filmRecord = sectionsById.film;
  let demoLift = 0;
  if (demoRecord && filmRecord) {
    demoLift = smoothstep(scrolled, demoRecord.startY, demoRecord.startY + demoRecord.scrollRange * 0.26) *
      (1 - smoothstep(scrolled, demoRecord.startY + demoRecord.scrollRange, filmRecord.startY));
  }
  applyViewOffset(1, demoLift);
  pointCamera(shot.cam, shot.look);

  // A very slight bob, like a hovering drone.
  const bob = Math.sin(timeSeconds * 1.5) * 0.05;
  drone.position.set(shot.drone[0], shot.drone[1] + bob, shot.drone[2]);
  drone.rotation.set(0, shot.yaw, 0);
  spinRotors(1, dt);

  updateLabelsForSite();
  updateTankLabelScale();
  updateWaterEffects(timeSeconds);
  updateEspForSite();
}

function updateEspForSite() {
  // In the "Inside the drone" close-ups a small glow keeps the board itself visible.
  showEspLight(0, simulator.tank2Leaking ? 1 : 0, activeSectionId === "inside" ? 0.14 : 0.5);
}

/**
 * The real looping drip when the simulator says Tank 2 is leaking. Otherwise,
 * during the demo section, a preview drop driven only by scrolling.
 * Scrolling never sends an alert.
 */
function updateWaterEffects(timeSeconds) {
  if (simulator.tank2Leaking) {
    const phase = (timeSeconds % 1.5) / 1.5;
    if (phase < 0.3) {
      showDrop(true, LEAK_POS[1], range(phase, 0, 0.3));
    } else if (phase < 0.56) {
      const fall = range(phase, 0.3, 0.56);
      showDrop(true, lerp(LEAK_POS[1], SOIL_Y, fall * fall), 1);
    } else {
      showDrop(false);
    }
    const spread = range(phase, 0.56, 1);
    showRipple(lerp(0.2, 1, spread), phase >= 0.56 ? 0.85 * (1 - spread) : 0, 0);
    return;
  }

  const demo = sectionsById.demo;
  const scrolled = window.pageYOffset;
  const demoOnScreen = demo && scrolled >= demo.startY && scrolled <= demo.startY + demo.scrollRange;
  if (demoOnScreen) {
    const p = demo.progress;
    if (p >= 0.36 && p < 0.52) {
      if (p < 0.44) {
        showDrop(true, LEAK_POS[1], range(p, 0.36, 0.44));
      } else {
        const fall = range(p, 0.44, 0.52);
        showDrop(true, lerp(LEAK_POS[1], SOIL_Y, fall * fall), 1);
      }
    } else {
      showDrop(false);
    }
    const grow = range(p, 0.52, 0.6);
    showRipple(lerp(0.2, 1, grow), p >= 0.52 ? 0.85 * (1 - range(p, 0.6, 0.66)) : 0, 0);
    return;
  }

  showDrop(false);
  showRipple(1, 0, 0);
}

/** With reduced motion: no drip, no preview. A still drop sits below Tank 2 while leaking. */
function updateWaterEffectsReduced() {
  showDrop(simulator.tank2Leaking, 0.55, 1);
  showRipple(1, 0, 0);
}

/** With reduced motion the camera cuts to one fixed key for each section. */
function renderReducedFrame() {
  if (!normalEnvironmentApplied) applyThemeEnvironment();

  let keys = SITE_KEYS[activeSectionId];
  if (activeSectionId === "film") keys = SITE_KEYS["app-panel"];
  // The demo section's key is its second one, the view of Tank 2.
  const key = activeSectionId === "demo" ? DEMO_KEY : (keys ? keys[0] : SITE_KEYS.hero[0]);

  applyViewOffset(1, activeSectionId === "demo" ? 1 : 0);
  pointCamera(key.cam, key.look);
  drone.position.set(key.drone[0], key.drone[1], key.drone[2]);
  drone.rotation.set(0, key.yaw, 0);
  spinRotors(0, 0);
  updateLabelsForSite();
  updateTankLabelScale();
  updateWaterEffectsReduced();
  updateEspForSite();
}

/* =====================================================================
   8. FILM TIMELINE, renderFilm(p)
   p is the scroll progress through the film, from 0 to 1. Everything the
   story shows is worked out from p alone, with no memory of earlier frames,
   so scrolling back plays the film exactly in reverse. The only things that
   use the clock are cosmetic: the spinning rotors and a tiny handheld drift.
   ===================================================================== */

/**
 * Makes a smooth path through keys of the form [time, [values...]].
 * It is a Catmull-Rom curve with time on the keys: the speed through a key is
 * the average of the speed on each side, so nothing stops and starts by accident.
 * Two keys in a row with the same value make a true hold.
 */
function makeTrack(keys) {
  const times = keys.map(function (k) { return k[0]; });
  const values = keys.map(function (k) { return k[1]; });
  const size = values[0].length;

  const slopes = values.map(function (v, i) {
    const slope = [];
    for (let c = 0; c < size; c += 1) {
      const flat = i === 0 || i === values.length - 1 ||
        values[i - 1][c] === v[c] || values[i + 1][c] === v[c];
      slope.push(flat ? 0 : (values[i + 1][c] - values[i - 1][c]) / (times[i + 1] - times[i - 1]));
    }
    return slope;
  });

  return function at(p) {
    if (p <= times[0]) return values[0].slice();
    const last = times.length - 1;
    if (p >= times[last]) return values[last].slice();
    let i = 0;
    while (p > times[i + 1]) i += 1;
    const dt = times[i + 1] - times[i];
    const s = (p - times[i]) / dt;
    const s2 = s * s;
    const s3 = s2 * s;
    const out = [];
    for (let c = 0; c < size; c += 1) {
      out.push(
        (2 * s3 - 3 * s2 + 1) * values[i][c] +
        (s3 - 2 * s2 + s) * dt * slopes[i][c] +
        (-2 * s3 + 3 * s2) * values[i + 1][c] +
        (s3 - s2) * dt * slopes[i + 1][c]
      );
    }
    return out;
  };
}

/* ----- The drone's path ----- */

const filmDronePath = makeTrack([
  [0.04, PAD_POS],
  [0.15, PAD_POS],             // On the pad until the takeoff.
  [0.19, [1.0, 1.15, 5.05]],   // Rises almost straight up, with a little forward drift.
  [0.25, [0.85, 4.7, 5.35]],
  [0.30, [0.4, 8.0, 5.85]],
  [0.35, [-0.6, 10.0, 6.2]],   // Top of the climb, above the campus.
  [0.385, [-5.2, 9.4, 5.0]],   // Flies west along the front of the school.
  [0.42, [-12.0, 8.4, 3.6]],
  [0.445, [-16.4, 7.6, 5.2]],  // Turns around towards the road.
  [0.47, [-14.6, 6.9, 8.9]],
  [0.525, [-1.5, 5.8, 7.6]],   // Back east, above the road side.
  [0.60, HOVER_POS],           // Arrives above Tank 2 and holds.
  [0.92, HOVER_POS],
  [0.96, FINAL_DRONE],         // Rises a little for the wide shot.
  [1.0, FINAL_DRONE]
]);

// Which way the drone faces. 0 is +z, and positive turns towards +x.
const filmDroneYaw = makeTrack([
  [0.04, [1.0]],
  [0.2, [1.0]],
  [0.3, [0.1]],
  [0.355, [-1.25]],
  [0.385, [-1.85]],
  [0.42, [-1.72]],
  [0.445, [-0.65]],
  [0.47, [1.1]],
  [0.49, [1.6]],
  [0.525, [2.0]],
  [0.565, [2.55]],
  [0.60, [FINAL_YAW]],
  [1.0, [FINAL_YAW]]
]);

/** The drone at moment p. Bank comes from how sharply the path is curving there. */
function filmDroneAt(p) {
  // During the first moments the drone flies from the demo's hover to its pad.
  const blend = smoothstep(p, 0, 0.04);
  const pos = mix3(DEMO_KEY.drone, filmDronePath(p), blend);
  const yaw = lerp(DEMO_KEY.yaw, filmDroneYaw(p)[0], blend);

  let bank = 0;
  let pitch = 0;
  const flying = smoothstep(p, 0.355, 0.385) * (1 - smoothstep(p, 0.565, 0.6));
  if (flying > 0) {
    const step = 0.005;
    const before = filmDronePath(p - step);
    const here = filmDronePath(p);
    const after = filmDronePath(p + step);
    const ax = here[0] - before[0];
    const az = here[2] - before[2];
    const bx = after[0] - here[0];
    const bz = after[2] - here[2];
    let turn = Math.atan2(bx, bz) - Math.atan2(ax, az);
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    const distance = Math.sqrt(ax * ax + az * az) + Math.sqrt(bx * bx + bz * bz);
    // A turn towards +x tips the drone that way. The limit is about 0.3 radians.
    bank = clamp(-(turn / Math.max(distance, 0.05)) * 1.15, -0.3, 0.3) * flying;
    pitch = clamp(distance / (2 * step) / 1400, 0, 0.2) * flying;
  }
  return { pos: pos, yaw: yaw, bank: bank, pitch: pitch };
}

/* ----- The camera's path ----- */

const filmCameraPath = makeTrack([
  [0.04, [7.4, 1.0, 8.7]],     // Low and wide across the grass, with the school behind.
  [0.15, [6.6, 0.95, 8.1]],
  [0.20, [6.9, 1.25, 8.6]],
  [0.25, [7.2, 2.7, 9.4]],     // Follows the rise, tilting up.
  [0.30, [7.9, 6.2, 11.2]],
  [0.35, [7.6, 11.8, 13.0]],   // Above the campus.
  [0.385, [2.6, 10.6, 8.6]],   // Chases from behind: school on one side, road on the other.
  [0.42, [-4.2, 9.4, 7.0]],
  [0.445, [-9.0, 8.8, 7.8]],
  [0.47, [-8.6, 8.3, 5.0]],    // The drone turns, and the camera swings to follow it.
  [0.50, [-5.5, 7.6, 3.6]],
  [0.525, [0.5, 6.8, 1.8]],
  [0.55, [9.0, 6.2, 2.6]],     // A wide arc around the drone, so the view does not whip past it.
  [0.575, [10.2, 4.2, 4.6]],   // Slips ahead of the drone, down to the garden.
  [0.60, [8.2, 1.1, 5.2]],     // Low, near Tank 2, with the drone at the top of the frame.
  [0.66, [8.2, 1.05, 5.3]],
  [0.71, [8.0, 1.05, 4.9]],    // Closest while the drop falls. The drone stays clear of the letterbox.
  [0.75, [8.15, 1.3, 5.0]],
  [0.79, [9.2, 3.0, 5.0]],     // Rises so the drone and the ring are both in frame.
  [0.86, [9.7, 3.5, 5.4]],
  [0.91, [7.15, 2.25, -0.35]], // Pushes in, looking down at the red ring.
  [0.95, [10.0, 11.0, 14.0]],  // Pulls back and up.
  [1.0, WIDE_CAM]
]);

const filmLookPath = makeTrack([
  [0.04, [-5.0, 2.6, 4.7]],    // The school is on the right, and the shadow crosses the grass to the left.
  [0.15, [-5.0, 2.55, 4.6]],
  [0.20, [-4.6, 2.7, 4.6]],
  [0.60, [6.4, 2.0, -2.7]],    // From 0.27 to 0.56 the camera mostly looks at the drone.
  [0.66, [6.35, 2.15, -2.7]],
  [0.71, [6.3, 2.12, -2.7]],
  [0.75, [6.3, 2.12, -2.7]],
  [0.79, [6.35, 2.0, -2.7]],
  [0.86, [6.35, 2.0, -2.7]],
  [0.91, [6.3, 0.1, -2.7]],
  [0.95, [2.0, 0.0, -3.0]],
  [1.0, WIDE_LOOK]
]);

// While following the drone, the camera aims a little to one side of it. This keeps
// the school on one side of the picture with the road in view on the other.
const filmAimOffset = makeTrack([
  [0.37, [0, 0, 0]],
  [0.39, [0, -0.6, 1.5]],
  [0.44, [0, -0.6, 1.5]],
  [0.47, [0, -0.5, 0.2]],
  [0.5, [0, -1.0, 0.4]],
  [0.525, [0, -1.0, 0.4]],
  [0.56, [0, 0, 0]]
]);

/** The camera at moment p, before the small handheld drift. */
function filmCameraAt(p, dronePos) {
  // How much the camera looks at the drone instead of the fixed target.
  const follow = smoothstep(p, 0.19, 0.27) * (1 - smoothstep(p, 0.555, 0.6));
  const fixedLook = filmLookPath(p);
  const aimOffset = filmAimOffset(p);
  const aim = [dronePos[0] + aimOffset[0], dronePos[1] + aimOffset[1], dronePos[2] + aimOffset[2]];
  const look = follow > 0 ? mix3(fixedLook, aim, follow) : fixedLook;
  const pos = filmCameraPath(p);

  // On entry, blend from the demo's camera, so the film starts with no jump.
  const entry = smoothstep(p, 0, 0.04);
  if (entry < 1) {
    return { pos: mix3(DEMO_KEY.cam, pos, entry), look: mix3(DEMO_KEY.look, look, entry) };
  }
  return { pos: pos, look: look };
}

/* ----- The mood over the length of the film ----- */

function filmEnvironmentAt(p) {
  const theme = THEME_ENVS[currentThemeName()];
  const stages = [
    [0, theme], [0.05, ENVS.dawn], [0.15, ENVS.dawn], [0.35, ENVS.morning],
    [0.6, ENVS.gold], [0.75, ENVS.gold], [0.92, ENVS.dusk], [0.97, ENVS.dusk], [1, theme]
  ];
  let i = 0;
  while (i < stages.length - 2 && p > stages[i + 1][0]) i += 1;
  const t = smoothstep(p, stages[i][0], stages[i + 1][0]);
  return blendEnv(stages[i][1], stages[i + 1][1], t, filmEnvScratch);
}

/* ----- The state of the story at moment p: pure numbers, no drawing ----- */

function computeFilmState(p) {
  const letterbox = smoothstep(p, 0, 0.06) * (1 - smoothstep(p, 0.94, 1));

  // The drop forms at the leak, falls with gravity, and is gone when it lands.
  const dropVisible = p >= 0.62 && p < 0.71;
  const fall = range(p, 0.67, 0.71);
  const dropY = lerp(LEAK_POS[1], SOIL_Y, fall * fall);
  const dropSize = smoothstep(p, 0.62, 0.67);

  // The ripple spreads, turns red with the alert, and fades as the wide shot opens.
  const spread = range(p, 0.71, 0.75);
  const rippleScale = lerp(0.2, 1, spread);
  let rippleOpacity = 0;
  if (p >= 0.71) rippleOpacity = lerp(0.95, 0.6, spread) * (1 - smoothstep(p, 0.97, 0.99));
  const rippleRed = smoothstep(p, 0.75, 0.78);

  // The ESP light: one blink during takeoff, then red from the moment of the alert.
  const espBlink = smoothstep(p, 0.26, 0.27) * (1 - smoothstep(p, 0.28, 0.29));
  const espRed = smoothstep(p, 0.75, 0.77);

  const lineProgress = easeInOut(range(p, 0.77, 0.86));
  const lineOpacity = p >= 0.77 ? 1 - smoothstep(p, 0.89, 0.92) : 0;
  const iconOpacity = smoothstep(p, 0.74, 0.77) * (1 - smoothstep(p, 0.93, 0.96));
  const iconReceived = p >= 0.86 && iconOpacity > 0;

  return {
    p: p,
    letterbox: letterbox,
    dropY: dropY,
    dropSize: dropSize,
    dropVisible: dropVisible,
    rippleScale: rippleScale,
    rippleOpacity: rippleOpacity,
    rippleRed: rippleRed,
    espRed: espRed,
    espBlink: espBlink,
    lineProgress: lineProgress,
    lineOpacity: lineOpacity,
    iconOpacity: iconOpacity,
    iconReceived: iconReceived,
    droneY: filmDroneAt(p).pos[1]
  };
}

let lastFilmState = computeFilmState(0);

/** Rotor speed from 0 to 1. Fast while flying in, stopped, idling from 0.1, full by 0.155. */
function filmRotorSpeed(p) {
  const arriving = 1 - range(p, 0.03, 0.05);
  const idle = lerp(0.25 * range(p, 0.1, 0.12), 1, range(p, 0.135, 0.155));
  return Math.max(arriving, idle);
}

/** A world point as pixels on the picture. */
const screenPoint = { x: 0, y: 0 };
let projectionVector = null;
function worldToScreen(pos, width, height) {
  if (!projectionVector) projectionVector = new THREE.Vector3();
  projectionVector.set(pos[0], pos[1], pos[2]).project(camera);
  screenPoint.x = (projectionVector.x * 0.5 + 0.5) * width;
  screenPoint.y = (-projectionVector.y * 0.5 + 0.5) * height;
  return screenPoint;
}

const filmDom = {};

/** Draws one small square of random noise, used as a repeating film grain. */
function makeGrainTile() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const picture = ctx.createImageData(size, size);
  for (let i = 0; i < picture.data.length; i += 4) {
    const shade = Math.random() < 0.5 ? 0 : 255;
    picture.data[i] = shade;
    picture.data[i + 1] = shade;
    picture.data[i + 2] = shade;
    picture.data[i + 3] = Math.random() * 110;
  }
  ctx.putImageData(picture, 0, 0);
  return canvas.toDataURL("image/png");
}

function collectFilmDom() {
  filmDom.section = byId("film");
  filmDom.icon = byId("film-app-icon");
  filmDom.glow = byId("film-line-glow");
  filmDom.core = byId("film-line-core");
  filmDom.head = byId("film-line-head");
  if (filmDom.section) {
    filmDom.vignette = filmDom.section.querySelector(".film-vignette");
    filmDom.grain = filmDom.section.querySelector(".film-grain");
    filmDom.bars = Array.from(filmDom.section.querySelectorAll(".letterbox"));
    if (filmDom.grain && IS_MOTION) filmDom.grain.style.backgroundImage = "url(" + makeGrainTile() + ")";
    filmDom.stage = filmDom.section.querySelector(".pin-stage");
    if (filmDom.grain) {
      const opacity = parseFloat(getComputedStyle(filmDom.grain).opacity);
      filmDom.grainOpacity = isNaN(opacity) ? 0.16 : opacity;
    }
  }
}

// The last value written to each overlay. Writing to the page every frame makes
// the browser redo its work, so we only write when something has changed.
const overlayWritten = {};

function setOpacityIfChanged(element, value) {
  const text = value.toFixed(3);
  if (overlayWritten[element.className] === text) return;
  overlayWritten[element.className] = text;
  element.style.opacity = text;
}

function setLineEnds(line, x1, y1, x2, y2, opacity) {
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("opacity", opacity);
}

/** The overlays on top of the picture: bars, phone icon, red line, grain and vignette. */
function updateFilmOverlays(state, dronePos) {
  if (!filmDom.section) return;
  const barPosition = state.letterbox.toFixed(4);
  if (overlayWritten.bars !== barPosition) {
    overlayWritten.bars = barPosition;
    filmDom.bars.forEach(function (bar) { bar.style.setProperty("--lb", barPosition); });
  }

  // The soft overlays fade in as the film starts, so they have no visible edge
  // while the stage scrolls into place.
  const overlays = range(state.p, 0, 0.03) * (1 - range(state.p, 0.97, 1));
  if (filmDom.vignette) setOpacityIfChanged(filmDom.vignette, overlays);
  if (filmDom.grain) setOpacityIfChanged(filmDom.grain, overlays * filmDom.grainOpacity);

  if (filmDom.icon) {
    if (overlayWritten.icon !== state.iconOpacity.toFixed(3)) {
      overlayWritten.icon = state.iconOpacity.toFixed(3);
      filmDom.icon.style.opacity = overlayWritten.icon;
    }
    if (overlayWritten.received !== state.iconReceived) {
      overlayWritten.received = state.iconReceived;
      filmDom.icon.classList.toggle("received", state.iconReceived);
    }
  }

  if (!filmDom.core || !filmDom.glow || !filmDom.head) return;
  if (state.lineOpacity <= 0 || state.lineProgress <= 0 || !filmDom.icon) {
    if (overlayWritten.line !== false) {
      overlayWritten.line = false;
      filmDom.core.setAttribute("opacity", 0);
      filmDom.glow.setAttribute("opacity", 0);
      filmDom.head.setAttribute("opacity", 0);
    }
    return;
  }
  overlayWritten.line = true;

  // The line starts at the drone's place on the screen, worked out fresh every frame.
  const start = worldToScreen(dronePos, viewW, viewH);
  // The icon never moves inside the stage, so it is measured once per layout.
  if (!filmDom.iconCentre) {
    const iconRect = filmDom.icon.getBoundingClientRect();
    const stageRect = filmDom.stage.getBoundingClientRect();
    filmDom.iconCentre = {
      x: iconRect.left + iconRect.width / 2 - stageRect.left,
      y: iconRect.top + iconRect.height / 2 - stageRect.top
    };
  }
  const tipX = lerp(start.x, filmDom.iconCentre.x, state.lineProgress);
  const tipY = lerp(start.y, filmDom.iconCentre.y, state.lineProgress);
  setLineEnds(filmDom.core, start.x, start.y, tipX, tipY, state.lineOpacity);
  setLineEnds(filmDom.glow, start.x, start.y, tipX, tipY, state.lineOpacity);
  filmDom.head.setAttribute("cx", tipX);
  filmDom.head.setAttribute("cy", tipY);
  filmDom.head.setAttribute("opacity", state.lineOpacity);
}

/**
 * Draws the film at moment p. Scroll decides everything in the story.
 * timeSeconds only adds the tiny handheld drift. When isStill is true there
 * is no drift, no shift of the picture and no change to the page overlays.
 */
function renderFilm(p, timeSeconds, isStill) {
  const state = computeFilmState(p);
  lastFilmState = state;
  if (!hasScene) return state;

  applyEnvironment(filmEnvironmentAt(p));
  normalEnvironmentApplied = false;

  // The picture shift used by the panels is gone within the first 3% of the
  // film, and comes back in the last 3%.
  const shift = isStill ? 0 : Math.max(1 - range(p, 0, 0.03), range(p, 0.97, 1));
  applyViewOffset(shift);

  const pose = filmDroneAt(p);
  const bobWeight = isStill ? 0 : Math.max(1 - range(p, 0, 0.04), range(p, 0.96, 1));
  const bob = Math.sin((timeSeconds || 0) * 1.5) * 0.05 * bobWeight;
  drone.position.set(pose.pos[0], pose.pos[1] + bob, pose.pos[2]);
  drone.rotation.set(pose.pitch, pose.yaw, pose.bank);

  // Handheld drift: slow sines, well under 2% of the distance to the subject.
  const shot = filmCameraAt(p, pose.pos);
  let driftX = 0;
  let driftY = 0;
  let driftZ = 0;
  if (!isStill) {
    const t = timeSeconds || 0;
    const dx = shot.pos[0] - shot.look[0];
    const dy = shot.pos[1] - shot.look[1];
    const dz = shot.pos[2] - shot.look[2];
    const amount = Math.sqrt(dx * dx + dy * dy + dz * dz) * lensPullback * 0.005 *
      range(p, 0, 0.03) * (1 - range(p, 0.97, 1));
    driftX = amount * (Math.sin(t * 0.43) + 0.5 * Math.sin(t * 0.97 + 1.3));
    driftY = amount * (Math.sin(t * 0.37 + 2.1) + 0.5 * Math.sin(t * 0.83));
    driftZ = amount * (Math.sin(t * 0.31 + 4.2) + 0.5 * Math.sin(t * 0.71 + 0.6));
  }
  // Tall phone screens need the camera further back, which makes the drone tiny.
  // So the camera moves closer during the story, and returns to the full distance
  // at both ends of the film so nothing jumps. On wide screens lensPullback is 1,
  // so this changes nothing there.
  const closer = range(p, 0, 0.04) * (1 - range(p, 0.91, 1));
  const pullback = lerp(lensPullback, 1 + (lensPullback - 1) * 0.35, closer);
  pointCamera(shot.pos, shot.look, driftX, driftY, driftZ, pullback);

  showDrop(state.dropVisible, state.dropY, state.dropSize);
  showRipple(state.rippleScale, state.rippleOpacity, state.rippleRed);
  showEspLight(state.espBlink, state.espRed);

  // No labels anywhere in the film.
  setTankLabelsVisible(false);
  drone.userData.espLabel.visible = false;
  drone.userData.cameraLabel.visible = false;

  if (!isStill) updateFilmOverlays(state, pose.pos);
  return state;
}

/* =====================================================================
   9. FILM STILLS FOR REDUCED MOTION
   Four frames, taken from the real scene, shown as a slideshow moved by hand.
   ===================================================================== */

const FILM_STILLS = [
  {
    p: 0.25,
    src: null,
    caption: "Dawn. The camera drone takes off from the grass and rises over the school.",
    alt: "The drone rising above the grass at dawn, with the school building behind it."
  },
  {
    p: 0.7,
    src: null,
    caption: "A single drop falls from the base of Tank 2, with the drone hovering above the tank.",
    alt: "A close view of Tank 2 by the garden. A water drop falls towards the soil, and the drone hovers overhead."
  },
  {
    p: 0.85,
    src: null,
    caption: "The light on the ESP board turns red. A red line carries the alert from the drone to a phone icon that stands for the app.",
    alt: "A red ring on the soil below the drone. A thin red line runs from the drone to a small phone icon at the side of the picture."
  },
  {
    p: 0.98,
    src: null,
    caption: "Sunset. The camera pulls back to a wide view of the campus.",
    alt: "A wide view from high above the school, the garden, the road and the trees at sunset."
  }
];

let stillIndex = 0;

function showStill(index) {
  stillIndex = (index + FILM_STILLS.length) % FILM_STILLS.length;
  const still = FILM_STILLS[stillIndex];
  const image = byId("film-still");
  const caption = byId("film-still-caption");
  const counter = byId("still-counter");
  if (image) {
    if (still.src) {
      image.src = still.src;
      image.alt = still.alt;
    } else {
      // Without a picture, the caption tells this part of the story.
      image.removeAttribute("src");
      image.alt = "";
    }
  }
  if (caption) caption.textContent = still.caption;
  if (counter) counter.textContent = "Frame " + (stillIndex + 1) + " of " + FILM_STILLS.length;
}

function wireStillButtons() {
  const previous = byId("still-prev");
  const next = byId("still-next");
  if (previous) previous.addEventListener("click", function () { showStill(stillIndex - 1); });
  if (next) next.addEventListener("click", function () { showStill(stillIndex + 1); });
  showStill(0);
}

/** Adds the bars, the red line and the phone icon to a still, on a 2D canvas. */
function drawStillOverlays(ctx, width, height, state, dronePos) {
  const barHeight = height * 0.11 * state.letterbox;
  if (barHeight > 0.5) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, barHeight);
    ctx.fillRect(0, height - barHeight, width, barHeight);
  }

  const iconSize = height * 0.1;
  const iconX = width - iconSize * 1.5;
  const iconY = height / 2 - iconSize / 2;

  if (state.iconOpacity > 0) {
    ctx.save();
    ctx.globalAlpha = state.iconOpacity;
    ctx.fillStyle = "rgba(6, 10, 19, 0.74)";
    ctx.fillRect(iconX, iconY, iconSize, iconSize);
    ctx.strokeStyle = "#eef3fa";
    ctx.lineWidth = 2;
    const phoneW = iconSize * 0.42;
    const phoneH = iconSize * 0.74;
    const phoneX = iconX + (iconSize - phoneW) / 2;
    const phoneY = iconY + (iconSize - phoneH) / 2;
    ctx.strokeRect(phoneX, phoneY, phoneW, phoneH);
    ctx.fillStyle = state.iconReceived ? "#d42020" : "rgba(238, 243, 250, 0.2)";
    ctx.fillRect(phoneX + 3, phoneY + 4, phoneW - 6, phoneH - 12);
    ctx.restore();
  }

  if (state.lineOpacity > 0 && state.lineProgress > 0) {
    const start = worldToScreen(dronePos, width, height);
    const startX = start.x;
    const startY = start.y;
    const tipX = lerp(startX, iconX + iconSize / 2, state.lineProgress);
    const tipY = lerp(startY, iconY + iconSize / 2, state.lineProgress);
    ctx.save();
    ctx.globalAlpha = state.lineOpacity;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(212, 32, 32, 0.5)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#d42020";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** Renders the four stills once, then puts the renderer back as it was. */
function makeFilmStills() {
  if (!hasScene) return;
  const width = 960;
  const height = 540;
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const ctx = output.getContext("2d");
  if (!ctx) return;

  try {
    applyViewOffset(0);
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    fitCameraLens();

    FILM_STILLS.forEach(function (still) {
      const state = renderFilm(still.p, 0, true);
      spinRotors(0, 0);
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, 0, 0, width, height);
      drawStillOverlays(ctx, width, height, state, filmDroneAt(still.p).pos);
      still.src = output.toDataURL("image/jpeg", 0.86);
    });
  } catch (err) {
    // The captions still tell the story without the pictures.
    FILM_STILLS.forEach(function (still) { still.src = null; });
  }

  resizeRenderer();
  normalEnvironmentApplied = false;
  showStill(stillIndex);
}

/* =====================================================================
   10. RENDER LOOP AND START-UP
   ===================================================================== */

let lastFrameSeconds = 0;
let filmWasOwningCamera = false;
let reducedFramePending = false;
let reducedNeedsDraw = true;
let reducedDrawnSection = null;

/** With reduced motion, the scene only draws when something has changed. */
function requestSceneRender() {
  reducedNeedsDraw = true;
  scheduleReducedCheck();
}

function scheduleReducedCheck() {
  if (!IS_REDUCED || reducedFramePending) return;
  reducedFramePending = true;
  requestAnimationFrame(function () {
    reducedFramePending = false;
    reducedFrame();
  });
}

function reducedFrame() {
  updateScrollState();
  if (!hasScene) return;
  // Scrolling inside one section changes nothing, so nothing is drawn.
  if (!reducedNeedsDraw && reducedDrawnSection === activeSectionId) return;
  reducedNeedsDraw = false;
  reducedDrawnSection = activeSectionId;
  renderReducedFrame();
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}

/* ----- Keeping the picture smooth -----
   The site starts at full quality. If frames stay slow, it draws fewer pixels and
   updates shadows less often. If even the lowest level is no faster, the slowness
   has another cause (for example a screen locked to 30 frames a second), so it goes
   back to full quality and stops changing anything. */
const MAX_PIXEL_RATIO = 1.5;
const SLOW_FRAME_MS = 19;     // Slower than this on average misses a 60 Hz screen too often.
const FRAMES_PER_CHECK = 45;
const QUALITY_LEVELS = [
  { scale: 1, shadowEvery: 3 },
  { scale: 0.85, shadowEvery: 4 },
  { scale: 0.7, shadowEvery: 6 }
];

let qualityLevel = 0;
let qualityLocked = false;
let frameNumber = 0;
let frameTimeTotal = 0;
let frameTimeCount = 0;
let framesToIgnore = 60;      // Start-up frames are slow on every computer.
let averageAtFullQuality = null;

function setQualityLevel(level) {
  qualityLevel = level;
  // The lowest level also leaves out the film grain.
  document.documentElement.classList.toggle("film-lite", level === QUALITY_LEVELS.length - 1);
  resizeRenderer();
  framesToIgnore = 10;        // Changing the drawing size causes one slow frame.
}

function watchFrameTime(frameMs) {
  // A very long gap means the tab was in the background, not that it is slow.
  if (frameMs > 250 || document.hidden) {
    frameTimeTotal = 0;
    frameTimeCount = 0;
    return;
  }
  if (framesToIgnore > 0) {
    framesToIgnore -= 1;
    return;
  }
  frameTimeTotal += frameMs;
  frameTimeCount += 1;
  if (frameTimeCount < FRAMES_PER_CHECK) return;

  const average = frameTimeTotal / frameTimeCount;
  frameTimeTotal = 0;
  frameTimeCount = 0;
  if (qualityLocked || average <= SLOW_FRAME_MS) return;

  if (qualityLevel === 0) averageAtFullQuality = average;
  if (qualityLevel < QUALITY_LEVELS.length - 1) {
    setQualityLevel(qualityLevel + 1);
  } else if (average > averageAtFullQuality * 0.9) {
    qualityLocked = true;
    setQualityLevel(0);
  }
}

// Scrolling arrives in steps, especially with a mouse wheel. The film follows the
// scroll position with a tiny delay so those steps do not show as jumps. It always
// lands exactly on the scroll position, so the film still plays the same both ways.
let filmShownP = 0;

function followScroll(shown, target, dt) {
  const next = shown + (target - shown) * (1 - Math.exp(-dt * 12));
  return Math.abs(target - next) < 0.0003 ? target : next;
}

/** The main loop with motion on. One animation frame drives everything. */
function motionFrame(nowMs) {
  requestAnimationFrame(motionFrame);

  const seconds = nowMs / 1000;
  watchFrameTime((seconds - lastFrameSeconds) * 1000);
  const dt = Math.min(0.05, Math.max(0, seconds - lastFrameSeconds));
  lastFrameSeconds = seconds;

  const scrolled = updateScrollState();
  const film = sectionsById.film;
  const filmOwnsCamera = hasScene && film &&
    scrolled >= film.startY && scrolled <= film.startY + film.scrollRange;

  if (filmOwnsCamera) {
    filmShownP = filmWasOwningCamera ? followScroll(filmShownP, film.progress, dt) : film.progress;
    renderFilm(filmShownP, seconds, false);
    spinRotors(filmRotorSpeed(filmShownP), dt);
  } else if (hasScene) {
    if (filmWasOwningCamera) {
      // Just left the film: settle the overlays and state on its first or last frame.
      renderFilm(film.progress, seconds, false);
    }
    renderSiteFrame(scrolled, seconds, dt);
  }
  filmWasOwningCamera = !!filmOwnsCamera;

  if (hasScene) {
    frameNumber += 1;
    if (frameNumber % QUALITY_LEVELS[qualityLevel].shadowEvery === 1) {
      renderer.shadowMap.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }
}

/** Turns the 3D part off and leaves everything else working. */
function fallBackWithoutWebgl() {
  hasScene = false;
  renderer = null;
  document.documentElement.classList.add("no-webgl");
  const canvas = byId("scene");
  if (canvas) canvas.style.display = "none";
  needsMeasure = true;
}

function startSite() {
  // These come first, so alerts and the feed work whatever happens to the 3D scene.
  wireSimulatorButtons();
  wireThemeToggle();
  if (IS_ONLINE_COPY) useOnlineCopyWording();
  refreshFeed();
  if (!IS_ONLINE_COPY) setInterval(refreshFeed, FEED_POLL_MS);
  wireRevealCards();
  wireStillButtons();
  collectSections();
  collectFilmDom();

  // If the reduced-motion setting changes, reload to apply it. Simple and reliable.
  onMediaChange(matchMedia("(prefers-reduced-motion: reduce)"), function () {
    location.reload();
  });

  // Build the scene inside a safety net. Any failure gives the plain page.
  try {
    hasScene = buildScene();
  } catch (err) {
    hasScene = false;
  }
  if (hasScene) {
    resizeRenderer();
    prepareAllGraphics();
  } else {
    fallBackWithoutWebgl();
  }

  measureSections();

  // Keep the measurements right when the page changes size.
  window.addEventListener("resize", function () {
    needsMeasure = true;
    if (hasScene) resizeRenderer();
    requestSceneRender();
  }, { passive: true });
  window.addEventListener("load", function () {
    needsMeasure = true;
    requestSceneRender();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      needsMeasure = true;
      requestSceneRender();
    });
  }
  if ("ResizeObserver" in window) {
    new ResizeObserver(function () {
      needsMeasure = true;
      requestSceneRender();
    }).observe(document.body);
  }

  if (IS_MOTION) {
    // Start with the film's overlays off, so nothing shows before the film begins.
    updateFilmOverlays(lastFilmState, PAD_POS);
    requestAnimationFrame(motionFrame);
  } else {
    window.addEventListener("scroll", scheduleReducedCheck, { passive: true });
    if (hasScene) makeFilmStills();
    updateScrollState();
    requestSceneRender();
  }
}

// For the automated tests only. The site itself does not use this.
window.siteDebug = {
  getFilmState: function () { return lastFilmState; },
  getPerf: function () {
    return {
      qualityLevel: qualityLevel,
      qualityLocked: qualityLocked,
      pixelRatio: renderer ? renderer.getPixelRatio() : null,
      drawCalls: renderer ? renderer.info.render.calls : null,
      triangles: renderer ? renderer.info.render.triangles : null
    };
  },
  getActiveSection: function () { return activeSectionId; }
};

startSite();
