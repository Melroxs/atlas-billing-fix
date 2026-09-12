#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Atlas — Paddle LIVE readiness check (safe, read-only, no payments)
//
// Run this where the Paddle environment variables are available, e.g.
//   PADDLE_ENVIRONMENT=live PADDLE_API_KEY=... node scripts/verify-paddle-live-readiness.mjs
//
// What it does:
//   - reports PRESENCE ONLY of every required variable (never values)
//   - checks the client token / environment prefix pair (live_ vs test_)
//   - checks that the six price ids look like Paddle price ids (pri_)
//   - when PADDLE_API_KEY is present: read-only GETs against api.paddle.com to
//     confirm the key works, each price exists/is active, its product exists,
//     and its amount matches Atlas pricing
//   - lists the live notification destinations (endpoint + subscribed events),
//     never their signing secrets
//   - fetches Paddle's current webhook sender IP ranges
//
// It never creates, edits, archives or deletes anything in Paddle, and never
// starts a checkout.
// ---------------------------------------------------------------------------

const EXPECTED = [
  ["PADDLE_STARTER_PRICE_ID_MONTHLY", 1000],
  ["PADDLE_STARTER_PRICE_ID_ANNUAL", 10000],
  ["PADDLE_GROWTH_PRICE_ID_MONTHLY", 4000],
  ["PADDLE_GROWTH_PRICE_ID_ANNUAL", 40000],
  ["PADDLE_SCALE_PRICE_ID_MONTHLY", 12000],
  ["PADDLE_SCALE_PRICE_ID_ANNUAL", 120000],
];

const problems = [];
const notes = [];

const env = (k) => process.env[k] ?? "";
const present = (k) => (env(k) ? "set" : "MISSING");

const environment = (env("PADDLE_ENVIRONMENT") || "sandbox").toLowerCase();
const isLive = environment === "live" || environment === "production";
const apiBase = isLive ? "https://api.paddle.com" : "https://api.sandbox.paddle.com";

console.log("=== Atlas Paddle readiness ===");
console.log(`PADDLE_ENVIRONMENT: ${environment} → API base ${apiBase}`);
if (!isLive) notes.push("PADDLE_ENVIRONMENT is not 'live': Atlas still targets Sandbox.");

for (const key of [
  "PADDLE_API_KEY",
  "PADDLE_CLIENT_TOKEN",
  "PADDLE_WEBHOOK_SECRET",
  "ATLAS_APP_URL",
  "PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST",
  ...EXPECTED.map(([k]) => k),
]) {
  const state = present(key);
  console.log(`${key}: ${state}`);
  if (state === "MISSING" && key !== "PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST") {
    problems.push(`${key} is not configured.`);
  }
}

// ---- client token / environment pairing ----
const token = env("PADDLE_CLIENT_TOKEN");
if (token) {
  const live = token.startsWith("live_");
  if (isLive && !live) problems.push("PADDLE_CLIENT_TOKEN does not start with live_ while running live.");
  if (!isLive && live) problems.push("PADDLE_CLIENT_TOKEN is a live_ token while running sandbox.");
}

// ---- ATLAS_APP_URL sanity ----
const appUrl = env("ATLAS_APP_URL");
if (appUrl && (/localhost|127\.0\.0\.1|\.lovable\.app|vercel\.app/i.test(appUrl) || !appUrl.startsWith("https://"))) {
  problems.push(`ATLAS_APP_URL (${appUrl}) is not a production https domain.`);
}

// ---- price id shape ----
for (const [key] of EXPECTED) {
  const v = env(key);
  if (v && !v.startsWith("pri_")) problems.push(`${key} does not look like a Paddle price id (pri_...).`);
}

// ---- read-only Paddle API checks ----
async function paddleGet(path) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${env("PADDLE_API_KEY")}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return body.data;
}

if (env("PADDLE_API_KEY")) {
  try {
    await paddleGet("/event-types");
    console.log("\nPaddle API key: authenticated OK");
  } catch (e) {
    problems.push(`Paddle API key rejected: ${e.message}`);
  }

  console.log("\n--- prices ---");
  for (const [key, expectedMinor] of EXPECTED) {
    const id = env(key);
    if (!id) continue;
    try {
      const price = await paddleGet(`/prices/${id}?include=product`);
      const amount = Number(price.unit_price?.amount);
      const okAmount = amount === expectedMinor;
      const okStatus = price.status === "active";
      console.log(
        `${key}: ${id} | ${price.unit_price?.currency_code} ${amount / 100} | ${price.status} | interval=${price.billing_cycle?.interval ?? "one-time"} | product=${price.product?.name ?? price.product_id}`,
      );
      if (!okAmount) problems.push(`${key} amount ${amount} does not match expected ${expectedMinor} minor units.`);
      if (!okStatus) problems.push(`${key} is not active in Paddle (status=${price.status}).`);
      if (price.billing_cycle?.interval !== (key.endsWith("ANNUAL") ? "year" : "month")) {
        problems.push(`${key} billing cycle is not the expected recurring interval.`);
      }
    } catch (e) {
      problems.push(`${key} (${id}) could not be read from Paddle: ${e.message}`);
    }
  }

  console.log("\n--- notification destinations (secrets never printed) ---");
  try {
    const dests = await paddleGet("/notification-settings");
    if (!dests?.length) problems.push("No Paddle notification destination exists in this environment.");
    for (const d of dests ?? []) {
      console.log(
        `${d.id} | ${d.description ?? "(no description)"} | ${d.destination} | active=${d.active} | events=${(d.subscribed_events ?? []).map((e) => e.name).join(",")}`,
      );
      if (appUrl && d.destination?.includes("localhost")) {
        problems.push(`Destination ${d.id} points at localhost.`);
      }
    }
  } catch (e) {
    problems.push(`Could not list notification destinations: ${e.message}`);
  }
} else {
  notes.push("PADDLE_API_KEY not present here: catalog, price and webhook-destination checks were skipped.");
}

// ---- webhook sender IP ranges (source of truth: Paddle) ----
try {
  const res = await fetch("https://api.paddle.com/ips", { headers: { Accept: "application/json" } });
  const body = await res.json();
  const ips = body?.data?.ipv4_cidrs ?? body?.data?.ips ?? [];
  console.log(`\nPaddle webhook sender ranges (${ips.length}): ${ips.join(", ")}`);
} catch (e) {
  notes.push(`Could not fetch https://api.paddle.com/ips: ${e.message}`);
}

console.log("\n=== RESULT ===");
if (problems.length === 0) {
  console.log("No blocking problems found.");
} else {
  for (const p of problems) console.log(`BLOCKER: ${p}`);
}
for (const n of notes) console.log(`NOTE: ${n}`);
process.exit(problems.length === 0 ? 0 : 1);
