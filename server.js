/**
 * server.js
 * Express server — Cineplex Tracker portal
 *
 * API
 * ───
 * GET  /api/movies                           List now-showing movies
 * GET  /api/dates?movieId=X                  Available dates for a movie
 * GET  /api/locations                        All cinema locations
 * POST /api/analyze  {movieId,movieTitle,showDate}   Full scrape + save + return stats
 * GET  /api/snapshots                        List all saved snapshots
 * GET  /api/snapshots/:id/stats              Aggregated stats for a snapshot
 * DELETE /api/snapshots/:id                  Delete snapshot
 */

const express = require("express");
const path = require("path");
const scraper = require("./scraper");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ─── Helpers ─────────────────────────────────────────────────── */

function ok(res, data) {
  res.json({ success: true, ...data });
}
function fail(res, msg, code = 500) {
  res.status(code).json({ success: false, error: String(msg) });
}

// Warm up the guest session in the background so the first request is fast
scraper
  .ensureSession()
  .catch((e) =>
    console.warn("[server] Pre-warm guest session failed:", e.message),
  );

/* ─── Movies ──────────────────────────────────────────────────── */

app.get("/api/movies", async (req, res) => {
  try {
    const movies = await scraper.getMovies();
    ok(res, { movies });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ─── Locations ───────────────────────────────────────────────── */

app.get("/api/locations", async (req, res) => {
  try {
    const locations = await scraper.getLocations();
    ok(res, { locations });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ─── Available dates for a movie ────────────────────────────── */

app.get("/api/dates", async (req, res) => {
  const movieId = Number(req.query.movieId);
  if (!movieId) return fail(res, "movieId required", 400);
  try {
    const dates = await scraper.getAvailableDates(movieId);
    ok(res, { dates });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ─── Full analysis (main action) ────────────────────────────── */

app.post("/api/analyze", async (req, res) => {
  const { movieId, movieTitle, showDate } = req.body;
  if (!movieId || !movieTitle || !showDate)
    return fail(res, "movieId, movieTitle and showDate are required", 400);

  try {
    const raw = await scraper.analyzeMovie(
      Number(movieId),
      movieTitle,
      showDate,
    );
    const snapshotId = db.saveSnapshot(raw);
    const stats = db.aggregateStats(snapshotId);
    ok(res, { snapshotId, stats });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ─── Snapshots ───────────────────────────────────────────────── */

app.get("/api/snapshots", (req, res) => {
  try {
    ok(res, { snapshots: db.listSnapshots() });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/snapshots/:id/stats", (req, res) => {
  try {
    const stats = db.aggregateStats(Number(req.params.id));
    if (!stats) return fail(res, "Snapshot not found", 404);
    ok(res, { stats });
  } catch (e) {
    fail(res, e.message);
  }
});

app.delete("/api/snapshots/:id", (req, res) => {
  try {
    db.deleteSnapshot(Number(req.params.id));
    ok(res, { deleted: true });
  } catch (e) {
    fail(res, e.message);
  }
});

/* ─── Start ───────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`\n🎬  Cineplex Tracker  →  http://localhost:${PORT}\n`);
});
