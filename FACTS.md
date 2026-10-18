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

## The agent
| Claim | Evidence | Status |
|---|---|---|
| Claims agent runs on Bedrock AgentCore Harness with Claude Sonnet 4.5; its tools come only through an AgentCore Gateway with a Cedar policy engine in ENFORCE mode | `infra/lib/agent-stack.ts`; deployed stack `DockClockAgent` (2026-10-18); `infra/test/stacks.test.ts` | live |
| The agent reviewed a real load: read evidence, read the photo, reported it "not legible" instead of guessing | `npm run agent:run -- LIVE-mve0rrez review` (2026-10-18, 19 s, tools get_load_evidence + read_bill_of_lading) | live |
| Bill-of-lading reading: 26 of 26 fields correct on 7 fictional rendered test photos (incl. 12-hour times, missing out time, unsigned, dim/angled, blurry) | `npm run bol:photos && npm run eval:bol` | live |
| Without dispatch approval the agent does not file | `npm run agent:run -- SMOKE-mve2mb0j file_claim` before approval (2026-10-18) | live |
| With approval it filed the claim by SES from claims@claims.kaungzinhein.com with the signed pack attached, copying the sealed amount ($90.98) and digest exactly | Load `SMOKE-mve2mb0j` after `npm run approve:load` (CLI test approval); email received 2026-10-18 13:00 EDT | live |
| After sealing, the workflow asks dispatch on WhatsApp, waits for the tap, runs the agent and then checks the claim record itself | Load `SMOKE-mve8yfv3` (2026-10-18): approval template sent 15:57:36 EDT; operator tapped Approve on a real phone 15:58:03 EDT; claim email from claims@claims.kaungzinhein.com 15:58:17 EDT; execution ended in "Claim filed" | live |
| Only the dispatcher's number, with the open request's nonce, can approve, once; Hold fails the waiting task | `services/test/approval.test.ts` | tested |
| Claim amounts reach Cedar as integer cents (0 < amount ≤ $5,000) | `packages/agent/src/definitions.ts`; `packages/agent/test/agent.test.ts` | tested |
| A claim is never sent twice | Second `file_claim` run stopped; tool reserves the claim before sending (`packages/agent/src/tools.ts`) | live + tested |
| The claim tool refuses a different amount, a different digest, no approval, an unsealed or non-billable load | `packages/agent/test/agent.test.ts` | tested |

## RCS
| Claim | Evidence | Status |
|---|---|---|
| RCS driver loop and once-only failover from a failed WhatsApp send | `packages/rcs`, `services/src/rcs.ts`, `npm run smoke:rcs`; live round trip on load `LIVE-mve1ve6d` (2026-10-18) | live |

## Not built yet
| Claim | Status |
|---|---|
| Detention notice by SES before free time ends | planned |
| Photo retake request when the bill of lading is unreadable | planned |
| Dispute replies | planned |
| Judge self-service try-it path; architecture diagram; demo video | planned |
