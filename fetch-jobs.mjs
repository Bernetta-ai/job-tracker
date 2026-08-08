import { writeFile, readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const RECENCY_DAYS = 14;

const TITLE_KEYWORDS = [
  "recruiter", "recruitment consultant", "it recruiter",
  "talent acquisition", "sourcing specialist", "sourcer",
];

const EXCLUDE_LOCATION_PATTERNS = [
  /usa only/i, /us only/i, /united states only/i, /uk only/i,
  /europe only/i, /eu only/i, /canada only/i, /latam only/i, /emea only/i,
];

const REMOTE_SIGNAL = /(remote|work[\s-]?from[\s-]?home|\bwfh\b|virtual|telecommute|anywhere)/i;
const HYBRID_ONSITE_SIGNAL = /(hybrid|on-site|onsite|in-office|in office|work from office|\bwfo\b)/i;

function titleMatches(title = "") {
  const t = title.toLowerCase();
  return TITLE_KEYWORDS.some((k) => t.includes(k));
}
function locationLooksOk(locationStr = "") {
  return !EXCLUDE_LOCATION_PATTERNS.some((re) => re.test(locationStr));
}
function isActuallyRemote(job) {
  const text = `${job.title} ${job.location || ""} ${job.description || ""}`;
  if (HYBRID_ONSITE_SIGNAL.test(text)) return false;
  return REMOTE_SIGNAL.test(job.title) || REMOTE_SIGNAL.test(job.location || "") || REMOTE_SIGNAL.test(job.description || "");
}
function withinRecency(dateStr, days = RECENCY_DAYS) {
  if (!dateStr) return true;
  const posted = new Date(dateStr).getTime();
  if (Number.isNaN(posted)) return true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return posted >= cutoff;
}

// Fetches the real job posting page and pulls the main article text, the same
// technique browser "reader mode" uses. Only worth trying for sources whose
// API gives a short snippet (Adzuna/Jooble) — Remotive/RemoteOK/WWR already
// return full text. Fails gracefully: any error or thin/garbled result falls
// back to the original snippet rather than showing something broken.
async function tryExtractFullDescription(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; job-tracker-bot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null;

    const dom = new JSDOM(html, { url: res.url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.textContent) return null;

    const text = article.textContent.replace(/\s+/g, " ").trim();
    // Sanity checks: too short means extraction likely failed or hit a bot-block page.
    if (text.length < 200) return null;
    return text.slice(0, 6000);
  } catch (err) {
    return null;
  }
}

async function fetchRemotive() {
  const jobs = [];
  try {
    const res = await fetch("https://remotive.com/api/remote-jobs");
    const data = await res.json();
    for (const j of data.jobs || []) {
      if (!titleMatches(j.title)) continue;
      if (!locationLooksOk(j.candidate_required_location)) continue;
      if (!withinRecency(j.publication_date)) continue;
      jobs.push({
        id: `remotive-${j.id}`, title: j.title, company: j.company_name,
        location: j.candidate_required_location || "Remote", url: j.url,
        postedAt: j.publication_date || null, source: "Remotive",
        description: (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
        descriptionExtracted: false,
      });
    }
  } catch (err) { console.error("Remotive fetch failed:", err.message); }
  return jobs;
}

async function fetchRemoteOK() {
  const jobs = [];
  try {
    const res = await fetch("https://remoteok.com/api", { headers: { "User-Agent": "job-tracker-bot" } });
    const data = await res.json();
    for (const j of data) {
      if (!j.position) continue;
      if (!titleMatches(j.position)) continue;
      const loc = j.location || "";
      if (!locationLooksOk(loc)) continue;
      if (!withinRecency(j.date)) continue;
      jobs.push({
        id: `remoteok-${j.id}`, title: j.position, company: j.company,
        location: loc || "Remote", url: j.url || `https://remoteok.com/l/${j.id}`,
        postedAt: j.date || null, source: "RemoteOK",
        description: (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
        descriptionExtracted: false,
      });
    }
  } catch (err) { console.error("RemoteOK fetch failed:", err.message); }
  return jobs;
}

async function fetchWeWorkRemotely() {
  const jobs = [];
  try {
    const res = await fetch("https://weworkremotely.com/remote-jobs.rss");
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    for (const item of items) {
      const title = (item.match(/<title>(.*?)<\/title>/s) || [, ""])[1];
      const link = (item.match(/<link>(.*?)<\/link>/s) || [, ""])[1];
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/s) || [, ""])[1];
      const desc = (item.match(/<description>(.*?)<\/description>/s) || [, ""])[1];
      if (!titleMatches(title)) continue;
      if (!withinRecency(pubDate)) continue;
      const [company, ...rest] = title.split(":");
      jobs.push({
        id: `wwr-${Buffer.from(link).toString("base64").slice(0, 12)}`,
        title: rest.join(":").trim() || title, company: company.trim(),
        location: "Remote", url: link.trim(), postedAt: pubDate || null, source: "WeWorkRemotely",
        description: desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
        descriptionExtracted: false,
      });
    }
  } catch (err) { console.error("WeWorkRemotely fetch failed:", err.message); }
  return jobs;
}

async function fetchAdzuna(alreadySeenIds) {
  const jobs = [];
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) { console.log("Adzuna skipped: no credentials set"); return jobs; }
  const queries = ["recruiter", "talent acquisition", "sourcing specialist"];
  for (const q of queries) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&what=${encodeURIComponent(q)}&results_per_page=30&max_days_old=${RECENCY_DAYS}&content-type=application/json`;
      const res = await fetch(url);
      const data = await res.json();
      for (const j of data.results || []) {
        if (!titleMatches(j.title)) continue;
        const id = `adzuna-${j.id}`;
        const job = {
          id, title: j.title, company: j.company?.display_name || "Unknown",
          location: j.location?.display_name || "India", url: j.redirect_url,
          postedAt: j.created || null, source: "Adzuna",
          description: (j.description || "").trim().slice(0, 4000),
          descriptionExtracted: false,
        };
        if (!isActuallyRemote(job)) continue;

        // Only attempt full-text extraction for genuinely new listings — keeps
        // each run fast, since previously-seen jobs already have whatever
        // description they were assigned on first sight.
        if (!alreadySeenIds.has(id)) {
          const full = await tryExtractFullDescription(job.url);
          if (full && full.length > job.description.length) {
            job.description = full;
            job.descriptionExtracted = true;
          }
        }
        jobs.push(job);
      }
    } catch (err) { console.error(`Adzuna fetch failed for "${q}":`, err.message); }
  }
  return jobs;
}

async function fetchJooble(alreadySeenIds) {
  const jobs = [];
  if (!JOOBLE_API_KEY) { console.log("Jooble skipped: no API key set"); return jobs; }
  const queries = ["recruiter", "talent acquisition", "IT recruiter"];
  for (const q of queries) {
    try {
      const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: q, location: "India", radius: "0" }),
      });
      const data = await res.json();
      for (const j of data.jobs || []) {
        if (!titleMatches(j.title)) continue;
        if (!locationLooksOk(j.location || "")) continue;
        if (!withinRecency(j.updated)) continue;
        const id = `jooble-${Buffer.from(j.link || j.title + j.company).toString("base64").slice(0, 16)}`;
        const job = {
          id, title: j.title, company: j.company || "Unknown", location: j.location || "India",
          url: j.link, postedAt: j.updated || null, source: "Jooble",
          description: (j.snippet || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
          descriptionExtracted: false,
        };
        if (!isActuallyRemote(job)) continue;

        if (!alreadySeenIds.has(id)) {
          const full = await tryExtractFullDescription(job.url);
          if (full && full.length > job.description.length) {
            job.description = full;
            job.descriptionExtracted = true;
          }
        }
        jobs.push(job);
      }
    } catch (err) { console.error(`Jooble fetch failed for "${q}":`, err.message); }
  }
  return jobs;
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function notifyNewJobs(newJobs) {
  if (!NTFY_TOPIC || newJobs.length === 0) return;
  try {
    const titles = newJobs.slice(0, 5).map(j => `• ${j.title} @ ${j.company}`).join("\n");
    const more = newJobs.length > 5 ? `\n…and ${newJobs.length - 5} more` : "";
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Title": `${newJobs.length} new recruiter role${newJobs.length > 1 ? "s" : ""} posted`, "Priority": "high", "Tags": "briefcase" },
      body: titles + more,
    });
    console.log(`Sent ntfy notification for ${newJobs.length} new job(s)`);
  } catch (err) { console.error("ntfy notification failed:", err.message); }
}

async function main() {
  let previous = [];
  try { previous = JSON.parse(await readFile("docs/jobs.json", "utf-8")).jobs || []; } catch {}
  const prevById = Object.fromEntries(previous.map((j) => [j.id, j]));
  const alreadySeenIds = new Set(previous.map((j) => j.id));

  const [a, b, c, d, e] = await Promise.all([
    fetchRemotive(), fetchRemoteOK(), fetchWeWorkRemotely(), fetchAdzuna(alreadySeenIds), fetchJooble(alreadySeenIds),
  ]);
  const freshAll = dedupe([...a, ...b, ...c, ...d, ...e]);

  const newlyAppeared = freshAll.filter((j) => !prevById[j.id]);

  const mergedById = { ...prevById };
  const now = new Date().toISOString();
  for (const j of freshAll) {
    const prev = prevById[j.id];
    mergedById[j.id] = {
      ...j,
      status: prev?.status || "New",
      notes: prev?.notes || "",
      firstSeenAt: prev?.firstSeenAt || now,
    };
  }
  for (const id in mergedById) {
    if (!mergedById[id].firstSeenAt) mergedById[id].firstSeenAt = now;
  }

  const cutoff = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;
  const merged = Object.values(mergedById).filter((j) => {
    const postedTime = j.postedAt ? new Date(j.postedAt).getTime() : NaN;
    const refTime = !Number.isNaN(postedTime) ? postedTime : new Date(j.firstSeenAt).getTime();
    return refTime >= cutoff;
  });

  merged.sort((x, y) => {
    const dx = x.postedAt ? new Date(x.postedAt).getTime() : new Date(x.firstSeenAt).getTime();
    const dy = y.postedAt ? new Date(y.postedAt).getTime() : new Date(y.firstSeenAt).getTime();
    return dy - dx;
  });

  const output = { updatedAt: now, count: merged.length, jobs: merged };
  await writeFile("docs/jobs.json", JSON.stringify(output, null, 2));
  const extractedCount = newlyAppeared.filter((j) => j.descriptionExtracted).length;
  console.log(`Wrote ${merged.length} jobs to docs/jobs.json (${newlyAppeared.length} new since last run, ${extractedCount} got full-text extraction)`);

  await notifyNewJobs(newlyAppeared);
}

main();
