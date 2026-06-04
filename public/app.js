/**
 * app.js — Cineplex Tracker frontend
 * Vanilla JS, no build step required.
 */

/* ─── State ──────────────────────────────────────────────────── */
const state = {
  movies: [], // [{ id, title, poster, category, genre }]
  selectedMovie: null, // { id, title }
  selectedDate: null, // "YYYY-MM-DD"
  currentStats: null,
  currentSnapshotId: null,
  currentLocationShows: [], // shows for the currently expanded location
  charts: {},
};

/* ─── DOM shorthand ──────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

/* ─── Init ───────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  loadMovies();

  $("btnHistory").addEventListener("click", toggleHistory);
  $("btnCloseHistory").addEventListener("click", () => {
    $("historySection").hidden = true;
  });
  $("btnRefresh").addEventListener("click", onRefresh);
  $("btnExport").addEventListener("click", exportCSV);
  $("branchSearch").addEventListener("input", () => {
    if (state.currentStats) {
      renderBranchTable(state.currentStats.branches, $("branchSearch").value);
    }
  });
  $("btnCloseShows").addEventListener("click", () => {
    $("showCard").hidden = true;
  });
  $("catModalClose").addEventListener("click", () => {
    $("catModal").hidden = true;
  });
  $("catModal").addEventListener("click", (e) => {
    if (e.target === $("catModal")) $("catModal").hidden = true;
  });
});

/* ─── Utilities ──────────────────────────────────────────────── */
function fmt(n) {
  return Number(n).toLocaleString("en-BD");
}

function fmtBDT(n) {
  return "৳" + Number(n).toLocaleString("en-BD", { maximumFractionDigits: 0 });
}

function occClass(pct) {
  const p = parseFloat(pct);
  if (p >= 90) return "occ-full";
  if (p >= 70) return "occ-high";
  if (p >= 40) return "occ-mid";
  return "occ-low";
}

function occBadge(pct) {
  return `<span class="occ-badge ${occClass(pct)}">${pct}%</span>`;
}

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shorten a long location name for chart labels.
 * e.g. "Bashundhara Shopping Mall, Panthapath" → "Bashundhara"
 *      "Star Cineplex, Shyamoli"               → "Shyamoli"
 */
function shortLocName(name) {
  if (!name) return "";
  let s = name
    .replace(/Star Cineplex,?\s*/i, "")
    .replace(/Blockbuster Cinemas,?\s*/i, "")
    .trim();
  s = s.split(",")[0].trim();
  if (s.length > 14) s = s.split(" ")[0];
  return s;
}

/**
 * Format "YYYY-MM-DD" → "Wed, 4 Jun"
 * Parsed as local date to avoid UTC offset issues.
 */
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/* ─── API helper ─────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

/* ─── Status bar ─────────────────────────────────────────────── */
function showStatus(msg, type = "") {
  const el = $("statusBar");
  el.innerHTML =
    type === "loading" ? `<span class="spinner"></span> ${esc(msg)}` : esc(msg);
  el.className = `status-bar ${type}`;
  el.hidden = false;
}

function hideStatus() {
  $("statusBar").hidden = true;
}

/* ═══════════════════════════════════════════════════════════════
   STEP 1 — Load & display movies
   ═══════════════════════════════════════════════════════════════ */

async function loadMovies() {
  $("movieLoading").hidden = false;
  $("movieGrid").hidden = true;

  try {
    const r = await api("GET", "/api/movies");
    if (r.success && r.movies && r.movies.length) {
      state.movies = r.movies;
      renderMovies(r.movies);
    } else {
      $("movieLoading").hidden = true;
      $("movieGrid").innerHTML =
        '<p class="text-muted" style="padding:8px 0">No movies currently showing. Try again later.</p>';
      $("movieGrid").hidden = false;
    }
  } catch (e) {
    $("movieLoading").hidden = true;
    $("movieGrid").innerHTML =
      `<p class="text-muted" style="padding:8px 0">Could not load movies: ${esc(e.message)}</p>`;
    $("movieGrid").hidden = false;
  }
}

