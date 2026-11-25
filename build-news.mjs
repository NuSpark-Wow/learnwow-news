// The Last 7 Days of Learn...Wow! News
// Runs once a day (GitHub Actions). Reads free news feeds, has Claude pick the
// highlights and write original summaries + a Big Picture paragraph, then saves news.json.

import fs from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.NEWS_MODEL || "claude-sonnet-5-5";
const DAYS = 7;            // rolling window
const DAILY_PICKS = 2;     // new highlights added per button each day
const BACKFILL_PICKS = 10; // first run only, to fill the 7 days right away
const UA = "Mozilla/5.0 (compatible; LearnWowNewsBot/1.0; +https://nusparklearnwow.com)";

const CATEGORIES = [
  {
    id: "science", name: "Science",
    guide: "General science discoveries: physics, chemistry, biology, archaeology, materials and big experiments. Not medicine, not technology products, not space or earth science.",
    feeds: [
      { url: "https://www.sciencedaily.com/rss/top/science.xml", source: "ScienceDaily" },
      { url: "https://phys.org/rss-feed/", source: "Phys.org" },
      { url: "https://www.sciencedaily.com/rss/matter_energy.xml", source: "ScienceDaily" },
    ],
  },
  {
    id: "medical", name: "Medical",
    guide: "Medical research and treatment: studies, new drugs and therapies, FDA approvals, disease breakthroughs. Not everyday wellness tips.",
    feeds: [
      { url: "https://www.sciencedaily.com/rss/health_medicine.xml", source: "ScienceDaily" },
      { url: "https://medicalxpress.com/rss-feed/", source: "Medical Xpress" },
      { url: "https://www.nih.gov/news-releases/feed.xml", source: "NIH" },
    ],
  },
  {
    id: "technology", name: "Technology",
    guide: "Technology: computing, gadgets, energy tech, robotics, engineering, the internet and devices. Not stories that are mainly about AI.",
    feeds: [
      { url: "https://techxplore.com/rss-feed/", source: "Tech Xplore" },
      { url: "https://www.technologyreview.com/feed/", source: "MIT Technology Review" },
      { url: "https://www.sciencedaily.com/rss/computers_math.xml", source: "ScienceDaily" },
    ],
  },
  {
    id: "ai", name: "AI",
    guide: "Artificial intelligence: new AI models and tools, AI research, how AI is being used, AI rules and policy.",
    feeds: [
      { url: "https://techxplore.com/rss-feed/machine-learning-ai-news/", source: "Tech Xplore" },
      { url: "https://news.mit.edu/rss/topic/artificial-intelligence2", source: "MIT News" },
      { url: "https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml", source: "ScienceDaily" },
    ],
  },
  {
    id: "ourworld", name: "Our World",
    guide: "Our World: earth science (earthquakes, volcanoes, geology), space and astronomy, weather and space weather (solar storms, auroras), oceans, wildlife, climate and natural events.",
    feeds: [
      { url: "https://www.nasa.gov/news-release/feed/", source: "NASA" },
      { url: "https://www.sciencedaily.com/rss/earth_climate.xml", source: "ScienceDaily" },
      { url: "https://www.sciencedaily.com/rss/space_time.xml", source: "ScienceDaily" },
      { url: "https://phys.org/rss-feed/earth-news/", source: "Phys.org" },
      { url: "https://phys.org/rss-feed/space-news/", source: "Phys.org" },
    ],
  },
  {
    id: "wellbeing", name: "Well-Being",
    guide: "Well-Being: mental health, stress, sleep, nutrition, fitness, healthy habits and everyday wellness. Not hospital treatments or drug research.",
    feeds: [
      { url: "https://www.sciencedaily.com/rss/mind_brain.xml", source: "ScienceDaily" },
      { url: "https://www.sciencedaily.com/rss/mind_brain/mental_health.xml", source: "ScienceDaily" },
      { url: "https://www.sciencedaily.com/rss/top/health.xml", source: "ScienceDaily" },
      { url: "https://www.sciencedaily.com/rss/health_medicine/nutrition.xml", source: "ScienceDaily" },
      { url: "https://www.sciencedaily.com/rss/health_medicine/fitness.xml", source: "ScienceDaily" },
    ],
  },
];

// ---------- helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
function entities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function clean(s = "") {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = entities(t);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return entities(t).replace(/\s+/g, " ").trim();
}

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const tag = (name) => { const m = b.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")); return m ? m[1] : ""; };
    let link = clean(tag("link"));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = entities(m[1]); }
    const title = clean(tag("title"));
    const desc = clean(tag("description") || tag("summary") || tag("content:encoded") || tag("content"));
    const date = new Date(clean(tag("pubDate") || tag("published") || tag("updated") || tag("dc:date")));
    if (!title || !link || isNaN(date)) continue;
    out.push({ title, link, desc: desc.slice(0, 700), date: date.toISOString(), source });
  }
  return out;
}

async function articleText(url) {
  try {
    const html = await get(url);
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(m[1])).filter((t) => t.length > 60);
    return paras.join("\n").slice(0, 7000);
  } catch { return ""; }
}

