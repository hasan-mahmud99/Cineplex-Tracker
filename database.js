/**
 * database.js
 * Zero-dependency JSON-file database.
 * All data lives in  data/tracker.json  (one atomic write per mutation).
 *
 * Schema (in memory):
 *   snapshots[]    – { id, movieId, movieName, showDate, scrapedAt }
 *   shows[]        – { id, snapshotId, showId, showTime, branchId, branchName,
 *                       hallName, format, language }
 *   seatCategories[] – { id, showRecordId, categoryName, totalSeats,
 *                         availableSeats, soldSeats, price }
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "tracker.json");

/* ─── Persistence helpers ─────────────────────────────────────── */

let _cache = null;

function load() {
  if (_cache) return _cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    _cache = { snapshots: [], shows: [], seatCategories: [], _nextId: 1 };
    save();
  } else {
    _cache = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!_cache._nextId) _cache._nextId = 1;
  }
  return _cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(_cache, null, 2));
}

function nextId() {
  const db = load();
  return db._nextId++;
}

/* ─── Write ───────────────────────────────────────────────────── */

/**
 * Save a full scrape result.
 * @param {Object} data  - { movieId, movieName, showDate, shows[] }
 * @returns {number} snapshotId
 */
function saveSnapshot(data) {
  const db = load();

  const snapshotId = nextId();
  db.snapshots.push({
    id: snapshotId,
    movieId: data.movieId,
    movieName: data.movieName,
    showDate: data.showDate,
    scrapedAt: new Date().toLocaleString("en-BD", { hour12: true }),
  });

  for (const show of data.shows || []) {
    const showRecordId = nextId();
    // Support both new shape (locationTitle/screenTitle) and legacy shape (branchName/hallName)
    db.shows.push({
      id: showRecordId,
      snapshotId,
      showId: show.programId || show.showId || null,
      showTime: show.showTime || null,
      branchId: show.locationId || show.branchId || null,
      branchName: show.locationTitle || show.branchName || null,
      hallName: show.screenTitle || show.hallName || null,
      format: show.screenType || show.format || null,
      language: show.language || null,
    });

    for (const cat of show.categories || []) {
      const total = Number(cat.totalSeats || 0);
      const available = Number(cat.availableSeats || 0);
      const sold =
        cat.soldSeats != null ? Number(cat.soldSeats) : total - available;

      db.seatCategories.push({
        id: nextId(),
        showRecordId,
        categoryName: cat.name || cat.categoryName || "Unknown",
        totalSeats: total,
        availableSeats: available,
        soldSeats: sold,
        price: Number(cat.price || 0),
      });
    }
  }

  save();
  return snapshotId;
}

/* ─── Read ────────────────────────────────────────────────────── */

function listSnapshots() {
  const db = load();
  return [...db.snapshots].reverse().slice(0, 200);
}

function getSnapshotById(snapshotId) {
  const db = load();
  const snap = db.snapshots.find((s) => s.id === snapshotId);
  if (!snap) return null;
  return { ...snap, shows: getShowsForSnapshot(snapshotId, db) };
}

function getLatestSnapshot(movieId, showDate) {
  const db = load();
  // most recent first
  const snaps = db.snapshots
    .filter((s) => s.movieId === movieId && s.showDate === showDate)
    .reverse();
  if (!snaps.length) return null;
  return { ...snaps[0], shows: getShowsForSnapshot(snaps[0].id, db) };
}

function getShowsForSnapshot(snapshotId, db) {
  db = db || load();
  const shows = db.shows
    .filter((s) => s.snapshotId === snapshotId)
    .sort((a, b) => {
      if (a.branchName < b.branchName) return -1;
      if (a.branchName > b.branchName) return 1;
      return (a.showTime || "").localeCompare(b.showTime || "");
    });
  return shows.map((s) => ({
    ...s,
    categories: db.seatCategories.filter((c) => c.showRecordId === s.id),
  }));
}

function listTrackedCombos() {
  const db = load();
  const map = {};
  for (const s of db.snapshots) {
    const key = `${s.movieId}||${s.showDate}`;
    if (!map[key]) {
      map[key] = {
        movieId: s.movieId,
        movieName: s.movieName,
        showDate: s.showDate,
        snapCount: 0,
        lastScraped: "",
      };
    }
    map[key].snapCount++;
    if (s.scrapedAt > map[key].lastScraped) map[key].lastScraped = s.scrapedAt;
  }
  return Object.values(map).sort((a, b) =>
    b.lastScraped.localeCompare(a.lastScraped),
  );
}

