/**
 * probe.js — Cineplex BD site reconnaissance script
 * Runs headless Chromium via Playwright, intercepts all API calls,
 * and saves screenshots + a full report at data/debug/report.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, 'data', 'debug');
const REPORT_PATH = path.join(DEBUG_DIR, 'report.json');

// Ensure debug dir exists
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ─── helpers ──────────────────────────────────────────────────────────────────

function truncate(str, n = 500) {
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > n ? str.slice(0, n) + '  …[truncated]' : str;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

async function screenshot(page, name) {
  const file = path.join(DEBUG_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log(`  📸  Screenshot saved → ${file}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const report = {
    loginPageText: '',
    loginPageButtons: [],
    urlAfterGuestLogin: '',
    apiCalls: [],          // { url, status, bodyPreview, keys }
    authTokens: {
      localStorage: {},
      cookies: [],
      responseHeaders: [],
    },
    errors: [],
  };

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // ── Intercept ALL responses from the ticket API ───────────────────────────
  const API_HOST = 'cineplex-ticket-api.cineplexbd.com';
  const intercepted = [];

  context.on('response', async (response) => {
    const url = response.url();
    if (!url.includes(API_HOST)) return;

    const status = response.status();
    let bodyPreview = '';
    let keys = [];

    try {
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('json')) {
        const json = await response.json();
        bodyPreview = truncate(JSON.stringify(json));
        keys = typeof json === 'object' && json !== null ? Object.keys(json) : [];
      } else {
        const text = await response.text();
        bodyPreview = truncate(text);
      }
    } catch (e) {
      bodyPreview = `(could not read body: ${e.message})`;
    }

    // Look for auth tokens in response body
    const tokenMatch = bodyPreview.match(/"(token|access_token|jwt|auth_token|authToken)":\s*"([^"]{10,})"/i);
    if (tokenMatch) {
      report.authTokens.responseHeaders.push({
        url,
        tokenKey: tokenMatch[1],
        tokenValue: tokenMatch[2].slice(0, 80) + '…',
      });
    }

    // Check response headers for auth info
    const authHeader = response.headers()['authorization'] || response.headers()['x-auth-token'] || '';
    if (authHeader) {
      report.authTokens.responseHeaders.push({ url, headerAuth: authHeader });
    }

    const entry = { url, status, bodyPreview, keys };
    intercepted.push(entry);
    log(`  🌐  API [${status}] ${url}`);
    log(`         keys: ${keys.join(', ') || '(none / non-object)'}`);
    log(`         body: ${truncate(bodyPreview, 200)}`);
  });

  const page = await context.newPage();

  // ── 1. Navigate to login page ─────────────────────────────────────────────
  log('Navigating to login page…');
  try {
    await page.goto('https://ticket.cineplexbd.com/login', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
  } catch (e) {
    log(`  ⚠️  networkidle timed-out, continuing anyway: ${e.message}`);
    report.errors.push(`goto networkidle: ${e.message}`);
  }
  await screenshot(page, '01-login-page');

  // ── 2. Grab all text content ──────────────────────────────────────────────
  log('Reading page text content…');
  const pageText = await page.evaluate(() => document.body.innerText);
  report.loginPageText = pageText;
  console.log('\n════ LOGIN PAGE TEXT ════\n' + pageText + '\n════════════════════════\n');

  // Grab all button / anchor labels
  const buttonLabels = await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('a'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('input[type="button"]'),
      ...document.querySelectorAll('input[type="submit"]'),
    ];
    return [...new Set(els.map(el => el.innerText?.trim() || el.value?.trim() || '').filter(Boolean))];
  });
  report.loginPageButtons = buttonLabels;
  log(`  Buttons/links found: ${buttonLabels.join(' | ')}`);

  // ── 3. Click "Guest Login" ────────────────────────────────────────────────
  log('Looking for Guest Login element…');

  // Try several strategies
  let guestLoginClicked = false;

  // Strategy A: role=button with matching text
  for (const label of ['Guest Login', 'Guest', 'Continue as Guest', 'Login as Guest', 'guest']) {
    try {
      const locator = page.getByRole('button', { name: new RegExp(label, 'i') });
      if (await locator.count() > 0) {
        log(`  ✅  Found button via role+name: "${label}"`);
        await locator.first().click();
        guestLoginClicked = true;
        break;
      }
    } catch (_) {}
  }

  // Strategy B: any element containing text
  if (!guestLoginClicked) {
    for (const label of ['Guest Login', 'Guest', 'Continue as Guest', 'Login as Guest']) {
      try {
        const locator = page.getByText(new RegExp(label, 'i'));
        if (await locator.count() > 0) {
          log(`  ✅  Found element via text: "${label}"`);
          await locator.first().click();
          guestLoginClicked = true;
          break;
        }
      } catch (_) {}
    }
  }

  // Strategy C: evaluate + click with innerText match
  if (!guestLoginClicked) {
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button, a, [role="button"], input[type="button"]');
      for (const el of all) {
        const t = (el.innerText || el.value || '').toLowerCase();
        if (t.includes('guest')) {
          el.click();
          return el.innerText || el.value || '(clicked)';
        }
      }
      return null;
    });
    if (clicked) {
      log(`  ✅  Clicked via evaluate: "${clicked}"`);
      guestLoginClicked = true;
    }
  }

  if (!guestLoginClicked) {
    log('  ❌  Could not find Guest Login button — logging all HTML anchors for inspection');
    const anchors = await page.evaluate(() =>
      [...document.querySelectorAll('a, button')].map(el => ({
        tag: el.tagName,
        href: el.href || '',
        text: el.innerText?.trim().slice(0, 80),
        id: el.id,
        class: el.className?.slice?.(0, 60),
      }))
    );
    console.log('All clickable elements:', JSON.stringify(anchors, null, 2));
    report.errors.push('Guest Login button not found');
  }

  // ── 4. Wait for navigation ────────────────────────────────────────────────
  log('Waiting for navigation after guest login click…');
  try {
    await page.waitForURL(url => url !== 'https://ticket.cineplexbd.com/login', {
      timeout: 15000,
    });
  } catch (e) {
    log(`  ⚠️  URL did not change within 15s: ${e.message}`);
    report.errors.push(`waitForURL: ${e.message}`);
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    log(`  ⚠️  networkidle after login: ${e.message}`);
  }

  report.urlAfterGuestLogin = page.url();
  log(`  📍  URL after guest login: ${report.urlAfterGuestLogin}`);
  await screenshot(page, '02-after-guest-login');

  // ── 5. Check localStorage & cookies for tokens ────────────────────────────
  log('Checking localStorage for auth tokens…');
  const ls = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      result[k] = localStorage.getItem(k);
    }
    return result;
  });
  report.authTokens.localStorage = ls;
  for (const [k, v] of Object.entries(ls)) {
    log(`  localStorage["${k}"] = ${String(v).slice(0, 120)}`);
  }

  const cookies = await context.cookies();
  report.authTokens.cookies = cookies.map(c => ({
    name: c.name,
    value: c.value.slice(0, 120),
    domain: c.domain,
    path: c.path,
  }));
  log(`  Cookies (${cookies.length}): ${cookies.map(c => c.name).join(', ')}`);

  // ── 6. Navigate to movie list page ───────────────────────────────────────
  log('Looking for movie list on current page…');
  await screenshot(page, '03-movie-list');

  const currentText = await page.evaluate(() => document.body.innerText);
  log('  Page text (first 800 chars):');
  console.log(currentText.slice(0, 800));

  // Try to find and click a movie card / link
  log('Attempting to click first available movie…');

  // Common selectors for movie cards in SPA booking sites
  const movieSelectors = [
    'a[href*="movie"]',
    'a[href*="film"]',
    'a[href*="show"]',
    '.movie-card',
    '.movie-item',
    '.film-card',
    '[class*="movie"]',
    '[class*="film"]',
    '[class*="show-card"]',
    '[class*="NowShowing"]',
    '[class*="now-showing"]',
    'article',
    '.card',
  ];

  let movieClicked = false;
  for (const sel of movieSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        log(`  ✅  Found ${count} element(s) matching "${sel}", clicking first…`);
        await page.locator(sel).first().click({ timeout: 5000 });
        movieClicked = true;
        break;
      }
    } catch (e) {
      // try next
    }
  }

  if (!movieClicked) {
    log('  ❌  Could not find a movie card — dumping all links for inspection');
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a')].map(a => ({
        href: a.href,
        text: a.innerText?.trim().slice(0, 60),
      })).filter(x => x.href)
    );
    console.log('All links:', JSON.stringify(links.slice(0, 30), null, 2));
    report.errors.push('Movie card not found');
  } else {
    // Wait for the booking/date-selection page to appear
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 });
    } catch (e) {
      log(`  ⚠️  networkidle after movie click: ${e.message}`);
    }
    await screenshot(page, '04-movie-page');

    log('  Waiting for date selection UI…');
    const dateSelectors = [
      '[class*="date"]',
      '[class*="Date"]',
      '[class*="schedule"]',
      '[class*="showtime"]',
      '[class*="calendar"]',
      'input[type="date"]',
    ];
    for (const sel of dateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        log(`  ✅  Date selection UI found: "${sel}"`);
        break;
      } catch (_) {}
    }

    await screenshot(page, '05-date-selection');
    const moviePageText = await page.evaluate(() => document.body.innerText);
    log('  Movie page text (first 800 chars):');
    console.log(moviePageText.slice(0, 800));
  }

  // ── 7. Give a moment for any in-flight requests to complete ───────────────
  log('Waiting 3 s for any remaining API responses…');
  await page.waitForTimeout(3000);

  // ── 8. Finalise report ───────────────────────────────────────────────────
  report.apiCalls = intercepted;

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`\n📄  Full report written → ${REPORT_PATH}`);

  // ── 9. Console summary ────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════');
  console.log('                  PROBE SUMMARY');
  console.log('══════════════════════════════════════════════');
  console.log(`Login page buttons : ${report.loginPageButtons.join(' | ')}`);
  console.log(`URL after login    : ${report.urlAfterGuestLogin}`);
  console.log(`API calls captured : ${report.apiCalls.length}`);
  report.apiCalls.forEach((c, i) => {
    console.log(`\n  [${i + 1}] ${c.url}`);
    console.log(`       status : ${c.status}`);
    console.log(`       keys   : ${c.keys.join(', ') || '—'}`);
    console.log(`       body   : ${truncate(c.bodyPreview, 300)}`);
  });
  if (report.authTokens.responseHeaders.length) {
    console.log('\n  🔑  Auth tokens found in responses:');
    report.authTokens.responseHeaders.forEach(t => console.log('    ', JSON.stringify(t)));
  }
  if (Object.keys(report.authTokens.localStorage).length) {
    console.log('\n  🗝️  localStorage:');
    for (const [k, v] of Object.entries(report.authTokens.localStorage)) {
      console.log(`    ${k} = ${String(v).slice(0, 160)}`);
    }
  }
  if (report.authTokens.cookies.length) {
    console.log('\n  🍪  Cookies:');
    report.authTokens.cookies.forEach(c =>
      console.log(`    ${c.name} (${c.domain}) = ${c.value.slice(0, 80)}`)
    );
  }
  if (report.errors.length) {
    console.log('\n  ⚠️  Errors / warnings:');
    report.errors.forEach(e => console.log(`    - ${e}`));
  }
  console.log('\n══════════════════════════════════════════════\n');

  await browser.close();
  log('Done.');
})();
