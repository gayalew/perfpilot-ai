// Phase 0 check: tests every key and account PerfPilot AI needs.
// Run with:  node --env-file=.env check-env.mjs
// Needs Node 20.6 or newer. For the database check, install the driver first:  npm install pg
// The Resend check lists domains, so it needs a full-access API key (not a sending-only key).

const env = process.env;
const results = [];

async function check(name, required, fn) {
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    results.push({
      name,
      status: "missing",
      detail: `set ${missing.join(", ")} in .env`,
    });
    return;
  }
  try {
    results.push({ name, status: "ok", detail: await fn() });
  } catch (err) {
    results.push({ name, status: "fail", detail: err.message });
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

function fail(res, text) {
  throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
}

// Node version
const major = Number(process.versions.node.split(".")[0]);
results.push({
  name: "Node.js",
  status: major >= 20 ? "ok" : "fail",
  detail: `v${process.versions.node}${major >= 20 ? "" : " (need 20 or newer)"}`,
});

// Gemini
await check("Gemini API", ["GEMINI_API_KEY"], async () => {
  const headers = {
    "content-type": "application/json",
    "x-goog-api-key": env.GEMINI_API_KEY,
  };
  const listRes = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { headers },
  );
  const { data: list, text: listText } = await readJson(listRes);
  if (!listRes.ok) fail(listRes, listText);
  const names = (list.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace("models/", ""))
    .filter(
      (n) => /flash/.test(n) && !/(image|tts|live|audio|robotics)/.test(n),
    );
  const model =
    env.GEMINI_MODEL || names.find((n) => /lite/.test(n)) || names[0];
  if (!model) throw new Error("no Flash model found for this key");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Reply with the single word: ok" }] }],
      }),
    },
  );
  const { data, text } = await readJson(res);
  if (!res.ok) fail(res, text);
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return `${model} replied: ${reply}. Flash models on your key: ${names.slice(0, 8).join(", ")}`;
});

// PageSpeed Insights
await check("PageSpeed Insights API", ["GOOGLE_API_KEY"], async () => {
  const url = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
  );
  url.search = new URLSearchParams({
    url: "https://example.com",
    strategy: "mobile",
    category: "performance",
    key: env.GOOGLE_API_KEY,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  const { data, text } = await readJson(res);
  if (!res.ok) fail(res, text);
  const score = Math.round(
    data.lighthouseResult.categories.performance.score * 100,
  );
  return `example.com mobile performance score: ${score}`;
});

// Chrome UX Report
await check("Chrome UX Report API", ["GOOGLE_API_KEY"], async () => {
  const res = await fetch(
    `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${env.GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://web.dev" }),
    },
  );
  const { text } = await readJson(res);
  if (res.status === 404) return "key works (no field data for that origin)";
  if (!res.ok) fail(res, text);
  return "returned field data for web.dev";
});

// GitHub
const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "perfpilot-setup-check",
    },
  });

await check(
  "GitHub token and repository",
  ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"],
  async () => {
    const repoPath = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    const repoRes = await gh(repoPath);
    const { data: repo, text } = await readJson(repoRes);
    if (!repoRes.ok) fail(repoRes, text);
    const actionsRes = await gh(`${repoPath}/actions/workflows`);
    const { text: actionsText } = await readJson(actionsRes);
    if (!actionsRes.ok)
      fail(
        actionsRes,
        `Actions access is missing on the token: ${actionsText}`,
      );
    const visibility = repo.private
      ? "PRIVATE (make it public for free Actions minutes)"
      : "public";
    return `${repo.full_name} is ${visibility}; Actions readable`;
  },
);

// Telegram
await check("Telegram bot", ["TELEGRAM_BOT_TOKEN"], async () => {
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const me = await readJson(await fetch(`${base}/getMe`));
  if (!me.data?.ok) throw new Error(me.text.slice(0, 200));
  const bot = `@${me.data.result.username}`;
  if (!env.TELEGRAM_CHAT_ID) {
    const updates = await readJson(await fetch(`${base}/getUpdates`));
    const chat = updates.data?.result
      ?.map((u) => u.message?.chat)
      .find(Boolean);
    return chat
      ? `${bot} works. Your chat id is ${chat.id}; put it in TELEGRAM_CHAT_ID`
      : `${bot} works. Send any message to the bot, then run this again to find your chat id`;
  }
  const sent = await readJson(
    await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: "PerfPilot setup check: Telegram works",
      }),
    }),
  );
  if (!sent.data?.ok) throw new Error(sent.text.slice(0, 200));
  return `${bot} sent you a test message`;
});

// Resend
await check("Resend", ["RESEND_API_KEY"], async () => {
  const res = await fetch("https://api.resend.com/domains", {
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  const { data, text } = await readJson(res);
  if (!res.ok) fail(res, text);
  const domains = data?.data ?? [];
  if (!domains.length)
    return "key works, but no domain added yet (needed to email other people)";
  return domains.map((d) => `${d.name}: ${d.status}`).join(", ");
});

// Neon
await check("Neon database", ["DATABASE_URL"], async () => {
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("install the driver first: npm install pg");
  }
  const Client = pg.default?.Client ?? pg.Client;
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query("select version() as v");
    return result.rows[0].v.split(" ").slice(0, 2).join(" ");
  } finally {
    await client.end();
  }
});

const icon = { ok: "✅", fail: "❌", missing: "⚠️ " };
for (const r of results)
  console.log(`${icon[r.status]} ${r.name}: ${r.detail}`);
const needAttention = results.filter((r) => r.status !== "ok").length;
console.log(
  needAttention
    ? `\n${needAttention} item(s) need attention.`
    : "\nAll checks passed. Phase 0 is done.",
);
process.exit(needAttention ? 1 : 0);
