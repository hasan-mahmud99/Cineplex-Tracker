# 🎬 Cineplex Tracker

> A real-time ticket sales & occupancy tracker for Star Cineplex BD. Scrapes all branches, shows, and seat categories for any movie + date.

---

## Features

| Feature | Detail |
|---|---|
| **Live Scrape** | Playwright guest login + direct API calls to cineplex-ticket-api |
| **Branch stats** | Per-location: sold, available, capacity, occupancy %, revenue, seat types |
| **Show stats** | Per show: time, screen, format, per-category breakdown (Regular, VIP, Semi Recliner, etc.) |
| **Category breakdown** | Per seat type: sold vs available with price and revenue (inline chips + modal) |
| **Charts** | Occupancy by branch + Revenue by branch (Chart.js) |
| **History** | All snapshots stored in JSON; load any past result |
| **Export CSV** | Full category-level data export |
| **Filter** | Search/filter locations in the branch table |

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Install Playwright Chromium browser
```bash
npm run install-playwright
```

### 3. Start the server
```bash
npm start
```

### 4. Open the portal
[http://localhost:3000](http://localhost:3000)

---

## Usage

1. Select a movie from the grid.
2. Pick a show date.
3. Wait ~20–30 seconds while the scraper fetches all shows across all locations.
4. Dashboard renders automatically with KPIs, charts, and branch/show tables.
5. Click **Shows ▾** on any branch to expand show details.
6. Click **Details** on any show to see full seat-type breakdown.
7. Use **Refresh** to re-scrape, **Export CSV** to download data, **History** to view past snapshots.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/movies` | List now-showing movies |
| GET | `/api/dates?movieId=X` | Available dates for a movie |
| GET | `/api/locations` | All cinema locations |
| POST | `/api/analyze` | Full scrape: `{ movieId, movieTitle, showDate }` |
| GET | `/api/snapshots` | List all saved snapshots |
| GET | `/api/snapshots/:id/stats` | Aggregated stats for a snapshot |
| DELETE | `/api/snapshots/:id` | Delete snapshot |

---

## Data Storage

All data is stored in `data/tracker.json` (flat JSON file, one atomic write per mutation). Debug logs and screenshots from the scraper are saved in `data/debug/`.

---

## Scraper Notes

The scraper (`scraper.js`) uses Playwright once per server start to perform a guest login and harvest the Bearer token. After that, all data calls use direct `fetch()` against `cineplex-ticket-api.cineplexbd.com`.

**Flow:**
1. Playwright → guest login → capture token
2. `POST /api/v1/get-location` → all cinema locations
3. `POST /api/v1/get-showdate` → available dates per location
4. `POST /api/v1/get-shows` → screens + showtimes + seat prices per movie+date
5. `POST /api/v1/get-seat` → seat layout with per-category counts per show

If the scraper returns 0 shows, check `data/debug/` for captured screenshots.

---

## Tech Stack

- **Backend**: Node.js + Express
- **Scraping**: Playwright (Chromium) + native fetch
- **Database**: JSON file (`data/tracker.json`)
- **Frontend**: Vanilla HTML/CSS/JS + Chart.js