function renderMovies(movies) {
  $("movieLoading").hidden = true;
  const grid = $("movieGrid");

  grid.innerHTML = movies
    .map((m) => {
      const initial = (m.title || "?").charAt(0).toUpperCase();
      const imgHtml = m.poster
        ? `<img src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy"
             class="movie-poster-img" data-initial="${esc(initial)}">`
        : `<div class="movie-placeholder">${esc(initial)}</div>`;

      return `
      <div class="movie-card" data-movie-id="${esc(m.id)}" data-movie-title="${esc(m.title)}">
        ${imgHtml}
        <div class="movie-card-title">${esc(m.title)}</div>
      </div>`;
    })
    .join("");

  grid.hidden = false;

  // Replace broken poster images with initial placeholder
  grid.querySelectorAll(".movie-poster-img").forEach((img) => {
    img.addEventListener("error", function () {
      const placeholder = document.createElement("div");
      placeholder.className = "movie-placeholder";
      placeholder.textContent = this.dataset.initial || "?";
      this.parentNode.replaceChild(placeholder, this);
    });
  });

  grid.querySelectorAll(".movie-card").forEach((card) => {
    card.addEventListener("click", () => onMovieClick(card));
  });
}

function onMovieClick(card) {
  // Deselect all, select clicked
  document
    .querySelectorAll(".movie-card")
    .forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");

  state.selectedMovie = {
    id: card.dataset.movieId,
    title: card.dataset.movieTitle,
  };

  // Reset any prior date state
  state.selectedDate = null;
  $("dateChips").innerHTML = "";
  $("analyzeProgress").hidden = true;
  hideStatus();

  // Show step 2 and load dates
  $("step2").hidden = false;
  loadDates(state.selectedMovie.id);
}

/* ═══════════════════════════════════════════════════════════════
   STEP 2 — Load & display dates
   ═══════════════════════════════════════════════════════════════ */

async function loadDates(movieId) {
  $("dateLoading").hidden = false;
  $("dateChips").innerHTML = "";

  try {
    const r = await api(
      "GET",
      `/api/dates?movieId=${encodeURIComponent(movieId)}`,
    );
    $("dateLoading").hidden = true;

    if (r.success && r.dates && r.dates.length) {
      renderDateChips(r.dates);
    } else {
      $("dateChips").innerHTML =
        '<p class="text-muted" style="font-size:.88rem">No available dates found for this movie.</p>';
    }
  } catch (e) {
    $("dateLoading").hidden = true;
    $("dateChips").innerHTML =
      `<p class="text-muted" style="font-size:.88rem">Error loading dates: ${esc(e.message)}</p>`;
  }
}

function renderDateChips(dates) {
  const chips = $("dateChips");
  chips.innerHTML = dates
    .map(
      (d) => `
    <button class="date-chip" data-date="${esc(d)}">${esc(formatDate(d))}</button>
  `,
    )
    .join("");

  chips.querySelectorAll(".date-chip").forEach((chip) => {
    chip.addEventListener("click", () => onDateClick(chip));
  });
}

function onDateClick(chip) {
  document
    .querySelectorAll(".date-chip")
    .forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected");

  const date = chip.dataset.date;
  state.selectedDate = date;

  hideStatus();
  $("analyzeProgress").hidden = false;
  $("analyzeMsg").textContent =
    "Fetching all shows and seat data from all locations… (~20-30 seconds)";

  runAnalyze(state.selectedMovie.id, state.selectedMovie.title, date);
}

/* ═══════════════════════════════════════════════════════════════
   ANALYZE — POST /api/analyze
   ═══════════════════════════════════════════════════════════════ */

async function runAnalyze(movieId, movieTitle, showDate) {
  try {
    const r = await api("POST", "/api/analyze", {
      movieId,
      movieTitle,
      showDate,
    });
    $("analyzeProgress").hidden = true;

    if (r.success) {
      state.currentSnapshotId = r.snapshotId;
      renderDashboard(r.stats);
    } else {
      showStatus("Analysis failed: " + (r.error || "Unknown error"), "error");
    }
  } catch (e) {
    $("analyzeProgress").hidden = true;
    showStatus("Network error: " + e.message, "error");
  }
}

