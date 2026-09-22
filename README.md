# Stoxess Track Record

Public, tamper-evident timestamps for the **AI: Auto Income** paper-trading record at [stoxess.com](https://www.stoxess.com).

> **Simulated trading only. No real money, no real orders.** Results are hypothetical and are not a promise of future results.

## Status

**Live.** The ledger started on **2026-09-21** (its "verified since" date). Everything before that date is unverified and labeled that way on the site. Anchors are added here automatically on trading days.

## What this repo holds

- `anchors/` — one small file per anchor: the date, the ledger's latest sequence number, and its head hash. Hashes only. No trades, no picks, nothing about how picks are chosen.
- `anchors/*.ots` — an [OpenTimestamps](https://opentimestamps.org) proof for each anchor file, backed by the Bitcoin blockchain.
- `verify/verify-track-record.mjs` — an open, zero-dependency script that rechecks a downloaded ledger export: the hash chain, the cash/P&L/NAV arithmetic, and these anchors.

## How it works

1. Every decision, fill, close, and daily NAV is written to an append-only ledger. Each entry includes the hash of the one before it, so changing any past entry breaks every entry after it.
2. Several times a day the ledger's head hash is written to `anchors/` here and stamped with OpenTimestamps. GitHub records when each push arrived, and the Bitcoin-backed proof shows the hash existed before a specific block.
3. Later, the ledger can be revealed and checked: it must hash to an anchored value, and the arithmetic (cash, NAV, returns) must reproduce from the fills.

## What this can and cannot show

Can show: nothing was edited or deleted after the fact, decisions existed before outcomes were known, and the numbers are arithmetically consistent.

Cannot show: that a paper fill would have executed in the real market, or anything from before the "verified since" date.

This is **tamper-evident**, not tamper-proof. The proof comes from independent copies (Bitcoin, GitHub's public event archive, mirrors), not from trusting Stoxess.

## Verifying the record yourself

1. On stoxess.com/app/income/paper (signed in), use **Download verification bundle**. It is one JSON file with the full ledger.
2. Run the verifier (Node 18+, nothing to install):

   ```
   node verify/verify-track-record.mjs stoxess-track-record-export.json
   ```

   It prints PASS/FAIL for three checks: **A1** the hash chain recomputes with no gaps or edits (entries that describe how the agents choose trades are exported as generic `redacted` stubs: their links to the neighbouring entries and the anchored hashes are still checked, but their own contents are withheld, and the output says how many), **A2** cash, realized and unrealized P&L and NAV recompute from the recorded fills, closes and marks, **A3** every anchored head hash matches the ledger and the anchor files in this repo.
3. Optional: check that the simulated fills were realistic. `verify/verify-quotes.mjs` looks up the real historical bid/ask for each option fill from Databento (needs your own Databento key), prints the cost estimate first, and refuses to download above a limit:

   ```
   DATABENTO_API_KEY=... node verify/verify-quotes.mjs stoxess-track-record-export.json --cost-only
   DATABENTO_API_KEY=... node verify/verify-quotes.mjs stoxess-track-record-export.json --sample 10
   ```

4. To check a timestamp proof against Bitcoin directly, use the [OpenTimestamps client](https://github.com/opentimestamps/opentimestamps-client): `ots verify anchors/<date>/<file>.json.ots`, or drop the `.json` and `.ots` files into [opentimestamps.org](https://opentimestamps.org). Each anchor also gets an RFC 3161 signed timestamp from a public timestamp authority (`.tsr` file, immediate): `openssl ts -verify -data anchors/<date>/<file>.json -in anchors/<date>/<file>.json.tsr -CAfile <trusted roots>`. An OpenTimestamps proof shows as pending until Bitcoin confirms it (usually within hours), then this repo upgrades it automatically.
