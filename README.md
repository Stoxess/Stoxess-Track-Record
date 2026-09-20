# Stoxess Track Record

Public, tamper-evident timestamps for the **AI: Auto Income** paper-trading record at [stoxess.com](https://www.stoxess.com).

> **Simulated trading only. No real money, no real orders.** Results are hypothetical and are not a promise of future results.

## Status

**Not live yet.** The ledger this repo anchors is still being built. When it starts, its start date will be recorded here as the **"verified since"** date. Everything before that date is unverified and will be labeled that way on the site.

## What this repo will hold

- `anchors/` — one small file per anchor: the date, the ledger's latest sequence number, and its head hash. Hashes only. No trades, no picks, nothing about how picks are chosen.
- `anchors/*.ots` — an [OpenTimestamps](https://opentimestamps.org) proof for each anchor file, backed by the Bitcoin blockchain.
- `verify/` — an open script anyone can run to recheck the ledger against these anchors. (Coming with the verification step.)

## How it works

1. Every decision, fill, close, and daily NAV is written to an append-only ledger. Each entry includes the hash of the one before it, so changing any past entry breaks every entry after it.
2. Several times a day the ledger's head hash is written to `anchors/` here and stamped with OpenTimestamps. GitHub records when each push arrived, and the Bitcoin-backed proof shows the hash existed before a specific block.
3. Later, the ledger can be revealed and checked: it must hash to an anchored value, and the arithmetic (cash, NAV, returns) must reproduce from the fills.

## What this can and cannot show

Can show: nothing was edited or deleted after the fact, decisions existed before outcomes were known, and the numbers are arithmetically consistent.

Cannot show: that a paper fill would have executed in the real market, or anything from before the "verified since" date.

This is **tamper-evident**, not tamper-proof. The proof comes from independent copies (Bitcoin, GitHub's public event archive, mirrors), not from trusting Stoxess.

## Checking an anchor yourself

1. Take an anchor file and its `.ots` proof.
2. Drop both into [opentimestamps.org](https://opentimestamps.org) (or use the command-line client with a Bitcoin node).
3. It confirms the file existed before the stated Bitcoin block.