/* ─── Refresh ────────────────────────────────────────────────── */
async function onRefresh() {
  if (!state.selectedMovie || !state.selectedDate) return;

  $("btnRefresh").disabled = true;
  $("analyzeProgress").hidden = false;
  $("analyzeMsg").textContent = "Refreshing seat data from all locations…";

  try {
    const r = await api("POST", "/api/analyze", {
      movieId: state.selectedMovie.id,
      movieTitle: state.selectedMovie.title,
      showDate: state.selectedDate,
    });
    $("analyzeProgress").hidden = true;

    if (r.success) {
      state.currentSnapshotId = r.snapshotId;
      renderDashboard(r.stats);
    } else {
      showStatus("Refresh failed: " + (r.error || "Unknown error"), "error");
    }
  } catch (e) {
    $("analyzeProgress").hidden = true;
    showStatus("Network error: " + e.message, "error");
  } finally {
    $("btnRefresh").disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════ */

function renderDashboard(stats) {
  state.currentStats = stats;
  state.currentSnapshotId = stats.snapshotId;

  const s = stats.summary;

  // Show section
  $("dashSection").hidden = false;
  $("dashTitle").textContent = stats.movieName;
  $("dashMeta").textContent =
    `Show Date: ${stats.showDate} · Scraped: ${stats.scrapedAt || "—"}`;

  // KPI cards
  $("kpiSold").textContent = fmt(s.totalSold);
  $("kpiAvail").textContent = fmt(s.totalAvailable);
  $("kpiCap").textContent = fmt(s.totalCapacity);
  $("kpiOcc").textContent = s.occupancy + "%";
  $("kpiRev").textContent = fmtBDT(s.totalRevenue);
  $("kpiShows").textContent = `${s.totalShows} / ${s.totalBranches}`;

  // Header action buttons
  $("btnRefresh").hidden = false;
  $("btnExport").hidden = false;

  renderCharts(stats.branches);
  renderBranchTable(stats.branches);
  $("showCard").hidden = true;
  $("branchSearch").value = "";

  $("dashSection").scrollIntoView({ behavior: "smooth" });
}

/* ─── Charts ─────────────────────────────────────────────────── */
function renderCharts(branches) {
  const labels = branches.map((b) => shortLocName(b.branchName));
  const occData = branches.map((b) => parseFloat(b.occupancy));
  const revData = branches.map((b) => b.totalRevenue);

  const COLORS = [
    "#e63946",
    "#4fc3f7",
    "#4ade80",
    "#a78bfa",
    "#fbbf24",
    "#2dd4bf",
    "#fb923c",
    "#f472b6",
    "#94a3b8",
    "#67e8f9",
  ];

  // Extend color array if more branches than colors
  const getColor = (i) => COLORS[i % COLORS.length];
  const bgColors = branches.map((_, i) => getColor(i) + "cc");
  const brdColors = branches.map((_, i) => getColor(i));

  // Destroy previous chart instances
  if (state.charts.occ) {
    state.charts.occ.destroy();
    delete state.charts.occ;
  }
  if (state.charts.rev) {
    state.charts.rev.destroy();
    delete state.charts.rev;
  }

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
  };

  // Occupancy — vertical bar
  state.charts.occ = new Chart($("chartOcc"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: occData,
          backgroundColor: bgColors,
          borderColor: brdColors,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      ...baseOptions,
      scales: {
        x: {
          ticks: { color: "#8896ae", font: { size: 11 } },
          grid: { color: "#2a3348" },
        },
        y: {
          min: 0,
          max: 100,
          ticks: { color: "#8896ae", callback: (v) => v + "%" },
          grid: { color: "#2a3348" },
        },
      },
      plugins: {
        ...baseOptions.plugins,
        tooltip: {
          callbacks: { label: (ctx) => ctx.parsed.y.toFixed(1) + "%" },
        },
      },
    },
  });

  // Revenue — horizontal bar
  state.charts.rev = new Chart($("chartRev"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: revData,
          backgroundColor: bgColors,
          borderColor: brdColors,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      ...baseOptions,
      indexAxis: "y",
      scales: {
        x: {
          ticks: {
            color: "#8896ae",
            callback: (v) =>
              "৳" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
          },
          grid: { color: "#2a3348" },
        },
        y: {
          ticks: { color: "#8896ae", font: { size: 11 } },
          grid: { color: "#2a3348" },
        },
      },
      plugins: {
        ...baseOptions.plugins,
        tooltip: { callbacks: { label: (ctx) => fmtBDT(ctx.parsed.x) } },
      },
    },
  });
}

function renderCategoryChips(cats) {
  if (!cats || !cats.length) return '<span class="text-muted" style="font-size:.75rem">—</span>';
  return cats
    .map(
      (c) =>
        `<span class="cat-chip" title="${esc(c.name)}: ${fmt(c.sold)}/${fmt(c.total)} sold">${esc(c.name)} ${c.total > 0 ? ((c.sold / c.total) * 100).toFixed(0) : 0}%</span>`,
    )
    .join(" ");
}

