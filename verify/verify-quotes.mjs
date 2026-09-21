#!/usr/bin/env node
// Stoxess quote check (optional, needs YOUR OWN Databento key). Zero dependencies (Node 18+).
//
//   DATABENTO_API_KEY=db-... node verify-quotes.mjs export.json                 (sample of 5 fills)
//   DATABENTO_API_KEY=db-... node verify-quotes.mjs export.json --cost-only     (estimate, fetch nothing)
//   DATABENTO_API_KEY=db-... node verify-quotes.mjs export.json --sample 20 --max-cost 2
//   DATABENTO_API_KEY=db-... node verify-quotes.mjs export.json --all
//
// For each option fill in the ledger export, this looks up the REAL consolidated
// best bid/ask for that contract from Databento (OPRA, 1-minute) around the fill
// time, and checks two things:
//   1. the bid/ask stored on the fill were quotes that actually existed in the window
//      (the stored quote can be a few minutes old, so a 15-minute window is used);
//   2. the simulated fill price was achievable inside the real market in that window.
//
// COST: it always asks Databento for the price first and prints it. It will not
// download anything if the estimate is above --max-cost (default $0.50).
// Assigned-share and call-away fills carry no quote and are skipped.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "https://hist.databento.com/v0";
const WINDOW_BEFORE_MIN = 15;
const WINDOW_AFTER_MIN = 1;
const TOL = 0.02;   // dollars: 1-minute bars can miss intra-minute extremes

export function osiSymbol(underlying, expiry, isCall, strike) {
    const root = String(underlying).replace(/[.\-/]/g, "").toUpperCase().padEnd(6, " ");
    const yymmdd = expiry.slice(2, 4) + expiry.slice(5, 7) + expiry.slice(8, 10);
    const k = String(Math.round(Number(strike) * 1000)).padStart(8, "0");
    return `${root}${yymmdd}${isCall ? "C" : "P"}${k}`;
}

export function fillsToCheck(exp) {
    const out = [];
    for (const r of exp.ledger) {
        if (r.event_type !== "FILL") continue;
        const p = JSON.parse(r.payload_text);
        const f = p.fill, pos = p.position;
        if (!f || !pos || pos.kind === "STOCK" || pos.strike == null) continue;
        if (f.side !== "SELL_OPEN" && f.side !== "BUY_CLOSE") continue;
        if (f.ref_bid == null || f.ref_ask == null) continue;
        out.push({
            seq: Number(r.seq), side: f.side, filled_at: f.filled_at,
            fill_price: Number(f.fill_price), ref_bid: Number(f.ref_bid), ref_ask: Number(f.ref_ask),
            symbol: osiSymbol(pos.underlying, pos.expiry, pos.is_call, pos.strike),
            label: `${pos.underlying} ${pos.strike}${pos.is_call ? "C" : "P"} ${pos.expiry}`,
        });
    }
    return out;
}

// Deterministic spread-out sample so re-running checks the same fills.
export function pickSample(list, n) {
    if (n >= list.length) return list;
    const out = [];
    for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
    return out;
}

export function windowOf(filledAt) {
    const t = Date.parse(filledAt);
    return {
        start: new Date(t - WINDOW_BEFORE_MIN * 60_000).toISOString(),
        end: new Date(t + WINDOW_AFTER_MIN * 60_000).toISOString(),
    };
}

// rows: [{bid, ask}] real quotes in the window. Returns the verdict for one fill.
export function judge(fill, rows) {
    const q = rows.filter((r) => r.bid > 0 || r.ask > 0);
    if (q.length === 0) return { ok: null, note: "no quotes returned for that window" };
    const bids = q.map((r) => r.bid), asks = q.map((r) => r.ask);
    const minB = Math.min(...bids), maxB = Math.max(...bids), minA = Math.min(...asks), maxA = Math.max(...asks);
    const bidSeen = fill.ref_bid >= minB - TOL && fill.ref_bid <= maxB + TOL;
    const askSeen = fill.ref_ask >= minA - TOL && fill.ref_ask <= maxA + TOL;
    const achievable = fill.fill_price >= minB - TOL && fill.fill_price <= maxA + TOL;
    const ok = bidSeen && askSeen && achievable;
    return {
        ok, real: { bid: [minB, maxB], ask: [minA, maxA], samples: q.length },
        note: ok ? "stored quote existed in the window; fill price was inside the real market"
            : [!bidSeen && `stored bid ${fill.ref_bid} outside real ${minB}-${maxB}`,
               !askSeen && `stored ask ${fill.ref_ask} outside real ${minA}-${maxA}`,
               !achievable && `fill ${fill.fill_price} outside real ${minB}-${maxA}`].filter(Boolean).join("; "),
    };
}

