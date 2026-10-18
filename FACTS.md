# FACTS: every README claim and its evidence

Status key:
- **live** — observed on deployed AWS with a real phone.
- **tested** — covered by an automated test or CI.
- **sourced** — cited from a published source.
- **planned** — not built yet.

## The number
| Claim | Evidence | Status |
|---|---|---|
| On 24 test loads the contracts owe $1,245.00; DockClock claims $1,245.00 (100%) with 9 claims, all valid, 0 owed claims held back | `npm run scorecard` (`packages/clause-engine/src/scorecard.ts`); fixtures `fixtures/loads.json`, sha256 `d45ae579e3be6ba4a649754f0cefeee8d7f97f4f7e45a9852a224aff1c66c403`; the CLI exits non-zero on any mismatch; CI runs it | tested |
| The 2-hour rule asks for $2,554.18; $1,314.18 (51%) is denied, more than the clause pays, or unprovable | Same run: `baseline.claimedUsd`, `baseline.uncollectibleUsd` (deniable $800.01 + more than the clause pays $226.67 + unprovable $287.50) | tested |
| The truth column is hand-labelled by us, so this is a consistency check, not field data | `packages/clause-engine/src/fixtures.ts` | stated limit |

## The problem
| Claim | Evidence | Status |
|---|---|---|
| US truckload carriers are paid on 55% of detention invoices | ATRI, *Costs and Consequences of Truck Driver Detention* (2024), p.23 (survey) | sourced |
| $5,103.95 unreimbursed detention per truckload driver per year | ATRI 2024 (survey estimate) | sourced |
| About $204,000 a year for a carrier with 40 truckload drivers | 40 × $5,103.95, derived from ATRI 2024 | derived |
| Carriers skip billing because they expect refusal and fear damaging the account | ATRI 2024 | sourced |
| Claims are denied for missing or late notice, an expired window, no signed BOL times, late arrival, no shipper confirmation | Reason codes in `packages/clause-engine/src/evaluate.ts`, modelled on published terms cited per clause in `clauses.ts` | tested |

## What works today
| Claim | Evidence | Status |
|---|---|---|
| Dispatch template, Arrived → location request → pin, Released → pin, camera-only BOL Flow, photo stored and hashed, KMS-signed pack under Object Lock | Live load `LIVE-mve0rrez` (2026-10-18). The pack signature verifies with the KMS public key, and the photo's sha256 matches the pack | live |
| Templates approved in en_US, es_MX and fr_CA | `list-whatsapp-message-templates`: all 9 APPROVED, 2026-10-16. Only en_US has been sent live | live (en_US) |
| Duplicate, out-of-order and stale taps are refused | `services/test/lifecycle.test.ts`; `npm run smoke:lifecycle` on the deployed stack | tested + live |
| A failed send is replayed, not lost | `services/test/ingest.test.ts` ("replays a send that failed…") | tested |
| STOP/START honoured; no message without a recorded opt-in | `services/test/ingest.test.ts`, `services/test/dispatch.test.ts` | tested |
| "Talk to dispatch" emails a person through Amazon SES | `services/src/escalate.ts`; live SES send 2026-10-18 | live |
| A tampered pack fails verification | `packages/evidence/test/evidence.test.ts`; `npm run smoke:lifecycle` | tested + live |
| Pre-filled times left unchanged are not counted as independent proof | `packages/evidence/test/evidence.test.ts`, `services/test/seal.test.ts` | tested |
| BSUID senders matched to the dispatched driver | `services/test/identity.test.ts`; live loads 2026-10-16/18 | tested + live |

## Not built yet
| Claim | Status |
|---|---|
| Bedrock AgentCore agent (Harness + Gateway) reads the BOL photo and drafts the claim | planned |
| Detention notice by SES before free time ends | planned |
| Dispatcher approval on WhatsApp → claim emailed to the broker → dispute replies | planned |
| RCS for drivers without WhatsApp | in progress |
| Judge self-service try-it path; architecture diagram; demo video | planned |
