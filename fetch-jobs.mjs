// fetch-jobs.mjs
// Pulls remote recruiting-family jobs from Remotive, RemoteOK, WeWorkRemotely,
// Adzuna, and Jooble — filters for relevance, writes docs/jobs.json.

import { writeFile, readFile } from "node:fs/promises";

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY;

const TITLE_KEYWORDS = [
  "recruiter",
  "recruitment consultant",
  "it recruiter",
  "talent acquisition",
  "sourcing specialist",
  "sourcer",
];

const EXCLUDE_LOCATION_PATTERNS = [
  /usa only/i, /us only/i, /united states only/i, /uk only/i,
  /europe only/i, /eu only/i, /canada only/i, /latam only/i, /emea only/i,
];

function titleMatches(title = "") {
  const t = title.toLowerCase();
  return TITLE_KEYWORDS.some((k) => t.includes(k));
}

function locationLooksOk(locationStr = "") {
  return !EXCLUDE_LOCATION_PATTERNS.some((re) => re.test(locationStr));
}

function withinLastWeek(dateStr) {
  if (!dateStr) return true;
  const posted = new Date(dateStr).getTime();
  if (Number.isNaN(posted)) return true;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return posted >= weekAgo;
}

async function fetchRemotive() {
  const jobs = [];
  try {
    const res = await fetch("https://remotive.com/api/remote-jobs");
    const data = await res.json();
    for (const j of data.jobs || []) {
      if (!titleMatches(j.title)) continue;
      if (!locationLooksOk(j.candidate_required_location)) continue;
      if (!withinLastWeek(j.publication_date)) continue;
      jobs.push({
        id: `remotive-${j.id}`,
        title: j.title,
        company: j.company_name,
        location: j.candidate_required_location || "Remote",
        url: j.url,
        postedAt: j.publication_date || null,
        source: "Remotive",
        description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 600),
      });
    }
  } catch (err) {
    console.error("Remotive fetch failed:", err.message);
  }
  return jobs;
}

async function fetchRemoteOK() {
  const jobs = [];
  try {
    const res = await fetch("https://remoteok.com/api", {
      headers: { "User-Agent": "job-tracker-bot" },
    });
    const data = await res.json();
    for (const j of data) {
      if (!j.position) continue;
      if (!titleMatches(j.position)) continue;
      const loc = j.location || "";
      if (!locationLooksOk(loc)) continue;
      if (!withinLastWeek(j.date)) continue;
      jobs.push({
        id: `remoteok-${j.id}`,
        title: j.position,
        company: j.company,
        location: loc || "Remote",
        url: j.url || `https://remoteok.com/l/${j.id}`,
        postedAt: j.date || null,
        source: "RemoteOK",
        description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 600),
      });
    }
  } catch (err) {
    console.error("RemoteOK fetch failed:", err.message);
  }
  return jobs;
}

async function
