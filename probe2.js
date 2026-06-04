/**
 * probe2.js — Deep API reconnaissance for cineplex-ticket-api.cineplexbd.com
 *
 * Phase 0 : Playwright sniffs the exact request the SPA makes (method, headers,
 *            body) for guest-login AND every subsequent call through to movie
 *            detail.  We capture the device-key + appsource + token here.
 * Phase 1 : Direct HTTPS calls (POST) with the harvested credentials to map
 *            every known endpoint.
 */

const https = require("https");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "https://cineplex-ticket-api.cineplexbd.com";
const DEBUG_DIR = path.join(__dirname, "data", "debug");
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ─── helpers ──────────────────────────────────────────────────────────────────

function truncate(s, n = 800) {
  if (typeof s !== "string") s = JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + "\n  …[truncated]" : s;
}
function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function post(urlStr, { headers = {}, body = {} } = {}) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const rawBody = JSON.stringify(body);
    const hdrs = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      ...headers,
    };
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: hdrs,
    };
    const t0 = Date.now();

    const req = https.request(opts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch (_) {}
        resolve({ status: res.statusCode, raw, json, ms: Date.now() - t0 });
      });
    });
    req.on("error", (e) =>
      resolve({
        status: 0,
        error: e.message,
        raw: "",
        json: null,
        ms: Date.now() - t0,
      }),
    );
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, error: "timeout", raw: "", json: null, ms: 15000 });
    });
    req.write(rawBody);
    req.end();
  });
}

function printResult(label, url, res) {
  const appOk = res.json?.code === 200;
  const m = appOk
    ? "✅"
    : res.status === 200
      ? "⚠️ "
      : res.status === 0
        ? "💥"
        : "❌";
  console.log(`\n${m}  ${label}`);
  console.log(`   URL    : ${url}`);
  console.log(
    `   Status : HTTP ${res.status}  app-code: ${res.json?.code ?? "?"}  (${res.ms} ms)`,
  );
  if (res.error) {
    console.log(`   Error  : ${res.error}`);
    return;
  }
  if (!res.json) {
    console.log(`   Body   : ${truncate(res.raw)}`);
    return;
  }

  const keys = Object.keys(res.json);
  console.log(`   Keys   : ${keys.join(", ")}`);
  if (res.json.data) {
    if (Array.isArray(res.json.data)) {
      console.log(`   data[] : ${res.json.data.length} items`);
      if (res.json.data.length > 0) {
        const d0 = res.json.data[0];
        console.log(`   data[0] keys : ${Object.keys(d0 || {}).join(", ")}`);
        console.log(
          `   data[0]      :\n${truncate(JSON.stringify(d0, null, 2), 600)}`,
        );
      }
    } else {
      console.log(`   data keys : ${Object.keys(res.json.data).join(", ")}`);
      console.log(
        `   data      :\n${truncate(JSON.stringify(res.json.data, null, 2), 600)}`,
      );
    }
  }
  if (res.json.message)
    console.log(`   message: ${JSON.stringify(res.json.message)}`);
}

// ─── PHASE 0 — Full SPA capture ───────────────────────────────────────────────

