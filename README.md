# idl-drift

GitHub Action that diffs a committed Anchor IDL file against the on-chain IDL
account of a Solana program and reports drift, or flags programs that never
published an on-chain IDL at all.

**Live: the [Solana IDL Drift Ledger](https://auroraxo.github.io/idl-drift/ledger/)** ([source table](./ledger/README.md)) — daily scheduled
runs over a curated set of top Anchor programs, results committed as a
browsable table of real findings (drift, legacy drift, missing on-chain IDL).

Two concrete problems it catches:

1. **Drift.** A program was redeployed and the on-chain IDL account was bumped
   (new instructions, new accounts, new types, version field changed) but the
   committed IDL JSON in the repo was not regenerated. Existing JS/TS clients
   keep calling the stale layout until something breaks. When drift is found,
   the report names the exact entries — e.g. `instructions.swap: changed`,
   `accounts: 14 entries committed vs 16 on-chain` — not just "IDLs differ".
2. **Silence.** A program that publishes IDL-less updates has no upstream
   signal at all. `marinade-ts-sdk` and `jup-ag/rfq-webhook-toolkit` both
   shipped committed IDLs with **null** on-chain IDL accounts on mainnet as
   of October 2026 — neither is a candidate for diff, but both are
   candidates for a "no on-chain IDL" report.

## Use

```yaml
- uses: auroraxo/idl-drift@v1
  with:
    program: MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD
    idl: src/programs/idl/json/marinade_finance.json
    rpc-url: mainnet
    fail-on-drift: true
    fail-on-missing: false
```

Inputs:

- `program` (required) — Solana program id whose IDL account should be checked.
- `idl` (required) — path to the committed IDL JSON file, relative to `$GITHUB_WORKSPACE`.
- `rpc-url` (optional, default `https://api.mainnet-beta.solana.com`) — full
  JSON-RPC URL, or the alias `mainnet` / `devnet`.
- `fail-on-drift` (default `true`) — exit non-zero when committed and on-chain
  IDL differ.
- `fail-on-missing` (default `false`) — exit non-zero when the program has no
  published on-chain IDL account.
- `fail-on-legacy-drift` (default `false`) — exit non-zero when BOTH the
  canonical metadata account and the legacy Anchor `anchor:idl` account
  exist, the canonical is in sync with the committed IDL, but the legacy
  account has rotted. Report-only by default so a stale legacy publication
  surfaces in the step summary without breaking a schedule.

Exit codes:

- `0` — no rot found, or all checks were unresolvable (safe to run on a
  schedule, mirrors the docrot-check unresolvable policy).
- `2` — rot found and the relevant fail flag is on.
- `3` — usage / IO error (committed IDL unreadable, etc.).

A JSON report is always written to `idl-drift-report.json` in the workspace
and a step summary table is rendered for the workflow log.

## Two diff sites, not one

A Solana program that has ever been upgraded with `anchor idl init` has a
legacy `anchor:idl` account at `Pubkey::create_with_seed(PDA([]),
"anchor:idl", program)` in addition to the canonical Program Metadata
`idl` PDA. Anchor 1.0+ writes only the canonical one, but the legacy
account is *not* closed — it stays on chain carrying whatever IDL was
last published to it.

Consequence: the canonical account can be perfectly in sync with the
committed IDL while the legacy account silently carries a stale layout.
Real mainnet case (Whirlpool, 2026-10-19): canonical IDL account
`9fQgUeE2BpGXLHopvZhDKTskXV2druezgX6hpmscbya5` agrees with the
published SDK IDL; legacy `anchor:idl` account
`2KFqE4RWoPVbvodo8vbggCFeHPS8TDvgpwp79ALMrcyn` reports
`instructions.close_bundled_position: changed` and the metadata account's
no-drift answer is technically true but misses the real signal.

`idl-drift` now diffs both accounts when both are present. The canonical
diff keeps its current failure semantics; the legacy diff is report-only
by default (`fail-on-legacy-drift: false`) and surfaces as a step-summary
warning + `legacy_idl_drift` rot kind in the JSON report, so a single
`schedule:` job stays green while the stale publication becomes visible
to humans.

## Proof it works — this repo checks itself

`auroraxo/idl-drift` dogfoods the action against a real mainnet program:
[`.github/workflows/dogfood.yml`](.github/workflows/dogfood.yml) runs the
local checkout against the committed real Marinade IDL
(`testdata/marinade_finance.json`, program
`MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`, on-chain IDL account
`9jWC3EixD3D7ChMrrSRw3opnGHQ8YxZGJqGkzcup3tAn`) on every push to
`src/`/`testdata/` plus a weekly schedule.

- Latest dogfood run: https://github.com/auroraxo/idl-drift/actions/runs/39065611799 — `no rot detected`, exit 0, report artifact uploaded.
- Real-repo usage examples for two programs with committed IDLs: [`examples/marinade.yml`](examples/marinade.yml) and [`examples/whirlpool.yml`](examples/whirlpool.yml) (the Whirlpool example fetches the published SDK IDL from the npm CDN, the way a consumer would).
- Both examples are also exercised in CI by [`.github/workflows/examples.yml`](.github/workflows/examples.yml) on every push to `examples/`/`src/` plus a weekly schedule, against live mainnet — latest run: https://github.com/auroraxo/idl-drift/actions/runs/39074838554 (both legs green).

Copy the dogfood pattern into your own repo with the Quickstart above —
the only required inputs are a program id and a path to the IDL JSON you
already commit.

## Local development

```
npm test
```

The test driver (`test/run.mjs`) does not hit the network. It builds a
synthetic RPC response by Base64-encoding the committed IDL into a plausible
on-chain IDL account payload, feeds it through the entrypoint's RPC client
shim, and asserts the diff outcome. Coverage:

- canonical metadata account, no drift, uncompressed + zlib
- canonical metadata account, version drift, instruction drift
- both accounts present, metadata wins, legacy drift (fail-on-legacy-drift
  true / false), both in sync
- legacy-only, missing (fail-on-missing true / false)
- docs-stripping when on-chain IDL has no `docs`
- address-derivation vectors cross-checked against `solana
  find-program-derived-address` and `solana create-address-with-seed`

## Related

- [`auroraxo/declare-id-drift`](https://github.com/auroraxo/declare-id-drift) —
  source-side companion. Pure-file four-way check (`declare_id!` ↔
  `Anchor.toml` ↔ IDL `address` ↔ deployed keypair), no RPC, so it runs on
  every PR without credentials. Together the two cover both directions of IDL
  consistency: source-to-source and source-to-chain.

## License

MIT