/* ─── Branch table ───────────────────────────────────────────── */
function renderBranchTable(branches, filter = "") {
  const tbody = $("branchTbody");
  const filtered = filter
    ? branches.filter((b) =>
        b.branchName.toLowerCase().includes(filter.toLowerCase()),
      )
    : branches;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-muted"
      style="padding:20px;text-align:center">No locations match your search.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (b) => `
    <tr>
      <td class="fw-bold">${esc(b.branchName)}</td>
      <td class="num">${b.shows.length}</td>
      <td class="num" style="color:var(--accent2)">${fmt(b.totalSold)}</td>
      <td class="num text-muted">${fmt(b.totalCapacity - b.totalSold)}</td>
      <td class="num text-muted">${fmt(b.totalCapacity)}</td>
      <td class="num">${occBadge(b.occupancy)}</td>
      <td class="num">${fmtBDT(b.totalRevenue)}</td>
      <td class="num">${renderCategoryChips(b.categories)}</td>
      <td class="num">
        <button class="btn btn-sm btn-outline"
          data-branch="${esc(b.branchName)}"
          onclick="expandLocation(this.dataset.branch)">Shows ▾</button>
      </td>
    </tr>`,
    )
    .join("");
}

/* ═══════════════════════════════════════════════════════════════
   EXPAND LOCATION
   ═══════════════════════════════════════════════════════════════ */

function expandLocation(name) {
  if (!state.currentStats) return;
  const branch = state.currentStats.branches.find((b) => b.branchName === name);
  if (!branch) return;

  // Store shows so showCategoryModal can look them up by index
  state.currentLocationShows = branch.shows;

  $("showCardTitle").textContent = `📍 ${branch.branchName}`;
  $("showCard").hidden = false;

  const tbody = $("showTbody");
  tbody.innerHTML = branch.shows
    .map(
      (show, i) => `
    <tr>
      <td class="fw-bold">${esc(show.showTime || "—")}</td>
      <td class="text-muted">${esc(show.hallName || "—")}</td>
      <td><span style="font-size:.8rem;color:var(--blue)">${esc(show.format || "—")}</span></td>
      <td class="num">${fmt(show.sold)}</td>
      <td class="num text-muted">${fmt(show.available)}</td>
      <td class="num text-muted">${fmt(show.capacity)}</td>
      <td class="num">${occBadge(show.occupancy)}</td>
      <td class="num">${fmtBDT(show.revenue)}</td>
      <td style="max-width:180px">${renderCategoryChips(show.categories)}</td>
      <td class="num">
        <button class="btn btn-sm btn-outline"
          onclick="showCategoryModal(${i})">Details</button>
      </td>
    </tr>`,
    )
    .join("");

  $("showCard").scrollIntoView({ behavior: "smooth" });
}
window.expandLocation = expandLocation;

/* ═══════════════════════════════════════════════════════════════
   CATEGORY MODAL
   ═══════════════════════════════════════════════════════════════ */

function showCategoryModal(indexOrShow) {
  const show =
    typeof indexOrShow === "number"
      ? state.currentLocationShows[indexOrShow]
      : indexOrShow;
  if (!show) return;

  $("catModalTitle").textContent =
    `${show.showTime || "—"} · ${show.hallName || ""}`;

  const cats = show.categories || [];

  const grid = cats.length
    ? cats
        .map((cat) => {
          const pct =
            cat.total > 0 ? ((cat.sold / cat.total) * 100).toFixed(0) : 0;
          return `
          <div class="cat-card">
            <div class="cat-name">${esc(cat.name)}</div>
            <div class="cat-sold">${fmt(cat.sold)}</div>
            <div class="cat-total">of ${fmt(cat.total)} seats</div>
            <div class="cat-price">${fmtBDT(cat.price)} / seat</div>
            <div class="progress-bar-wrap" title="${pct}% sold" style="margin-top:8px">
              <div class="progress-bar" style="width:${pct}%"></div>
            </div>
            <div class="cat-total mt-4">${occBadge(pct)}</div>
          </div>`;
        })
        .join("")
    : '<p class="text-muted">No category data available.</p>';

  const totalRev = cats.reduce((s, c) => s + c.sold * c.price, 0);

  $("catModalBody").innerHTML = `
    <div class="cat-grid">${grid}</div>
    <div style="border-top:1px solid var(--border);padding-top:14px;
                display:flex;justify-content:space-between;align-items:center">
      <span class="text-muted" style="font-size:.85rem">Show Revenue</span>
      <span style="font-size:1.2rem;font-weight:700;color:var(--gold)">${fmtBDT(totalRev)}</span>
    </div>`;

  $("catModal").hidden = false;
}
window.showCategoryModal = showCategoryModal;