async function runBrowserCapture() {
  log("PHASE 0 — Launching browser…");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const allCalls = []; // {type, method, url, reqHeaders, reqBody, status, resBody}
  let guestLoginReq = null;
  let guestLoginRes = null;

  context.on("request", (req) => {
    const url = req.url();
    if (!url.includes("cineplex-ticket-api")) return;
    let postData = null;
    try {
      postData = req.postData();
    } catch (_) {}
    const entry = {
      type: "req",
      method: req.method(),
      url,
      headers: req.headers(),
      body: postData,
    };
    allCalls.push(entry);
    log(`  → [${req.method()}] ${url}`);
    if (postData) log(`       body: ${String(postData).slice(0, 120)}`);
    if (url.includes("guest-login")) guestLoginReq = entry;
  });

  context.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("cineplex-ticket-api")) return;
    let body = null;
    try {
      const ct = res.headers()["content-type"] || "";
      body = ct.includes("json") ? await res.json() : await res.text();
    } catch (_) {}
    const entry = { type: "res", url, status: res.status(), body };
    allCalls.push(entry);
    log(`  ← [${res.status()}] ${url}`);
    if (url.includes("guest-login") && body?.data?.token) {
      guestLoginRes = body;
      log(`       token: ${body.data.token.slice(0, 60)}`);
    }
    if (body && typeof body === "object") {
      const preview = truncate(JSON.stringify(body), 300);
      log(`       body : ${preview}`);
    }
  });

  const page = await context.newPage();

  // ── Step 1: Login ──────────────────────────────────────────
  log("  Navigating to login…");
  try {
    await page.goto("https://ticket.cineplexbd.com/login", {
      waitUntil: "networkidle",
      timeout: 25000,
    });
  } catch (_) {}
  await page
    .getByRole("button", { name: /guest login/i })
    .first()
    .click()
    .catch((e) => log(`  ⚠️  ${e.message}`));
  await page.waitForURL(/\/home/, { timeout: 12000 }).catch(() => {});
  await page
    .waitForLoadState("networkidle", { timeout: 10000 })
    .catch(() => {});
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p2-01-home.png"),
    fullPage: true,
  });
  log(`  URL: ${page.url()}`);
  const homeText = await page.evaluate(() => document.body.innerText);
  console.log("\n  Home page text (first 1500 chars):");
  console.log(homeText.slice(0, 1500));

  // ── Step 2: Click the first cinema location ────────────────
  log("\n  Clicking first cinema location…");
  const locationClicked = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href]");
    for (const a of links) {
      const txt = (a.innerText || "").toLowerCase();
      if (
        txt.includes("shopping") ||
        txt.includes("mall") ||
        txt.includes("cineplex") ||
        txt.includes("square") ||
        txt.includes("tower")
      ) {
        a.click();
        return a.innerText.trim().slice(0, 80);
      }
    }
    return null;
  });
  if (locationClicked) {
    log(`  Clicked location: "${locationClicked}"`);
  } else {
    // fallback: click the first .card-like element
    const cardSels = [
      '[class*="card" i]',
      '[class*="location" i]',
      '[class*="cinema" i]',
      "a",
    ];
    for (const sel of cardSels) {
      const cnt = await page
        .locator(sel)
        .count()
        .catch(() => 0);
      if (cnt > 0) {
        await page
          .locator(sel)
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
        break;
      }
    }
  }
  await page.waitForTimeout(4000);
  await page
    .waitForLoadState("networkidle", { timeout: 10000 })
    .catch(() => {});
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p2-02-after-location.png"),
    fullPage: true,
  });
  log(`  URL: ${page.url()}`);
  const afterLocText = await page.evaluate(() => document.body.innerText);
  console.log("\n  After location click (first 1500 chars):");
  console.log(afterLocText.slice(0, 1500));

  // ── Step 3: Click the first movie ─────────────────────────
  log("\n  Looking for movies to click…");
  await page.waitForTimeout(2000);
  const movieCardSels = [
    'a[href*="movie"]',
    'a[href*="film"]',
    'a[href*="show"]',
    '[class*="movie" i]',
    '[class*="film" i]',
    '[class*="poster" i]',
    '[class*="card" i]',
    "article",
  ];
  let movieClicked = false;
  for (const sel of movieCardSels) {
    const cnt = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (cnt > 0) {
      log(`  Clicking first of ${cnt} × "${sel}"…`);
      await page
        .locator(sel)
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      movieClicked = true;
      break;
    }
  }

  if (movieClicked) {
    await page.waitForTimeout(6000);
    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});
    await page.screenshot({
      path: path.join(DEBUG_DIR, "p2-03-movie.png"),
      fullPage: true,
    });
    log(`  URL: ${page.url()}`);
    const movieText = await page.evaluate(() => document.body.innerText);
    console.log("\n  After movie click (first 1500 chars):");
    console.log(movieText.slice(0, 1500));

    // ── Step 4: Click the first date ──────────────────────────
    log("\n  Looking for date/showtime to click…");
    const dateSels = [
      '[class*="date" i]',
      '[class*="Date" i]',
      '[class*="calendar" i]',
      '[class*="schedule" i]',
      '[class*="showtime" i]',
      'input[type="date"]',
      "button",
      '[role="button"]',
    ];
    for (const sel of dateSels) {
      const cnt = await page
        .locator(sel)
        .count()
        .catch(() => 0);
      if (cnt > 0) {
        log(`  Clicking first of ${cnt} × "${sel}"…`);
        await page
          .locator(sel)
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
        await page.waitForTimeout(4000);
        break;
      }
    }
    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});
    await page.screenshot({
      path: path.join(DEBUG_DIR, "p2-04-schedule.png"),
      fullPage: true,
    });
    log(`  URL after date click: ${page.url()}`);
    const schedText = await page.evaluate(() => document.body.innerText);
    console.log("\n  After date/showtime click (first 1500 chars):");
    console.log(schedText.slice(0, 1500));
  }

  // Give more time for straggling responses
  await page.waitForTimeout(3000);
  await browser.close();

  return { guestLoginReq, guestLoginRes, allCalls };
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const report = {};

  // ══════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════");
  console.log("  PHASE 0  —  Full SPA Capture");
  console.log("══════════════════════════════════════════════════");

  const { guestLoginReq, guestLoginRes, allCalls } = await runBrowserCapture();

  // ── Print ALL captured API calls ──────────────────────────
  console.log("\n\n══ ALL CAPTURED SPA API CALLS ═══════════════════");
  allCalls.forEach((c, i) => {
    if (c.type === "req") {
      console.log(`\n  [${i}] ▶  ${c.method}  ${c.url}`);
      const h = c.headers || {};
      const relevantHeaders = [
        "appsource",
        "device-key",
        "authorization",
        "content-type",
      ];
      for (const k of relevantHeaders) {
        if (h[k]) console.log(`       ${k}: ${h[k]}`);
      }
      if (c.body) console.log(`       body: ${String(c.body).slice(0, 300)}`);
    } else {
      const bodyStr = c.body
        ? typeof c.body === "string"
          ? c.body
          : JSON.stringify(c.body)
        : "";
      console.log(`  [${i}] ◀  ${c.status}  ${c.url}`);
      if (bodyStr) console.log(`       ${truncate(bodyStr, 400)}`);
    }
  });

  // Extract credentials
  const TOKEN = guestLoginRes?.data?.token;
  const DEVICE_KEY = guestLoginReq?.headers?.["device-key"] ?? "";
  const APPSOURCE = guestLoginReq?.headers?.["appsource"] ?? "web";

  log(`\n🔑  TOKEN      : ${TOKEN}`);
  log(`    DEVICE_KEY : ${DEVICE_KEY}`);
  log(`    APPSOURCE  : ${APPSOURCE}`);

  if (!TOKEN) {
    console.error("\n🚨  No token — exiting.");
    process.exit(0);
  }

  // ── Standard headers for all direct API calls ─────────────
  const H = {
    appsource: APPSOURCE,
    "device-key": DEVICE_KEY,
    authorization: `Bearer ${TOKEN}`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    origin: "https://ticket.cineplexbd.com",
    referer: "https://ticket.cineplexbd.com/",
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
  };

  const probeResults = {};
  async function probe(label, url, body = {}) {
    const res = await post(url, { headers: H, body });
    probeResults[url] = { status: res.status, appCode: res.json?.code };
    printResult(label, url, res);
    return res;
  }

  // ══════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════");
  console.log("  PHASE 1-B  —  Locations");
  console.log("══════════════════════════════════════════════════");

  const locRes = await probe("get-location", `${BASE}/api/v1/get-location`);
  const locations = locRes.json?.data ?? [];
  if (locations.length) {
    console.log("\n  📍  All cinema locations:");
    for (const loc of locations) {
      console.log(
        `    id=${loc.id}  code=${loc.code}  screens=${loc.totalScreen}  district=${loc.district}`,
      );
      console.log(`         "${loc.locationTitle}"`);
      console.log(`         ${loc.address}`);
    }
  }
  report.locations = locations;
  const firstLocId = locations[0]?.id ?? 1;

  // ══════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════");
  console.log("  PHASE 1-C  —  Movie List Endpoints (POST)");
  console.log("══════════════════════════════════════════════════");

  // The SPA picks a location first — try with location_id
  const movieBodies = [
    {},
    { location_id: firstLocId },
    { locationId: firstLocId },
    { loc_id: firstLocId },
    { cinema_id: firstLocId },
  ];
  const movieEndpoints = [
    "movie-list",
    "get-movies",
    "now-showing",
    "get-now-showing",
    "movies",
    "get-movie",
    "film-list",
    "get-film",
    "films",
    "get-film-list",
    "show-list",
    "get-shows",
    "cinema-movies",
    "location-movies",
    "get-location-movies",
  ];

  let firstMovieId = null;
  let firstMovieSlug = null;
  let firstDateStr = null;

  for (const ep of movieEndpoints) {
    const url = `${BASE}/api/v1/${ep}`;
    // Try each body variant
    for (const body of movieBodies) {
      const res = await probe(`${ep} body=${JSON.stringify(body)}`, url, body);
      if (res.json?.code === 200 && res.json?.data && firstMovieId === null) {
        const arr = Array.isArray(res.json.data)
          ? res.json.data
          : (res.json.data.movies ?? res.json.data.data ?? []);
        if (Array.isArray(arr) && arr.length > 0) {
          const m = arr[0];
          firstMovieId = m.id ?? m.movie_id ?? m.movieId ?? null;
          firstMovieSlug = m.slug ?? m.movie_slug ?? m.movieSlug ?? null;
          report.movies = arr;
          console.log(
            `\n  🎬  First movie: id=${firstMovieId}  slug="${firstMovieSlug}"`,
          );
          arr.forEach((mv, i) => {
            const title =
              mv.title ??
              mv.name ??
              mv.movieTitle ??
              mv.movie_title ??
              "(no title)";
            const slug = mv.slug ?? mv.movie_slug ?? mv.movieSlug ?? "—";
            const id = mv.id ?? mv.movie_id ?? mv.movieId ?? "?";
            console.log(
              `    [${i}] id=${id}  slug="${slug}"  title="${title}"`,
            );
          });
        }
        break;
      }
      if (res.json?.code === 200) break; // working endpoint, stop trying bodies
    }
  }

  // ══════════════════════════════════════════════════════════
  const movieId = firstMovieId ?? 1;
  const movieSlug = firstMovieSlug ?? String(movieId);

  console.log("\n══════════════════════════════════════════════════");
  console.log(
    `  PHASE 1-D  —  Per-Movie Endpoints  id=${movieId}  slug="${movieSlug}"`,
  );
  console.log("══════════════════════════════════════════════════");

  const movieBodiesBase = [
    { movie_id: movieId },
    { movieId: movieId },
    { id: movieId },
    { movie_slug: movieSlug },
    { slug: movieSlug },
    { movie_id: movieId, location_id: firstLocId },
  ];
  const movieDetailEps = [
    "movie-detail",
    "get-movie-detail",
    "movie-info",
    "get-movie-info",
    "show-dates",
    "get-show-dates",
    "movie-dates",
    "get-movie-dates",
    "movie-schedule",
    "get-movie-schedule",
    "shows",
    "get-shows",
    "schedule",
    "get-schedule",
    "show-times",
    "get-show-times",
    "showtimes",
    `movies/${movieId}`,
    `movies/${movieSlug}`,
    `movies/${movieId}/show-dates`,
    `movies/${movieId}/shows`,
    `movies/${movieId}/schedule`,
    `movies/${movieId}/dates`,
  ];

  for (const ep of movieDetailEps) {
    const url = `${BASE}/api/v1/${ep}`;
    for (const body of movieBodiesBase) {
      const res = await probe(`${ep}`, url, body);
      if (res.json?.code === 200) break;
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════");
  console.log("  PHASE 1-E  —  Extra / Utility Endpoints");
  console.log("══════════════════════════════════════════════════");

  const extraEndpoints = [
    ["get-banner", {}],
    ["profile", {}],
    ["user", {}],
    ["get-district", {}],
    ["get-cinema", {}],
    ["screens", { location_id: firstLocId }],
    ["get-screens", { location_id: firstLocId }],
    ["seats", { show_id: 1 }],
    ["get-seats", { show_id: 1 }],
    ["get-upcoming", {}],
    ["upcoming", {}],
    ["upcoming-movies", {}],
  ];
  for (const [ep, body] of extraEndpoints) {
    await probe(ep, `${BASE}/api/v1/${ep}`, body);
  }

  // ══════════════════════════════════════════════════════════
  // SAVE + SUMMARY
  // ══════════════════════════════════════════════════════════
  report.probeResults = probeResults;
  report.credentials = {
    token: TOKEN,
    deviceKey: DEVICE_KEY,
    appsource: APPSOURCE,
  };
  fs.writeFileSync(
    path.join(DEBUG_DIR, "report2.json"),
    JSON.stringify(report, null, 2),
  );

  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("                    PROBE 2  SUMMARY");
  console.log("══════════════════════════════════════════════════════");

  const ok = Object.entries(probeResults).filter(([, v]) => v.appCode === 200);
  const bad = Object.entries(probeResults).filter(([, v]) => v.appCode !== 200);

  console.log(`\n  ✅  app-code 200 endpoints (${ok.length}):`);
  ok.forEach(([url]) => console.log(`    POST  ${url}`));

  console.log(`\n  ❌  Non-200 endpoints (${bad.length}):`);
  bad.forEach(([url, v]) => console.log(`    [${v.appCode}]  ${url}`));

  console.log("\n  🔑  Credentials:");
  console.log(`    token      : ${TOKEN}`);
  console.log(`    device-key : ${DEVICE_KEY}`);
  console.log(`    appsource  : ${APPSOURCE}`);

  console.log("\n  📄  Full JSON → data/debug/report2.json");
  console.log("  📸  Screenshots → data/debug/p2-*.png");
  console.log("══════════════════════════════════════════════════════\n");
  log("Done.");
})();