async function claude(prompt, maxTokens = 1200) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(90000),
      });
      if (r.ok) { const j = await r.json(); return j.content.map((c) => c.text || "").join(""); }
      const msg = `Claude ${r.status}: ${(await r.text()).slice(0, 300)}`;
      if (![429, 500, 502, 503, 529].includes(r.status) || attempt === 4) throw new Error(msg);
      console.log(`  busy, retrying (${msg.slice(0, 60)})`);
    } catch (e) {
      if (attempt === 4 || /Claude 4(0|1|3)/.test(e.message)) throw e;
      console.log(`  retrying after: ${e.message.slice(0, 80)}`);
    }
    await new Promise((res) => setTimeout(res, attempt * 8000));
  }
}
function json(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("AI reply was not complete JSON");
  return JSON.parse(text.slice(a, b + 1));
}
const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- main ----------
async function main() {
  if (!API_KEY) throw new Error("Missing ANTHROPIC_API_KEY secret.");
  const now = Date.now();
  const cutoff = now - DAYS * 864e5;

  let data = { updated: null, categories: {} };
  try { data = JSON.parse(await fs.readFile("news.json", "utf8")); } catch {}
  data.categories ||= {};

  // keep stories still inside the 7-day window
  for (const c of CATEGORIES) data.categories[c.id] = (data.categories[c.id] || []).filter((s) => Date.parse(s.date) >= cutoff);
  const usedLinks = new Set(), usedTitles = new Set();
  for (const list of Object.values(data.categories)) for (const s of list) { usedLinks.add(s.link); usedTitles.add(key(s.originalTitle || s.headline)); }

  for (const cat of CATEGORIES) {
    try {
      const existing = data.categories[cat.id];
      const since = existing.length ? Math.max(cutoff, now - 2 * 864e5) : cutoff;
      const want = existing.length ? DAILY_PICKS : BACKFILL_PICKS;

      let items = [];
      for (const f of cat.feeds) {
        try { items.push(...parseFeed(await get(f.url), f.source)); }
        catch (e) { console.log(`  feed skipped: ${e.message}`); }
      }
      const seen = new Set();
      items = items
        .filter((i) => Date.parse(i.date) >= since && Date.parse(i.date) <= now + 36e5)
        .filter((i) => !usedLinks.has(i.link) && !usedTitles.has(key(i.title)))
        .filter((i) => { const k = key(i.title); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 45);

      console.log(`${cat.name}: ${items.length} candidates`);
      if (!items.length) continue;

      const list = items.map((i, n) => `${n}. ${i.title} — ${i.desc.slice(0, 220)}`).join("\n");
      const pickText = await claude(
        `You choose news highlights for "The Last 7 Days of Learn...Wow! News", a family-friendly learning site for curious adults and kids.\n` +
        `Button: ${cat.name}. What belongs here: ${cat.guide}\n\n` +
        `Pick up to ${want} stories from the list that best fit this button and are the most significant or fascinating for a general national audience. ` +
        `Pick distinct stories (no two about the same thing). Skip local-only items, minor product promos, funding announcements, and anything graphic.\n\n` +
        `${list}\n\nReply with ONLY this JSON and nothing else, no explanation: {"picks":[numbers]}`, 800);
      let nums;
      try { nums = json(pickText).picks || []; }
      catch { const m = pickText.match(/"picks"\s*:\s*\[([^\]]*)/); nums = m ? m[1].split(",") : []; }
      const picks = [...new Set(nums.map((x) => parseInt(x, 10)))].filter((n) => items[n]).slice(0, want);
      console.log(`  picked ${picks.length}`);

      for (const n of picks) {
        const it = items[n];
        try {
        const body = await articleText(it.link);
        const out = json(await claude(
          `Write a news highlight for "The Last 7 Days of Learn...Wow! News" (${cat.name}). Readers are curious adults and families.\n\n` +
          `STRICT RULES:\n- Use ONLY facts found in the material below. Never add names, numbers, dates or claims that are not in it.\n` +
          `- Write in your own words. Do not copy sentences from the material.\n- Plain, friendly, clear language. Neutral tone. No hype.\n` +
          `- If the material is thin, write one paragraph instead of two.\n\n` +
          `Return JSON only:\n{"headline":"clear rewritten headline, under 14 words",` +
          `"summary":["paragraph 1 (3-4 sentences)","optional paragraph 2 (2-4 sentences)"],` +
          `"bigPicture":"one paragraph (3-4 sentences): why this matters and what it could lead to. Frame possibilities as possibilities, never as facts."}\n\n` +
          `MATERIAL\nTitle: ${it.title}\nSource: ${it.source}\nPublished: ${it.date}\nFeed summary: ${it.desc}\nArticle text:\n${body || "(not available — use the feed summary only)"}`,
          2000));
        if (!out.headline || !Array.isArray(out.summary) || !out.summary.length) continue;
        existing.push({
          id: `${cat.id}-${Date.parse(it.date)}-${n}`,
          headline: out.headline,
          summary: out.summary.filter(Boolean).slice(0, 2),
          bigPicture: out.bigPicture || "",
          source: it.source,
          date: it.date,
          link: it.link,
          originalTitle: it.title,
        });
        usedLinks.add(it.link); usedTitles.add(key(it.title));
        console.log(`  + ${out.headline}`);
        } catch (e) { console.log(`  story skipped: ${e.message.slice(0, 120)}`); }
      }
      existing.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    } catch (e) {
      console.log(`${cat.name} failed: ${e.message}`);
    }
  }

  data.updated = new Date().toISOString();
  await fs.writeFile("news.json", JSON.stringify(data, null, 1));
  console.log("news.json saved.");
}

main().catch((e) => { console.error(e); process.exit(1); });
