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

async function fetchAdzuna() {
  const jobs = [];
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.log("Adzuna skipped: no credentials set");
    return jobs;
  }
  const queries = ["recruiter", "talent acquisition", "sourcing specialist"];
  for (const q of queries) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&what=${encodeURIComponent(q)}&results_per_page=20&max_days_old=7&content-type=application/json`;
      const res = await fetch(url);
      const data = await res.json();
      for (const j of data.results || []) {
        if (!titleMatches(j.title)) continue;
        jobs.push({
          id: `adzuna-${j.id}`,
          title: j.title,
          company: j.company?.display_name || "Unknown",
          location: j.location?.display_name || "India",
          url: j.redirect_url,
          postedAt: j.created || null,
          source: "Adzuna",
          description: (j.description || "").slice(0, 600),
        });
      }
    } catch (err) {
      console.error(`Adzuna fetch failed for "${q}":`, err.message);
    }
  }
  return jobs;
}
async function fetchJooble() {
  const jobs = [];
  if (!JOOBLE_API_KEY) {
    console.log("Jooble skipped: no API key set");
    return jobs;
  }
  const queries = ["recruiter", "talent acquisition", "IT recruiter"];
  for (const q of queries) {
    try {
      const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: q, location: "India", radius: "0" }),
      });
      const data = await res.json();
      for (const j of data.jobs || []) {
        if (!titleMatches(j.title)) continue;
        if (!locationLooksOk(j.location || "")) continue;
        if (!withinLastWeek(j.updated)) continue;
        jobs.push({
          id: `jooble-${Buffer.from(j.link || j.title + j.company).toString("base64").slice(0, 16)}`,
          title: j.title,
          company: j.company || "Unknown",
          location: j.location || "India",
          url: j.link,
          postedAt: j.updated || null,
          source: "Jooble",
          description: (j.snippet || "").replace(/<[^>]+>/g, " ").slice(0, 600),
        });
      }
    } catch (err) {
      console.error(`Jooble fetch failed for "${q}":`, err.message);
    }
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
  const [a, b, c, d, e] = await Promise.all([
    fetchRemotive(), fetchRemoteOK(), fetchWeWorkRemotely(), fetchAdzuna(), fetchJooble(),
  ]);
  const all = dedupe([...a, ...b, ...c, ...d, ...e]);

  let previous = [];
  try {
    previous = JSON.parse(await readFile("docs/jobs.json", "utf-8")).jobs || [];
  } catch {}
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