/* ═══════════════════════════════════════════════════════════════
   HISTORY PANEL
   ═══════════════════════════════════════════════════════════════ */

async function toggleHistory() {
  const sec = $("historySection");
  if (!sec.hidden) {
    sec.hidden = true;
    return;
  }
  await loadHistoryList();
  sec.hidden = false;
  sec.scrollIntoView({ behavior: "smooth" });
}

async function loadHistoryList() {
  const tbody = $("histTbody");
  tbody.innerHTML = `<tr><td colspan="4" class="text-muted"
    style="padding:16px;text-align:center"><span class="spinner"></span> Loading…</td></tr>`;

  try {
    const r = await api("GET", "/api/snapshots");
    if (r.success) renderHistory(r.snapshots);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-muted"
      style="padding:16px;text-align:center">Error: ${esc(e.message)}</td></tr>`;
  }
}

function renderHistory(snapshots) {
  const tbody = $("histTbody");
  if (!snapshots || !snapshots.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-muted"
      style="padding:20px;text-align:center">No snapshots yet. Analyze a movie first.</td></tr>`;
    return;
  }

  tbody.innerHTML = snapshots
    .map(
      (s) => `
    <tr>
      <td class="fw-bold">${esc(s.movieName)}</td>
      <td>${esc(s.showDate)}</td>
      <td class="text-muted">${esc(s.scrapedAt)}</td>
      <td style="display:flex;gap:6px;justify-content:flex-end;padding-right:14px">
        <button class="btn btn-sm btn-outline" onclick="loadSnapshotById(${s.id})">📊 View</button>
        <button class="btn btn-sm btn-danger"  onclick="deleteSnapshotById(${s.id})">🗑</button>
      </td>
    </tr>`,
    )
    .join("");
}

async function loadSnapshotById(id) {
  const tbody = $("histTbody");
  tbody.innerHTML = `<tr><td colspan="4" class="text-muted"
    style="padding:16px;text-align:center"><span class="spinner"></span> Loading snapshot…</td></tr>`;

  try {
    const r = await api("GET", `/api/snapshots/${id}/stats`);
    if (r.success) {
      $("historySection").hidden = true;
      renderDashboard(r.stats);
    } else {
      showStatus("Could not load snapshot: " + r.error, "error");
      await loadHistoryList();
    }
  } catch (e) {
    showStatus("Network error: " + e.message, "error");
    await loadHistoryList();
  }
}

async function deleteSnapshotById(id) {
  if (!confirm("Delete this snapshot permanently?")) return;
  try {
    await api("DELETE", `/api/snapshots/${id}`);
    await loadHistoryList();
  } catch (e) {
    showStatus("Delete failed: " + e.message, "error");
  }
}

// Make history functions global (called from inline onclick)
window.loadSnapshotById = loadSnapshotById;
window.deleteSnapshotById = deleteSnapshotById;

/* ═══════════════════════════════════════════════════════════════
   EXPORT CSV
   ═══════════════════════════════════════════════════════════════ */

function exportCSV() {
  if (!state.currentStats) return;
  const stats = state.currentStats;

  const headers = [
    "Location",
    "Screen",
    "Type",
    "Show Time",
    "Category",
    "Total Seats",
    "Sold",
    "Available",
    "Occupancy%",
    "Price",
    "Revenue",
  ];
  const rows = [headers];

  for (const branch of stats.branches) {
    for (const show of branch.shows) {
      for (const cat of show.categories) {
        const occ =
          cat.total > 0 ? ((cat.sold / cat.total) * 100).toFixed(1) : "0.0";
        rows.push([
          branch.branchName,
          show.hallName || "",
          show.format || "",
          show.showTime || "",
          cat.name,
          cat.total,
          cat.sold,
          cat.available,
          occ,
          cat.price,
          (cat.sold * cat.price).toFixed(0),
        ]);
      }
    }
  }

  const csv = rows
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cineplex_${stats.movieName.replace(/\s+/g, "_")}_${stats.showDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
