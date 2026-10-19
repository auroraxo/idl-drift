# Solana IDL Drift Ledger

Live check: for each program below, the committed/published Anchor IDL
(npm or GitHub source) is diffed against the program's **on-chain IDL
account** on mainnet, using [auroraxo/idl-drift](../README.md).
This is the raw material: every row here was produced by a real check,
not copied from a report.

| program | address | status | drift detail |
| --- | --- | --- | --- |
| [marinade-finance](https://github.com/marinade-finance/marinade-ts-sdk) | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | ⚠️ error | exit 3 parse=ENOENT: no such file or directory, open '/tmp/idl-drift-ledger-8n0geU/idl-drift-report.json' |
| [marinade-referral](https://github.com/marinade-finance/marinade-ts-sdk) | `MR2LqxoSbw831bNy68utpu5n4YqBH3AzDmddkgk9LQv` | ⚠️ error | exit 3 parse=ENOENT: no such file or directory, open '/tmp/idl-drift-ledger-8n0geU/idl-drift-report.json' |
| [whirlpool](https://github.com/orca-so/whirlpools) | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | ⚠️ error | exit 3 parse=ENOENT: no such file or directory, open '/tmp/idl-drift-ledger-8n0geU/idl-drift-report.json' |
| [staking-options](https://github.com/DualFinance/staking-options) | `4yx1NJ4Vqf2zT1oVLk4SySBhhDJXmXFt88ncm4gPxtL7` | ⚠️ error | exit 3 parse=ENOENT: no such file or directory, open '/tmp/idl-drift-ledger-8n0geU/idl-drift-report.json' |

_Last run: 2026-10-19T20:13:54.923Z — 0 in sync, 0 drifting, 0 without on-chain IDL, 4 errors._

## Provenance

- Workflow: [`.github/workflows/ledger.yml`](../blob/master/.github/workflows/ledger.yml)
- Program list: [`ledger/programs.json`](./programs.json)
- Findings corroborated by external review: [MarinadeFinance/marinade-ts-sdk#111](https://github.com/MarinadeFinance/marinade-ts-sdk/issues/111)
