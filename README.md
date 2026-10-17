# idl-drift

GitHub Action that diffs a committed Anchor IDL file against the on-chain IDL
account of a Solana program and reports drift, or flags programs that never
published an on-chain IDL at all.

Two concrete problems it catches:

1. **Drift.** A program was redeployed and the on-chain IDL account was bumped
   (new instructions, new accounts, new types, version field changed) but the
   committed IDL JSON in the repo was not regenerated. Existing JS/TS clients
   keep calling the stale layout until something breaks.
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

Exit codes:

- `0` — no rot found, or all checks were unresolvable (safe to run on a
  schedule, mirrors the docrot-check unresolvable policy).
- `2` — rot found and the relevant fail flag is on.
- `3` — usage / IO error (committed IDL unreadable, etc.).

A JSON report is always written to `idl-drift-report.json` in the workspace
and a step summary table is rendered for the workflow log.

## Local development

```
npm test
```

The test driver (`test/run.mjs`) does not hit the network. It builds a
synthetic RPC response by Base64-encoding the committed IDL into a plausible
on-chain IDL account payload, feeds it through the entrypoint's RPC client
shim, and asserts the diff outcome.

## License

MIT
