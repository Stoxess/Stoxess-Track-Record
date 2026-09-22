#!/usr/bin/env node
// Stoxess track-record verifier. Zero dependencies (Node 18+).
//
//   node verify-track-record.mjs stoxess-track-record-export.json
//   node verify-track-record.mjs export.json --offline     (skip the GitHub checks)
//
// Checks
//   A1  hash chain: every entry's hash recomputes from its own contents, links to
//       the previous entry, and seq has no gaps.
//   A2  arithmetic: between consecutive end-of-day records, cash, realized P&L and
//       unrealized P&L recompute from the recorded fills, closes and marks, and
//       NAV = starting cash + realized + unrealized.
//   A3  anchors: each anchored head hash matches the ledger, the anchor file in the
//       public GitHub repo says the same thing, and the timestamp proof exists.
//
// Not covered: whether a simulated fill would have executed in the real market,
// and anything before the ledger's first entry ("verified since"). Tamper-evident,
// not tamper-proof.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const num = (x) => (x == null ? 0 : Number(x));
const close = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

export function entryHash(r) {
    return sha256hex([
        r.prev_hash, String(r.seq), r.event_type, r.agent_id ?? "",
        r.code_version ?? "", r.rules_version ?? "", r.event_at_text, r.payload_text,
    ].join("\n"));
}

// ── A1 ──────────────────────────────────────────────────────────────
export function checkChain(ledger) {
    const bad = [];
    let prev = null, redacted = 0;
    for (const r of ledger) {
        if (prev === null) {
            if (Number(r.seq) !== 1 || r.prev_hash !== "0".repeat(64)) bad.push(`seq ${r.seq}: bad first link`);
        } else {
            if (Number(r.seq) !== Number(prev.seq) + 1) bad.push(`seq ${r.seq}: gap or reorder after ${prev.seq}`);
            if (r.prev_hash !== prev.hash) bad.push(`seq ${r.seq}: prev_hash does not match previous entry`);
        }
        // A redacted entry (a strategy-describing DECISION/GENESIS) had its text removed from
        // the export, so its own hash cannot be recomputed; its links to both neighbours are
        // still checked above and below, and the anchored head hashes cover it (A3).
        // Only these types may be redacted; a redacted flag on a FILL, CLOSE, EOD_MARKS etc. is ignored.
        if (r.redacted && ["DECISION", "CONFIG", "GENESIS"].includes(r.event_type)) redacted++;
        else if (entryHash(r) !== r.hash) bad.push(`seq ${r.seq}: hash does not match contents (edited?)`);
        try { JSON.parse(r.payload_text); } catch { bad.push(`seq ${r.seq}: payload is not valid JSON`); }
        prev = r;
    }
    return {
        id: "A1", name: "Hash chain intact", ok: bad.length === 0,
        detail: bad.length ? bad.slice(0, 10).join("; ")
            : redacted === 0 ? `${ledger.length} entries, chain recomputes end to end`
            : `${ledger.length} entries: ${ledger.length - redacted} recompute from their contents, ${redacted} are redacted (strategy detail withheld) and are checked for their links only; the chain is unbroken end to end`,
    };
}

