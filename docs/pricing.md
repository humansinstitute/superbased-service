# SuperBased Pricing (v1 Draft)

Status: Draft
Last updated: 2026-02-21

## 1. Pricing Goal

SuperBased pricing should primarily reflect:
- Retained storage footprint (including version history)
- Liveness/operational overhead

In v1, pricing is quoted in USD and billed by logical live records grouped into payload-size classes.

## 1.1 Headline Rate

Headline planning rate for v1:
- **~$0.002 per MB-month retained** (about **$2 per GB-month retained**)

This is the simple top-line price signal. Class pricing below maps this into per-`10,000` live-record bands.

## 2. Retention Model Assumption

Each logical record may retain up to:
- 1 live row
- 20 historical rows

Maximum retained versions per logical record: `21`.

## 3. Sizing Assumptions

For planning and pricing estimation, v1 uses:
- Average metadata overhead per versioned row: `~0.8 KB`
- Retained versions per logical record: `21`
- Effective storage multiplier (indexes, TOAST, bloat, backups): `~2.5x`

Estimation formula:

```text
retained_per_record_kb ~= 21 * (payload_kb + 0.8) * 2.5
```

## 4. v1 USD Pricing Table

All rates below are monthly prices per `10,000` live logical records.

| Class | Avg payload per version | Approx retained size per 10k live records | Price per 10k per month (USD) |
|---|---:|---:|---:|
| Small | `<= 2 KB` | `~1.4 GB` | `$3` |
| Medium | `> 2 KB` to `10 KB` | `~5.4 GB` | `$10` |
| Large | `> 10 KB` to `40 KB` | `~20.4 GB` | `$30` |
| XL | `> 40 KB` | custom | Custom |

## 5. Scaling Rule

To estimate monthly cost:
- Determine each tenant's average payload class
- Count live logical records
- Multiply proportionally from the `10,000` baseline

Example:
- `100,000` medium records -> `10 * $10 = $100/month`

## 6. Write Churn Guardrail

To prevent extreme high-churn workloads from underpaying:
- Include up to `500,000` writes per month
- Charge `$0.20` per additional `100,000` writes

This can be revised after observing real traffic and storage growth.

## 7. Notes

- v1 is USD-denominated for clarity; sat/credit conversion can be layered on top later.
- Class assignment should be computed from encrypted payload byte size at write time.
- Tenants can be reclassified monthly using rolling average payload size.