/**
 * Aggregate stats for a specific snapshot.
 */
function aggregateStats(snapshotId) {
  const snap = getSnapshotById(snapshotId);
  if (!snap) return null;

  const branchMap = {};

  for (const show of snap.shows) {
    const key = show.branchName || "Unknown Branch";
    if (!branchMap[key]) {
      branchMap[key] = {
        branchName: key,
        shows: [],
        categories: {},
        totalSold: 0,
        totalCapacity: 0,
        totalRevenue: 0,
      };
    }

    let showSold = 0,
      showCapacity = 0,
      showRevenue = 0;
    const catSummary = show.categories.map((cat) => {
      showSold += cat.soldSeats;
      showCapacity += cat.totalSeats;
      showRevenue += cat.soldSeats * cat.price;
      return {
        name: cat.categoryName,
        total: cat.totalSeats,
        available: cat.availableSeats,
        sold: cat.soldSeats,
        price: cat.price,
        revenue: cat.soldSeats * cat.price,
      };
    });

    // Build branch-level category aggregation
    for (const cat of show.categories) {
      const n = cat.categoryName;
      if (!branchMap[key].categories) branchMap[key].categories = {};
      if (!branchMap[key].categories[n]) {
        branchMap[key].categories[n] = { name: n, total: 0, sold: 0, available: 0, price: cat.price };
      }
      branchMap[key].categories[n].total += cat.totalSeats;
      branchMap[key].categories[n].sold += cat.soldSeats;
      branchMap[key].categories[n].available += cat.availableSeats;
    }

    branchMap[key].shows.push({
      showId: show.showId,
      showTime: show.showTime,
      hallName: show.hallName,
      format: show.format,
      language: show.language,
      sold: showSold,
      capacity: showCapacity,
      available: showCapacity - showSold,
      occupancy:
        showCapacity > 0 ? ((showSold / showCapacity) * 100).toFixed(1) : "0.0",
      revenue: showRevenue,
      categories: catSummary,
    });

    branchMap[key].totalSold += showSold;
    branchMap[key].totalCapacity += showCapacity;
    branchMap[key].totalRevenue += showRevenue;
  }

  const branches = Object.values(branchMap).map((b) => ({
    ...b,
    categories: b.categories
      ? Object.values(b.categories).sort((a, c) => c.total - a.total)
      : [],
    occupancy:
      b.totalCapacity > 0
        ? ((b.totalSold / b.totalCapacity) * 100).toFixed(1)
        : "0.0",
  }));

  const grandSold = branches.reduce((s, b) => s + b.totalSold, 0);
  const grandCapacity = branches.reduce((s, b) => s + b.totalCapacity, 0);
  const grandRevenue = branches.reduce((s, b) => s + b.totalRevenue, 0);

  return {
    snapshotId,
    movieName: snap.movieName,
    showDate: snap.showDate,
    scrapedAt: snap.scrapedAt,
    summary: {
      totalSold: grandSold,
      totalCapacity: grandCapacity,
      totalAvailable: grandCapacity - grandSold,
      occupancy:
        grandCapacity > 0
          ? ((grandSold / grandCapacity) * 100).toFixed(1)
          : "0.0",
      totalRevenue: grandRevenue,
      totalShows: snap.shows.length,
      totalBranches: branches.length,
    },
    branches,
  };
}

function deleteSnapshot(snapshotId) {
  const db = load();
  const showIds = db.shows
    .filter((s) => s.snapshotId === snapshotId)
    .map((s) => s.id);
  db.seatCategories = db.seatCategories.filter(
    (c) => !showIds.includes(c.showRecordId),
  );
  db.shows = db.shows.filter((s) => s.snapshotId !== snapshotId);
  db.snapshots = db.snapshots.filter((s) => s.id !== snapshotId);
  save();
}

module.exports = {
  saveSnapshot,
  listSnapshots,
  getSnapshotById,
  getLatestSnapshot,
  listTrackedCombos,
  aggregateStats,
  deleteSnapshot,
};
