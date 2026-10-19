# Solana IDL Drift Ledger

Live check: for each program below, the committed/published Anchor IDL
(npm or GitHub source) is diffed against the program's **on-chain IDL
account** on mainnet, using [auroraxo/idl-drift](../README.md).
This is the raw material: every row here was produced by a real check,
not copied from a report.

| program | address | status | drift detail |
| --- | --- | --- | --- |
| [marinade-finance](https://github.com/marinade-finance/marinade-ts-sdk) | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | ✅ in sync | no drift |
| [marinade-referral](https://github.com/marinade-finance/marinade-ts-sdk) | `MR2LqxoSbw831bNy68utpu5n4YqBH3AzDmddkgk9LQv` | 🔴 drift | `version`, `types`, `errors` |
| [whirlpool](https://github.com/orca-so/whirlpools) | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | 🟡 legacy drift | `instructions`.close_bundled_position |
| [staking-options](https://github.com/DualFinance/staking-options) | `4yx1NJ4Vqf2zT1oVLk4SySBhhDJXmXFt88ncm4gPxtL7` | ⚪ no on-chain IDL | no on-chain IDL account at metadata HARmBTYrLaJHySxWQKdAigNWUPGpkAxoTmRP3sb98qSh or anchor 39zsr5NmGQjNjb4hCT1Ka1PssyXM8Q1rtRzsUkEdE85K |
| [raydium-clmm](https://github.com/raydium-io/raydium-idl) | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | 🔴 drift | `instructions`, `accounts`, `types`, `errors` |
| [kamino-lending](https://github.com/Kamino-Finance/klend) | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` | 🔴 drift | `version`, `name`, `instructions`, `accounts`, `types`, `errors` |
| [drift](https://github.com/drift-labs/protocol-v2) | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` | 🔴 drift | `instructions`, `accounts`, `types`, `errors` |

_Last run: 2026-10-19T21:37:41.555Z — 1 in sync, 5 drifting, 1 without on-chain IDL, 0 errors._

## Provenance

- Workflow: [`.github/workflows/ledger.yml`](../blob/master/.github/workflows/ledger.yml)
- Program list: [`ledger/programs.json`](./programs.json)
- Findings corroborated by external review: [MarinadeFinance/marinade-ts-sdk#111](https://github.com/MarinadeFinance/marinade-ts-sdk/issues/111)