export function parseCsvQuotes(csv) {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const head = lines[0].split(",");
    const bi = head.indexOf("bid_px_00"), ai = head.indexOf("ask_px_00");
    if (bi < 0 || ai < 0) return [];
    return lines.slice(1).map((l) => {
        const c = l.split(",");
        return { bid: Number(c[bi]), ask: Number(c[ai]) };
    }).filter((r) => Number.isFinite(r.bid) && Number.isFinite(r.ask));
}

function query(fill) {
    const w = windowOf(fill.filled_at);
    return {
        dataset: "OPRA.PILLAR", schema: "cbbo-1m", stype_in: "raw_symbol",
        symbols: fill.symbol, start: w.start, end: w.end,
    };
}

async function dbGet(path, key, params) {
    const res = await fetch(`${BASE}/${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") },
    });
    if (!res.ok) throw new Error(`Databento ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.text();
}
async function dbPost(path, key, params) {
    const res = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
    });
    if (!res.ok) throw new Error(`Databento ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.text();
}

async function main() {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--") && !/^\d/.test(a));
    const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
    if (!file) { console.error("usage: DATABENTO_API_KEY=... node verify-quotes.mjs <export.json> [--sample N | --all] [--cost-only] [--max-cost USD]"); process.exit(2); }
    const key = process.env.DATABENTO_API_KEY;
    if (!key) { console.error("Set DATABENTO_API_KEY to your own Databento key (this tool never uses anyone else's)."); process.exit(2); }

    const exp = JSON.parse(readFileSync(file, "utf8"));
    const all = fillsToCheck(exp);
    if (all.length === 0) { console.log("No option fills with stored quotes in this export yet."); return; }
    const chosen = args.includes("--all") ? all : pickSample(all, Number(opt("--sample", 5)));
    const maxCost = Number(opt("--max-cost", 0.5));

    console.log(`${all.length} option fills in the export; checking ${chosen.length}.`);
    let total = 0;
    for (const f of chosen) {
        f.cost = Number(await dbGet("metadata.get_cost", key, query(f)));
        if (!Number.isFinite(f.cost)) throw new Error(`could not read a cost estimate for ${f.label}`);
        total += f.cost;
    }
    console.log(`Estimated Databento cost: $${total.toFixed(4)} (limit $${maxCost.toFixed(2)})`);
    if (args.includes("--cost-only")) return;
    if (total > maxCost) { console.log("Estimate is above the limit, nothing downloaded. Raise --max-cost or check fewer fills."); process.exit(1); }

    let pass = 0, fail = 0, none = 0;
    for (const f of chosen) {
        const csv = await dbPost("timeseries.get_range", key, { ...query(f), encoding: "csv", pretty_px: "true", pretty_ts: "true", map_symbols: "true" });
        const v = judge(f, parseCsvQuotes(csv));
        if (v.ok === true) pass++; else if (v.ok === false) fail++; else none++;
        console.log(`${v.ok === true ? "PASS" : v.ok === false ? "FAIL" : "NONE"}  seq ${f.seq}  ${f.label}  ${f.side} @ ${f.fill_price}  stored ${f.ref_bid}/${f.ref_ask}` +
            (v.real ? `  real bid ${v.real.bid[0]}-${v.real.bid[1]} ask ${v.real.ask[0]}-${v.real.ask[1]} (${v.real.samples} bars)` : "") + `\n      ${v.note}`);
    }
    console.log(`\n${pass} passed, ${fail} failed, ${none} without data. Sampling checks only those fills; --all checks every one.`);
    process.exit(fail ? 1 : 0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
