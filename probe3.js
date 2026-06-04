/**
 * probe3.js — Find the seat layout / availability endpoint.
 *
 * Phase A : Playwright guest-login → capture fresh Bearer token.
 * Phase B : HTTP chain  get-location → get-showdate → get-shows → harvest programId.
 * Phase C : Brute-force every plausible seat endpoint (POST + GET variants).
 * Phase D : Full Playwright walkthrough to seat-selection page — intercept
 *            every API call for 8 s after clicking a showtime.
 */

"use strict";

const https = require("https");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "https://cineplex-ticket-api.cineplexbd.com";
const DK = "5e98df37da990542174d3849f031a58c0d89ae08a2156aed1133a236a0ccb778";
const DEBUG_DIR = path.join(__dirname, "data", "debug");
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ─── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}
function pp(s, n = 700) {
  if (typeof s !== "string") s = JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + "\n  …[truncated]" : s;
}
function sep(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

// Low-level HTTP helper — POST or GET, returns { httpStatus, appCode, data, json, raw }
function http(url, { method = "POST", token = "", body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const rawBody = body !== null ? JSON.stringify(body) : null;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://ticket.cineplexbd.com",
      referer: "https://ticket.cineplexbd.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      appsource: "web",
      "device-key": DK,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rawBody
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(rawBody)),
          }
        : {}),
    };
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    };
    const t0 = Date.now();
    const req = https.request(opts, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(d);
        } catch (_) {}
        resolve({
          httpStatus: res.statusCode,
          appCode: json?.code,
          data: json?.data,
          json,
          raw: d,
          ms: Date.now() - t0,
        });
      });
    });
    req.on("error", (e) =>
      resolve({
        httpStatus: 0,
        appCode: 0,
        data: null,
        json: null,
        raw: e.message,
        ms: Date.now() - t0,
      }),
    );
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({
        httpStatus: 0,
        appCode: 0,
        data: null,
        json: null,
        raw: "timeout",
        ms: 15000,
      });
    });
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function post(ep, body, token) {
  return http(`${BASE}/api/v1/${ep}`, { method: "POST", token, body });
}
function get(ep, token) {
  return http(`${BASE}/api/v1/${ep}`, { method: "GET", token });
}

function printResult(label, res) {
  const ok = res.appCode === 200;
  const icon = ok
    ? "✅"
    : res.httpStatus === 200
      ? "⚠️ "
      : res.httpStatus === 0
        ? "💥"
        : "❌";
  console.log(`${icon}  ${label}`);
  console.log(
    `     HTTP ${res.httpStatus}  app-code: ${res.appCode ?? "?"}  (${res.ms} ms)`,
  );
  if (ok && res.data !== null) {
    if (Array.isArray(res.data)) {
      console.log(`     data[]: ${res.data.length} items`);
      if (res.data.length > 0) {
        console.log(
          `     data[0] keys : ${Object.keys(res.data[0] || {}).join(", ")}`,
        );
        console.log(
          `     data[0] :\n${pp(JSON.stringify(res.data[0], null, 2), 800)}`,
        );
      }
    } else if (typeof res.data === "object") {
      console.log(`     data keys: ${Object.keys(res.data).join(", ")}`);
      console.log(`     data:\n${pp(JSON.stringify(res.data, null, 2), 800)}`);
    }
  } else if (!ok) {
    console.log(
      `     message: ${JSON.stringify(res.json?.message ?? res.raw?.slice(0, 120))}`,
    );
  }
}

// ─── PHASE A: Get fresh token via Playwright ───────────────────────────────

async function getFreshToken() {
  log("PHASE A — Getting fresh Bearer token via Playwright guest-login…");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  let token = null;
  const tokenP = new Promise((resolve) => {
    ctx.on("response", async (res) => {
      if (!res.url().includes("guest-login")) return;
      try {
        const j = await res.json();
        if (j?.data?.token) resolve(j.data.token);
      } catch (_) {}
    });
  });

  const page = await ctx.newPage();
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
    .catch(() => {});

  token = await Promise.race([
    tokenP,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("token timeout 12s")), 12000),
    ),
  ]).catch((e) => {
    log(`  ⚠️  ${e.message}`);
    return null;
  });

  await browser.close();
  if (!token) throw new Error("Could not obtain Bearer token");
  log(`  ✅  Token: ${token}`);
  return token;
}