// ── A2 ──────────────────────────────────────────────────────────────
export function checkArithmetic(exp) {
    const ev = exp.ledger.map((r) => ({ ...r, p: JSON.parse(r.payload_text), seq: Number(r.seq) }));
    const genesis = ev.find((e) => e.event_type === "GENESIS");
    const notes = [];
    const problems = [];
    if (!genesis) return { id: "A2", name: "Arithmetic reproduces", ok: false, detail: "no GENESIS entry" };

    const startCash = {};
    for (const a of genesis.p.agents ?? []) startCash[a.id] = num(a.starting_cash);

    const edited = ev.filter((e) => ["FILL_UPDATE", "FILL_DELETE", "POSITION_UPDATE", "POSITION_DELETE"].includes(e.event_type));
    if (edited.length) notes.push(`${edited.length} edit/delete entries present (${[...new Set(edited.map((e) => e.event_type))].join(", ")}) - listed, not hidden`);

    // Position facts known from the ledger (positions opened before the ledger started are not).
    const posOpen = new Map();
    for (const e of ev) if (e.event_type === "POSITION" && e.p.position) posOpen.set(e.p.position.id, e.p.position);

    const eods = ev.filter((e) => e.event_type === "EOD_MARKS");
    const byAgent = new Map();
    for (const e of eods) { if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []); byAgent.get(e.agent_id).push(e); }

    let compared = 0, marksChecked = 0, marksSkipped = 0;
    for (const [agent, list] of byAgent) {
        const sc = startCash[agent];
        if (sc == null) { problems.push(`${agent}: starting cash not in GENESIS`); continue; }
        list.sort((a, b) => a.seq - b.seq);

        for (let k = 0; k < list.length; k++) {
            const e = list[k];
            const nav = e.p.nav;
            const date = e.p.nav_date;

            // NAV identity and return%
            const u = num(nav.unrealized_pnl), r = num(nav.realized_pnl_cum);
            if (!close(num(nav.nav), sc + r + u)) problems.push(`${agent} ${date}: NAV ${nav.nav} != start ${sc} + realized ${r} + unrealized ${u}`);
            if (!close(num(nav.return_pct), Math.round(10000 * (u + r) / sc) / 100, 0.011)) problems.push(`${agent} ${date}: return% ${nav.return_pct} does not match`);

            // Unrealized = marks of positions still open at the date + assigned stock at its recorded price.
            const closedByDate = new Set(
                ev.filter((c) => c.event_type === "CLOSE" && c.agent_id === agent && c.seq < e.seq &&
                    String(c.p.position?.closed_at ?? "").slice(0, 10) <= date).map((c) => c.p.position.id));
            let uSum = 0;
            for (const m of e.p.marks ?? []) {
                if (closedByDate.has(m.position_id)) continue;
                uSum += num(m.unrealized_pnl);
                const pos = posOpen.get(m.position_id);
                if (pos && m.mid != null) {
                    marksChecked++;
                    const exp2 = (num(pos.open_fill_price) - num(m.mid)) * num(pos.contracts) * 100;
                    if (!close(num(m.unrealized_pnl), exp2, 0.06)) problems.push(`${agent} ${date}: mark on ${pos.underlying} ${pos.strike}: unrealized ${m.unrealized_pnl} != (${pos.open_fill_price} - ${m.mid}) x ${pos.contracts} x 100`);
                } else marksSkipped++;
            }
            for (const s of e.p.stock_prices ?? []) if (s.price != null) uSum += (num(s.price) - num(s.cost)) * num(s.shares);
            if (!close(uSum, u, 0.06)) problems.push(`${agent} ${date}: unrealized ${u} != sum of recorded marks and stock prices ${uSum.toFixed(2)}`);

            // Changes since the previous day's record: cash from fills, realized from closes.
            if (k > 0) {
                const prevE = list[k - 1];
                let cashFlow = 0, realized = 0;
                for (const x of ev) {
                    if (x.agent_id !== agent || x.seq <= prevE.seq || x.seq > e.seq) continue;
                    if (x.event_type === "FILL") {
                        const f = x.p.fill;
                        const amt = num(f.fill_price) * num(f.contracts) * 100;
                        cashFlow += (f.side === "SELL_OPEN" || f.side === "CALL_AWAY") ? amt : -amt;
                    } else if (x.event_type === "CLOSE") realized += num(x.p.position.realized_pnl);
                }
                if (!close(num(nav.cash) - num(prevE.p.nav.cash), cashFlow)) problems.push(`${agent} ${date}: cash moved ${(num(nav.cash) - num(prevE.p.nav.cash)).toFixed(2)} but fills sum to ${cashFlow.toFixed(2)}`);
                if (!close(num(nav.realized_pnl_cum) - num(prevE.p.nav.realized_pnl_cum), realized)) problems.push(`${agent} ${date}: realized moved ${(num(nav.realized_pnl_cum) - num(prevE.p.nav.realized_pnl_cum)).toFixed(2)} but closes sum to ${realized.toFixed(2)}`);
                compared++;
            }
        }
    }

    // The reported NAV table must equal the last snapshot the ledger holds for that agent/date.
    const lastSnap = new Map();
    for (const e of ev) if (e.event_type === "NAV_SNAPSHOT" && e.p.row) lastSnap.set(`${e.agent_id}|${e.p.row.nav_date}`, e.p.row);
    let navRows = 0;
    for (const row of exp.nav ?? []) {
        const snap = lastSnap.get(`${row.agent_id}|${row.nav_date}`);
        if (!snap) continue;                       // dates from before the ledger began
        navRows++;
        for (const f of ["cash", "unrealized_pnl", "realized_pnl_cum", "nav", "return_pct"]) {
            if (!close(num(row[f]), num(snap[f]), 0.0051)) problems.push(`reported NAV ${row.agent_id} ${row.nav_date}: ${f} ${row[f]} differs from the ledger's ${snap[f]}`);
        }
    }

    notes.push(`${eods.length} end-of-day records, ${compared} day-to-day cash/realized comparisons, ${marksChecked} marks recomputed (${marksSkipped} on positions opened before the ledger, not checkable), ${navRows} reported NAV rows matched`);
    if (eods.length === 0) notes.push("no end-of-day records yet, nothing to recompute");
    return { id: "A2", name: "Arithmetic reproduces", ok: problems.length === 0, detail: problems.length ? problems.slice(0, 10).join("; ") : notes.join("; "), notes };
}

// ── A3 ──────────────────────────────────────────────────────────────
const BITCOIN_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

