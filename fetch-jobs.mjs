// fetch-jobs.mjs
// Pulls remote recruiting-family jobs from free, no-key job board APIs,
// filters them for relevance, and writes docs/jobs.json for the dashboard.

import { writeFile, readFile } from "node:fs/promises";

const TITLE_KEYWORDS = [
  "recruiter",
  "recruitment consultant",
  "it recruiter",
  "talent acquisition",
  "sourcing specialist",
  "sourcer",
];

const EXCLUDE_LOCATION_PATTERNS = [
  /usa only/i,
  /us only/i,
  /united states only/i,
  /uk only/i,
  /europe only/i,
  /eu only/i,
  /canada only/i,
  /latam only/i,
  /emea only/i,
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
    const res = await fetch("https://remotive.com/api/remote-jobs?category=sales-business");
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

async function fetchWeWorkRemotely() {
  const jobs = [];
  try {
    const res = await fetch("https://weworkremotely.com/categories/remote-hr-recruiter-jobs.rss");
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    for (const item of items) {
      const title = (item.match(/<title>(.*?)<\/title>/s) || [, ""])[1];
      const link = (item.match(/<link>(.*?)<\/link>/s) || [, ""])[1];
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/s) || [, ""])[1];
      const desc = (item.match(/<description>(.*?)<\/description>/s) || [, ""])[1];
      if (!titleMatches(title)) continue;
      if (!withinLastWeek(pubDate)) continue;
      const [company, ...rest] = title.split(":");
      jobs.push({
        id: `wwr-${Buffer.from(link).toString("base64").slice(0, 12)}`,
        title: rest.join(":").trim() || title,
        company: company.trim(),
        location: "Remote",
        url: link.trim(),
        postedAt: pubDate || null,
        source: "WeWorkRemotely",
        description: desc.replace(/<[^>]+>/g, " ").slice(0, 600),
      });
    }
  } catch (err) {
    console.error("WeWorkRemotely fetch failed:", err.message);
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

async function main() {
  const [a, b, c] = await Promise.all([fetchRemotive(), fetchRemoteOK(), fetchWeWorkRemotely()]);
  const all = dedupe([...a, ...b, ...c]);

  let previous = [];
  try {
    previous = JSON.parse(await readFile("docs/jobs.json", "utf-8")).jobs || [];
  } catch {
    // no previous file yet — fine
  }
  const prevById = Object.fromEntries(previous.map((j) => [j.id, j]));

  const merged = all.map((j) => ({
    ...j,
    status: prevById[j.id]?.status || "New",
    notes: prevById[j.id]?.notes || "",
  }));

  const output = {
    updatedAt: new Date().toISOString(),
    count: merged.length,
    jobs: merged,
  };

  await writeFile("docs/jobs.json", JSON.stringify(output, null, 2));
  console.log(`Wrote ${merged.length} jobs to docs/jobs.json`);
}

main();