// ─── PHASE D: Full Playwright walkthrough to seat page ────────────────────

async function playwrightSeatWalkthrough() {
  sep("PHASE D — Playwright: full booking flow → seat selection page");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const apiCalls = []; // every API req/res pair
  let freshToken = null;

  ctx.on("request", (req) => {
    if (!req.url().includes("cineplex-ticket-api")) return;
    let body = null;
    try {
      body = req.postData();
    } catch (_) {}
    const entry = {
      dir: ">",
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      body,
      ts: Date.now(),
    };
    apiCalls.push(entry);
    const ep = req.url().replace(`${BASE}/api/v1/`, "");
    log(
      `  ▶  ${req.method().padEnd(4)} /${ep}${body ? "  body=" + String(body).slice(0, 80) : ""}`,
    );
  });

  ctx.on("response", async (res) => {
    if (!res.url().includes("cineplex-ticket-api")) return;
    let body = null;
    try {
      const ct = res.headers()["content-type"] || "";
      body = ct.includes("json") ? await res.json() : await res.text();
    } catch (_) {}
    const entry = {
      dir: "<",
      status: res.status(),
      url: res.url(),
      body,
      ts: Date.now(),
    };
    apiCalls.push(entry);
    const ep = res.url().replace(`${BASE}/api/v1/`, "");
    log(`  ◀  ${res.status()}  /${ep}`);
    if (body && typeof body === "object") {
      log(
        `       appCode=${body.code}  keys=${Object.keys(body).join(",")}${body.data ? "  data=" + pp(JSON.stringify(body.data), 250) : ""}`,
      );
    }
    if (res.url().includes("guest-login") && body?.data?.token)
      freshToken = body.data.token;
  });

  const page = await ctx.newPage();

  // ── Step 1: Login ──────────────────────────────────────────
  log("\n  [Step 1] Guest Login");
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
    .catch(() => {});
  await page.waitForURL(/\/home/, { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p3d-01-home.png"),
    fullPage: true,
  });
  log(`  URL: ${page.url()}`);

  // ── Step 2: Click Bashundhara (loc 1) ─────────────────────
  log("\n  [Step 2] Click cinema — Bashundhara");
  await page
    .locator("a")
    .filter({ hasText: /Bashundhara/i })
    .first()
    .click({ timeout: 5000 })
    .catch((e) => log(`  ⚠️  ${e.message}`));
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p3d-02-cinema.png"),
    fullPage: true,
  });

  const postCinemaText = await page.evaluate(() => document.body.innerText);
  log(
    `  Page after cinema click (excerpt): ${postCinemaText.slice(0, 300).replace(/\n+/g, " ")}`,
  );

  // ── Step 3: Click first available date tab ─────────────────
  log("\n  [Step 3] Click first date tab");
  // The date tabs are <div class="show_date"> elements visible after cinema selection
  const dateTabSels = [
    "div.show_date",
    '[class*="show_date"]',
    '[class*="showDate"]',
    '[class*="date-tab"]',
    '[class*="dateTab"]',
    "div.day-box",
    '[class*="day-box"]',
    '[class*="dayBox"]',
    '[class*="cal"]',
  ];
  let dateClicked = false;
  for (const sel of dateTabSels) {
    const cnt = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (cnt > 0) {
      log(`  Clicking first date via "${sel}" (${cnt} found)`);
      await page
        .locator(sel)
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
      dateClicked = true;
      await page.waitForTimeout(2000);
      break;
    }
  }
  if (!dateClicked) {
    // Try the datepicker input directly
    const inp = page
      .locator('#datePicker, input[id*="date"], input[class*="calend"]')
      .first();
    if ((await inp.count().catch(() => 0)) > 0) {
      log("  Clicking datePicker input");
      await inp.click({ timeout: 3000 }).catch(() => {});
      dateClicked = true;
      await page.waitForTimeout(2000);
    }
  }
  log(`  Date clicked: ${dateClicked}`);
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p3d-03-date.png"),
    fullPage: true,
  });

  // ── Step 4: Click first movie in the list ─────────────────
  log("\n  [Step 4] Click first movie");
  // Movies appear as list items with class containing "movie-name", "movieItem", etc.
  const movieSels = [
    '[class*="movie-name"]',
    '[class*="movieName"]',
    '[class*="movie_name"]',
    '[class*="movie-title"]',
    '[class*="movieTitle"]',
    '[class*="movie-item"]',
    '[class*="movieItem"]',
    '[class*="movie-card"]',
    '[class*="movieCard"]',
    '[class*="film-card"]',
    // Fallback: any element containing the movie title text
  ];
  let movieClicked = false;
  for (const sel of movieSels) {
    const cnt = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (cnt > 0) {
      log(`  Clicking first movie via "${sel}" (${cnt} found)`);
      await page
        .locator(sel)
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      movieClicked = true;
      await page.waitForTimeout(3000);
      break;
    }
  }
  if (!movieClicked) {
    // Try getting the movie list from the page and clicking the first one
    const movieTitle = await page.evaluate(() => {
      const header = document.querySelector(
        '[class*="movie-list-header"],[class*="movieListHeader"],[class*="select-movie"],[class*="selectMovie"]',
      );
      const siblings = header?.parentElement?.querySelectorAll(
        'a, [class*="item"], li',
      );
      if (siblings && siblings.length > 0) {
        siblings[0].click();
        return siblings[0].innerText.trim().slice(0, 60);
      }
      // Broad fallback: any <li> that has text inside the movie section
      const liEls = document.querySelectorAll("li");
      for (const li of liEls) {
        const t = li.innerText.trim();
        if (
          t &&
          t.length > 2 &&
          t.length < 80 &&
          !/^\d+$/.test(t) &&
          !/location|show date|hall|seat|ticket|amount|purchase/i.test(t)
        ) {
          li.click();
          return t;
        }
      }
      return null;
    });
    if (movieTitle) {
      log(`  Clicked movie via evaluate: "${movieTitle}"`);
      movieClicked = true;
      await page.waitForTimeout(3000);
    }
  }
  log(`  Movie clicked: ${movieClicked}`);
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p3d-04-movie.png"),
    fullPage: true,
  });

  const postMovieText = await page.evaluate(() => document.body.innerText);
  log(
    `  Page after movie click: ${postMovieText.slice(0, 400).replace(/\n+/g, " ")}`,
  );

  // ── Step 5: Click first show time ─────────────────────────
  log("\n  [Step 5] Click first showtime");
  const timeSels = [
    '[class*="show-time"]',
    '[class*="showTime"]',
    '[class*="show_time"]',
    '[class*="time-box"]',
    '[class*="timeBox"]',
    '[class*="time-btn"]',
    '[class*="timeBtn"]',
    '[class*="schedule"]',
    '[class*="screening"]',
  ];
  let timeClicked = false;
  for (const sel of timeSels) {
    const cnt = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (cnt > 0) {
      log(`  Clicking first showtime via "${sel}" (${cnt} found)`);
      await page
        .locator(sel)
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      timeClicked = true;
      await page.waitForTimeout(1000);
      break;
    }
  }
  if (!timeClicked) {
    // Try any button-like element containing a time pattern (e.g. "2:15 PM", "14:15")
    const timeClicked2 = await page.evaluate(() => {
      const pattern = /\d{1,2}:\d{2}\s*(AM|PM)?/i;
      const candidates = [
        ...document.querySelectorAll("a, button, li, div, span"),
      ];
      for (const el of candidates) {
        const t = (el.innerText || "").trim();
        if (pattern.test(t) && t.length < 20) {
          el.click();
          return t;
        }
      }
      return null;
    });
    if (timeClicked2) {
      log(`  Clicked time via evaluate: "${timeClicked2}"`);
      timeClicked = true;
    }
  }
  log(`  Showtime clicked: ${timeClicked}`);

  // ── Wait 8 seconds for all seat-related API calls to fire ──
  log("\n  [Step 6] Waiting 8 s for seat layout API call…");
  await page.waitForTimeout(8000);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.screenshot({
    path: path.join(DEBUG_DIR, "p3d-05-seat-page.png"),
    fullPage: true,
  });
  log(`  URL after showtime click: ${page.url()}`);

  const seatPageText = await page.evaluate(() => document.body.innerText);
  console.log("\n  Seat page text (first 1200 chars):");
  console.log(seatPageText.slice(0, 1200));

  // Save the full seat page HTML for inspection
  const seatHTML = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync(path.join(DEBUG_DIR, "seat-page.html"), seatHTML);
  log(`  Saved seat-page.html (${seatHTML.length} chars)`);

  // ── Step 7: Try to navigate directly to seat selection URL ──
  log("\n  [Step 7] Try direct SPA seat-selection routes");
  const spaRoutes = [
    "/seat-selection",
    "/seat",
    "/seats",
    "/booking",
    "/buy",
    "/checkout",
  ];
  for (const route of spaRoutes) {
    const url = `https://ticket.cineplexbd.com${route}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 8000 });
    } catch (_) {}
    const routeText = await page.evaluate(() => document.body.innerText);
    if (/seat|row|screen|hall|A1|A2|B1/i.test(routeText)) {
      log(`  ✅  Seat content found at ${route}`);
      console.log(routeText.slice(0, 600));
      await page.screenshot({
        path: path.join(
          DEBUG_DIR,
          `p3d-06-route-${route.replace(/\//g, "")}.png`,
        ),
        fullPage: true,
      });
      break;
    }
  }

  await page.waitForTimeout(2000);
  await browser.close();
  return { apiCalls, freshToken };
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const report = {};

  // ══ PHASE A: Token ════════════════════════════════════════
  sep("PHASE A — Fresh token via Playwright");
  const TOKEN = await getFreshToken();
  report.token = TOKEN;

  // ══ PHASE B: Get programId chain ════════════════════════
  sep("PHASE B — Chain: get-location → get-showdate → get-shows → programId");

  // B1: locations
  log("B1: get-location");
  const locRes = await post("get-location", {}, TOKEN);
  printResult("/api/v1/get-location", locRes);
  const locations = Array.isArray(locRes.data) ? locRes.data : [];
  const firstLoc = locations[0];
  log(`  First location: id=${firstLoc?.id}  "${firstLoc?.locationTitle}"`);

  // B2: showdates for BSC
  log("\nB2: get-showdate (location=1)");
  const sdRes = await post("get-showdate", { location: 1 }, TOKEN);
  printResult("/api/v1/get-showdate", sdRes);
  const showdates = Array.isArray(sdRes.data) ? sdRes.data : [];
  const firstDate = showdates[0]?.showDate;
  const firstMovies = showdates[0]?.availableMovies ?? [];
  log(`  First show date: ${firstDate}  (${firstMovies.length} movies)`);
  firstMovies.forEach((m, i) =>
    log(`    [${i}] movie_id=${m.movie_id}  "${m.movie_title}"`),
  );

  // B3: shows for first movie on first date
  const firstMovieId = firstMovies[0]?.movie_id;
  log(
    `\nB3: get-shows (location=1, movieId=${firstMovieId}, showDate=${firstDate})`,
  );
  const showsRes = await post(
    "get-shows",
    { location: 1, movieId: firstMovieId, showDate: firstDate },
    TOKEN,
  );
  printResult("/api/v1/get-shows", showsRes);
  const screens = Array.isArray(showsRes.data) ? showsRes.data : [];
  const programIds = [];
  screens.forEach((screen) => {
    log(
      `  Screen: id=${screen.screenID}  "${screen.screenTitle}"  type="${screen.screenTypeName}"`,
    );
    (screen.showTimes || []).forEach((st) => {
      log(
        `    showTime=${st.showTime}  programId=${st.programId}  profileId=${st.profileId}`,
      );
      log(`    seatPrices: ${JSON.stringify(st.seatPrices)}`);
      programIds.push({
        programId: st.programId,
        profileId: st.profileId,
        showTime: st.showTime,
        screenTitle: screen.screenTitle,
      });
    });
  });
  const PROGRAM_ID = programIds[0]?.programId;
  const PROFILE_ID = programIds[0]?.profileId;
  log(`\n  🎯  PROGRAM_ID = ${PROGRAM_ID}  PROFILE_ID = ${PROFILE_ID}`);
  report.programId = PROGRAM_ID;
  report.profileId = PROFILE_ID;
  report.programIds = programIds;

  if (!PROGRAM_ID) {
    log(
      "⚠️  No programId found — will still run Phase C with id=128421 as fallback",
    );
  }
  const PID = PROGRAM_ID ?? 128421;
  const PFID = PROFILE_ID ?? 5;

  // ══ PHASE C: Brute-force seat endpoints ════════════════════
  sep(`PHASE C — Seat endpoint brute-force  (programId=${PID})`);

  // All body variants to try
  const bodyVariants = [
    { programId: PID },
    { program_id: PID },
    { programId: PID, profileId: PFID },
    { program_id: PID, profile_id: PFID },
    { programId: PID, location: 1 },
    { programId: PID, location_id: 1 },
    { showId: PID },
    { show_id: PID },
    { id: PID },
  ];

  // POST endpoints to try
  const postEndpoints = [
    "get-seat",
    "get-seats",
    "seat",
    "seats",
    "seat-layout",
    "get-seat-layout",
    "seat-map",
    "get-seat-map",
    "seat-plan",
    "get-seat-plan",
    "get-seat-availability",
    "seat-availability",
    "seat-status",
    "get-seat-status",
    "get-booking-seat",
    "booking-seat",
    "show-seat",
    "get-show-seat",
    "show-seats",
    "get-show-seats",
    "program-seat",
    "get-program-seat",
    "get-hall-seat",
    "hall-seat",
    "screen-seat",
    "get-screen-seat",
    "get-seat-by-program",
    "seat-by-program",
    "seat-grid",
    "get-seat-grid",
    "seat-chart",
    "seating",
    "get-seating",
    "seating-plan",
    "seating-chart",
    "seating-layout",
  ];

  // GET endpoints with query params
  const getEndpoints = [
    `get-seat?programId=${PID}`,
    `get-seat?program_id=${PID}`,
    `seat-layout?programId=${PID}`,
    `seat-map?programId=${PID}`,
    `seats?programId=${PID}`,
    `get-seats?programId=${PID}`,
    `seat?programId=${PID}`,
    `seat?program_id=${PID}`,
    `get-seat?showId=${PID}`,
    `get-seat?id=${PID}`,
  ];

  const seatResults = {};

  console.log("\n  ── POST variants ─────────────────────────────────────────");
  for (const ep of postEndpoints) {
    // Try each body variant, stop at first 200
    let found = false;
    for (const body of bodyVariants) {
      const res = await post(ep, body, TOKEN);
      if (res.appCode === 200) {
        const dl = Array.isArray(res.data)
          ? res.data.length
          : res.data
            ? JSON.stringify(res.data).length
            : 0;
        console.log(`\n  ✅  POST /api/v1/${ep}  body=${JSON.stringify(body)}`);
        console.log(
          `     HTTP ${res.httpStatus}  app-code: ${res.appCode}  (${res.ms} ms)`,
        );
        console.log(
          `     data: ${pp(JSON.stringify(res.data, null, 2), 1200)}`,
        );
        seatResults[`POST:${ep}`] = { body, data: res.data };
        found = true;
        break;
      }
    }
    if (!found) {
      // Just show the first non-200 result (with the simplest body) for diagnosis
      const res = await post(ep, { programId: PID }, TOKEN);
      console.log(
        `  ❌  POST /api/v1/${ep}  → app-code: ${res.appCode}  msg: ${JSON.stringify(res.json?.message ?? "").slice(0, 60)}`,
      );
    }
  }

  console.log("\n  ── GET variants ──────────────────────────────────────────");
  for (const ep of getEndpoints) {
    const res = await get(ep, TOKEN);
    if (res.appCode === 200) {
      console.log(`\n  ✅  GET /api/v1/${ep}`);
      console.log(`     data: ${pp(JSON.stringify(res.data, null, 2), 1200)}`);
      seatResults[`GET:${ep}`] = { data: res.data };
    } else {
      console.log(`  ❌  GET /api/v1/${ep}  → app-code: ${res.appCode}`);
    }
  }

  // ══ PHASE D: Playwright walkthrough ═══════════════════════
  const { apiCalls, freshToken } = await playwrightSeatWalkthrough();

  // ── Print the full ordered API call log ─────────────────
  sep("PHASE D — All API calls captured");
  apiCalls.forEach((c, i) => {
    if (c.dir === ">") {
      const ep = c.url.replace(`${BASE}/api/v1/`, "");
      console.log(`\n  [${i}] ▶  ${c.method}  /${ep}`);
      const rh = c.headers || {};
      if (rh["authorization"])
        console.log(`       auth: ${rh["authorization"].slice(0, 40)}…`);
      if (c.body) console.log(`       body: ${String(c.body).slice(0, 200)}`);
    } else {
      const ep = c.url.replace(`${BASE}/api/v1/`, "");
      console.log(`  [${i}] ◀  ${c.status}  /${ep}`);
      if (c.body && typeof c.body === "object") {
        console.log(`       appCode=${c.body.code}`);
        if (c.body.data)
          console.log(`       data: ${pp(JSON.stringify(c.body.data), 600)}`);
      }
    }
  });

  // ── Highlight any new endpoints seen in Phase D ──────────
  const phaseD_eps = [
    ...new Set(
      apiCalls
        .filter((c) => c.dir === ">")
        .map((c) => c.url.replace(`${BASE}/api/v1/`, "")),
    ),
  ];
  console.log("\n  Phase D endpoints hit:", phaseD_eps);

  // ── Check if any Phase D response has seat-like data ─────
  const seatLike = apiCalls.filter((c) => {
    if (c.dir !== "<" || !c.body) return false;
    const s = JSON.stringify(c.body);
    return (
      /seat|row|column|hall|screen|avail|sold|reserved|block/i.test(s) &&
      c.body.code === 200
    );
  });
  if (seatLike.length > 0) {
    sep("🎯  SEAT-LIKE API RESPONSES (Phase D)");
    seatLike.forEach((c) => {
      const ep = c.url.replace(`${BASE}/api/v1/`, "");
      console.log(`\n  URL: /${ep}`);
      console.log(`  Response:\n${pp(JSON.stringify(c.body, null, 2), 2000)}`);
    });
  } else {
    log("  ⚠️  No seat-like response found in Phase D API calls");
  }

  // ── Save full report ─────────────────────────────────────
  report.phaseC = seatResults;
  report.phaseD = {
    apiCalls: apiCalls.map((c) => ({
      dir: c.dir,
      ...(c.dir === ">"
        ? { method: c.method, url: c.url, body: c.body }
        : { status: c.status, url: c.url, body: c.body }),
    })),
    seatLikeEndpoints: seatLike.map((c) => ({ url: c.url, body: c.body })),
  };
  fs.writeFileSync(
    path.join(DEBUG_DIR, "report3.json"),
    JSON.stringify(report, null, 2),
  );

  sep("SUMMARY");
  console.log(`  Token       : ${TOKEN}`);
  console.log(`  programId   : ${PID}  profileId: ${PFID}`);
  console.log(
    `  Phase C hits: ${Object.keys(seatResults).length > 0 ? Object.keys(seatResults).join(", ") : "(none)"}`,
  );
  console.log(
    `  Phase D calls: ${apiCalls.length}  seat-like: ${seatLike.length}`,
  );
  console.log("\n  📄  Full report → data/debug/report3.json");
  console.log("  📸  Screenshots → data/debug/p3d-*.png");
  log("Done.");
})();