export async function checkAnchors(exp, { fetchBytes, offline }) {
    const problems = [], notes = [];
    const bySeq = new Map(exp.ledger.map((r) => [Number(r.seq), r]));
    const anchors = exp.anchors ?? [];
    if (anchors.length === 0) return { id: "A3", name: "Anchors match", ok: true, detail: "no anchors recorded yet", pending: true };

    let latest = 0;
    for (const a of anchors) {
        const seq = Number(a.head_seq);
        latest = Math.max(latest, seq);
        const r = bySeq.get(seq);
        if (!r) problems.push(`anchor for seq ${seq}: that entry is missing from the ledger (truncated?)`);
        else if (r.hash !== a.head_hash) problems.push(`anchor for seq ${seq}: hash ${a.head_hash.slice(0, 12)}... differs from the ledger's ${r.hash.slice(0, 12)}...`);
    }
    if (exp.ledger.length && latest > Number(exp.ledger[exp.ledger.length - 1].seq)) problems.push(`latest anchor (seq ${latest}) is beyond the end of the ledger`);

    if (!offline) {
        const repo = exp.github_repo;
        const gh = anchors.filter((a) => a.method === "github" && a.proof);
        let confirmed = 0, pending = 0, unreachable = 0, tsrOk = 0, tsrNone = 0;
        for (const a of gh) {
            const seq = Number(a.head_seq);
            const raw = await fetchBytes(`https://raw.githubusercontent.com/${repo}/main/${a.proof}`);
            if (!raw) { unreachable++; problems.push(`could not read ${a.proof} from the public repo`); continue; }
            let f; try { f = JSON.parse(raw.toString("utf8")); } catch { problems.push(`${a.proof}: not valid JSON`); continue; }
            const r = bySeq.get(seq);
            if (r && (Number(f.head_seq) !== seq || f.head_hash !== r.hash)) problems.push(`${a.proof}: public copy says seq ${f.head_seq} / ${String(f.head_hash).slice(0, 12)}..., ledger says ${r.hash.slice(0, 12)}...`);
            const ref = exp.ledger.find((x) => x.event_type === "ANCHOR_REF" && JSON.parse(x.payload_text).head_seq === seq);
            if (ref && JSON.parse(ref.payload_text).anchor_file_sha256 !== sha256hex(raw.toString("utf8"))) problems.push(`${a.proof}: file contents differ from the hash the ledger recorded`);
            const ots = await fetchBytes(`https://raw.githubusercontent.com/${repo}/main/${a.proof}.ots`);
            if (!ots) problems.push(`${a.proof}.ots: timestamp proof missing`);
            else if (ots.includes(BITCOIN_TAG)) confirmed++; else pending++;
            const tsr = await fetchBytes(`https://raw.githubusercontent.com/${repo}/main/${a.proof}.tsr`);
            if (!tsr) tsrNone++;
            else if (tsr.includes(createHash("sha256").update(raw).digest())) tsrOk++;
            else problems.push(`${a.proof}.tsr: the RFC 3161 token does not contain this anchor file's SHA-256`);
        }
        notes.push(`${gh.length} public anchor files read (${unreachable} unreachable); timestamp proofs: ${confirmed} carry a Bitcoin attestation, ${pending} still pending`);
        notes.push(`RFC 3161 signed timestamps: ${tsrOk} present and matching, ${tsrNone} none (anchors made before it was added have none)`);
        if (tsrOk > 0) notes.push("to check a signature: openssl ts -verify -data <anchor>.json -in <anchor>.json.tsr -CAfile <trusted roots>");
        if (confirmed > 0) notes.push("to independently confirm a proof against Bitcoin, run the OpenTimestamps client:  ots verify <anchor>.json.ots");
    } else notes.push("GitHub checks skipped (--offline)");

    return { id: "A3", name: "Anchors match", ok: problems.length === 0, detail: problems.length ? problems.slice(0, 10).join("; ") : `${anchors.length} anchor records agree with the ledger; ${notes.join("; ")}`, notes };
}

export async function verifyExport(exp, opts = {}) {
    const checks = [checkChain(exp.ledger), checkArithmetic(exp), await checkAnchors(exp, opts)];
    return { ok: checks.every((c) => c.ok), checks };
}

// ── CLI ─────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) { console.error("usage: node verify-track-record.mjs <export.json> [--offline]"); process.exit(2); }
    const exp = JSON.parse(readFileSync(file, "utf8"));
    const fetchBytes = async (url) => {
        try { const r = await fetch(url); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; }
    };
    const res = await verifyExport(exp, { fetchBytes, offline: args.includes("--offline") });
    const first = exp.ledger[0];
    console.log(`Stoxess track record - ledger starts ${first?.event_at_text ?? "?"}, ${exp.ledger.length} entries. Earlier history is unverified.\n`);
    for (const c of res.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.id}  ${c.name}\n      ${c.detail}`);
    console.log(`\n${res.ok ? "All checks passed." : "VERIFICATION FAILED."}  (Tamper-evident, not tamper-proof; simulated fills are not proof of real-market execution.)`);
    process.exit(res.ok ? 0 : 1);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
