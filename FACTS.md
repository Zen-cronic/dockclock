# FACTS: every README claim and its evidence

Status key:
- **live (phone)**: observed on deployed AWS, driven from a real phone.
- **live (operator)**: a real person acted on a real phone (for example the approval tap) on a load whose driver messages were synthetic.
- **live (integration)**: run on deployed AWS with synthetic driver messages (`SMOKE-` loads); the workflow, agent, SES, KMS and S3 calls are real, and email goes to our test mailbox.
- **live (eval)**: real Bedrock calls on fictional inputs.
- **tested**: covered by an automated test or CI.
- **sourced**: cited from a published source.
- **planned**: not built yet.

## The number
| Claim | Evidence | Status |
|---|---|---|
| On 24 test loads the contracts owe $1,245.00; DockClock would claim $1,245.00 (100%) with 9 claims, all valid, 0 owed claims held back | `npm run scorecard` (`packages/clause-engine/src/scorecard.ts`); fixtures `fixtures/loads.json`, sha256 `d45ae579e3be6ba4a649754f0cefeee8d7f97f4f7e45a9852a224aff1c66c403`; the CLI exits non-zero on any mismatch; CI runs it | tested |
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
| Dispatch template, Arrived → location request → pin, Released → pin, camera-only BOL Flow, photo stored and hashed, KMS-signed pack under Object Lock | Live load `LIVE-mve0rrez` (2026-10-18). The pack signature verifies with the KMS public key, and the photo's sha256 matches the pack | live (phone) |
| Templates approved in en_US, es_MX and fr_CA | `list-whatsapp-message-templates` read 2026-10-18 18:20 EDT: all 9 DockClock templates (3 names × 3 languages) APPROVED. Only en_US has been sent live | live (integration) |
| Duplicate, out-of-order and stale taps are refused | `services/test/lifecycle.test.ts`; `npm run smoke:lifecycle` on the deployed stack | tested + live (integration) |
| A failed send is replayed, not lost | `services/test/ingest.test.ts` ("replays a send that failed…") | tested |
| STOP/START honoured; no message without a recorded opt-in | `services/test/ingest.test.ts`, `services/test/dispatch.test.ts` | tested |
| "Talk to dispatch" answers the driver and emails dispatch through Amazon SES | Driver reply on load `LIVE-mvbtt0wb` (2026-10-16 23:22 EDT); dispatch escalation email sent by SES on load `SMOKE-mve0mtkb` (2026-10-18 12:04 EDT); `services/src/escalate.ts` | live (phone) + live (integration) |
| A tampered pack fails verification | `packages/evidence/test/evidence.test.ts`; `npm run smoke:lifecycle` | tested + live (integration) |
| Pre-filled times left unchanged are not counted as independent proof | `packages/evidence/test/evidence.test.ts`, `services/test/seal.test.ts` | tested |
| BSUID senders matched to the dispatched driver | `services/test/identity.test.ts`; live loads 2026-10-16/18 | tested + live (phone) |

## The agent
| Claim | Evidence | Status |
|---|---|---|
| Claims agent runs on Bedrock AgentCore Harness with Claude Sonnet 4.5; its tools come only through an AgentCore Gateway with a Cedar policy engine in ENFORCE mode | `infra/lib/agent-stack.ts`; deployed stack `DockClockAgent` (2026-10-18); `infra/test/stacks.test.ts` | live (integration) |
| The agent reviewed a real load: read evidence, read the photo, reported it "not legible" instead of guessing | `npm run agent:run -- LIVE-mve0rrez review` (2026-10-18, 19 s, tools get_load_evidence + read_bill_of_lading) | live (phone) |
| Bill-of-lading reading: 26 of 26 fields correct on 7 fictional rendered test photos (incl. 12-hour times, missing out time, unsigned, dim/angled, blurry) | `npm run bol:photos && npm run eval:bol` | live (eval) |
| Without dispatch approval the agent does not file | `npm run agent:run -- SMOKE-mve2mb0j file_claim` before approval (2026-10-18) | live (integration) |
| With approval it filed the claim by SES from claims@claims.kaungzinhein.com with the signed pack attached, copying the sealed amount ($90.98) and digest exactly | Load `SMOKE-mve2mb0j` after `npm run approve:load` (CLI test approval); email received in our test mailbox 2026-10-18 13:00 EDT | live (integration) |
| After sealing, the workflow asks dispatch on WhatsApp, waits for the tap, runs the agent and then checks the claim record itself | Load `SMOKE-mve8yfv3` (2026-10-18): approval template sent 15:57:36 EDT; operator tapped Approve on a real phone 15:58:03 EDT; claim email from claims@claims.kaungzinhein.com 15:58:17 EDT; execution ended in "Claim filed". Driver messages synthetic | live (operator) |
| Only the dispatcher's number, with the open request's nonce, can approve, once; Hold fails the waiting task | `services/test/approval.test.ts` | tested |
| Claim amounts reach Cedar as integer cents (0 < amount ≤ $5,000) | `packages/agent/src/definitions.ts`; `packages/agent/test/agent.test.ts` | tested |
| A second filing for the same load is refused | Second `file_claim` run refused; the tool reserves the claim before calling SES and keeps the reservation once SES accepts (`packages/agent/src/tools.ts`). This is our own guard; we do not claim exactly-once delivery from the email provider | live (integration) + tested |
| The claim tool refuses a different amount, a different digest, no approval, an unsealed or non-billable load | `packages/agent/test/agent.test.ts` | tested |
| The claim email is a fixed template filled from the sealed pack: plain text and HTML (no images, no tracking), a one-page PDF claim summary (`detention-claim-<load>.pdf`) and the signed pack attached, and the public key linked rather than attached. The agent writes only the opening sentence, which must state the sealed amount and the load id. No key ARN or account id appears in the body or the PDF | `packages/agent/src/claim-email.ts`, `packages/agent/src/claim-pdf.ts`; `packages/agent/test/claim-email.test.ts`, `packages/agent/test/tools.test.ts`. Not yet sent live | tested |
| The detention notice names the source of the check-in time from the record: a synthetic test pin on a test load, "the demo yard accepts any location" on the judge demo, and "inside the facility's geofence" only when the pin was checked inside | `services/src/notice.ts`, `packages/mail/src/wording.ts`; `services/test/notice.test.ts` | tested |

## Notice, retake and the judge path
| Claim | Evidence | Status |
|---|---|---|
| After the Arrived pin, a one-time EventBridge Scheduler job is created to fire the clause's lead time plus 10 minutes before free time ends, or one minute after scheduling when that moment has already passed (as on the 5-minute judge demo, where the notice goes out about 4 minutes before free time ends) | Load `SMOKE-mveb2qnf` (2026-10-18): schedule `notice-SMOKE-mveb2qnf` created; `services/test/notice.test.ts` | live (integration) + tested |
| The notice is emailed to the counterparty by SES, the SES delivery event is recorded, and the sealed pack carries the notice | Same load: sent 16:56:44 EDT, delivered 16:56:45 EDT (`npm run smoke:lifecycle` with `SMOKE_NOTICE=1`); delivered means SES's delivery event for our test mailbox | live (integration) |
| No notice once the truck is released; never emailed twice | `services/test/notice.test.ts` | tested |
| An unreadable photo gets one request for a clearer one, naming the minutes left and a zone-labelled time; with no new photo within 10 minutes on a demo load (an hour otherwise) the original seals; a replay after the deadline sends nothing | `services/src/retake.ts`, workflow states `Photo readable?` → `Ask for a clearer photo` → `Await retake`; `services/test/retake.test.ts`, `services/test/notice.test.ts` (retake step), `infra/test/stacks.test.ts` | tested |
| Texting DEMO starts a capped demo load in which the sender drives and approves; daily limits per number and overall | `services/src/demo.ts`; `services/test/demo.test.ts`, `services/test/approval.test.ts` | tested |
| Drivers are told the contract's verdict and, after filing, the amount and pack digest | `services/src/outcome.ts`; `services/test/demo.test.ts` | tested |

## RCS
| Claim | Evidence | Status |
|---|---|---|
| RCS driver loop on a real phone | Load `LIVE-mve1ve6d` (2026-10-18): dispatch card delivered 12:38:58 EDT; Arrived 12:52:43, arrival pin 12:54:00, Released 12:54:06, release pin 12:54:16, BOL photo 12:54:41 EDT, all over RCS; photo hashed; sealed NEEDS_HUMAN (pins outside the facility) | live (phone) |
| Once-only failover from a failed WhatsApp send to RCS | `services/test/failover.test.ts`; `npm run smoke:rcs` (synthetic events) | tested + live (integration) |

## Judge desk and its records
| Claim | Evidence | Status |
|---|---|---|
| Every WhatsApp and RCS message DockClock composes, including the dispatcher approval request, is recorded in the load's partition (`SEND#`) with its channel, purpose, template, rendered text and typed buttons, chips and Flow call to action, and no recipient, phone, BSUID or button payload; a message the send gates stopped (a test number, replies off, STOP) is recorded as not sent with the reason | `services/src/outbound.ts`, `services/src/sender.ts`; `services/test/outbound.test.ts`. Not-sent records live on test loads `SMOKE-mvh34j51` and `SMOKE-RCS-mvh32fui` (2026-10-20); an accepted send still needs a real-phone load | live (integration) + tested |
| The detention notice and the claim email are kept byte for byte (raw MIME) next to the load's packs under S3 Object Lock, and the notice and claim records point at them | Load `SMOKE-mvh1bmmu` (2026-10-20): `notice.eml` and `claim.eml`, Object Lock GOVERNANCE to 2026-11-19; `services/test/notice.test.ts`, `packages/agent/test/tools.test.ts` | live (integration) + tested |
| Every claims-agent run, from the workflow or the CLI, is recorded under its load (`AGENT#`) with ordered tool calls, key results, final text, model and duration, including a run that refused because dispatch had not approved | Same load: one refused `file_claim` run (no approval), then a filed one with the SES message id; `packages/agent/src/invoke.ts`; `packages/agent/test/invoke.test.ts` | live (integration) + tested |
| Sealed packs carry message ids as short sha256 references, never a raw WhatsApp id (which encodes the sender's phone number) | Same load's pack; `packages/evidence/test/evidence.test.ts`; `docs/evidence/README.md` | live (integration) + tested |
| The judge desk is a static page on CloudFront (HTTPS, private S3 origin with origin access control) | Stack `DockClockDesk`, `infra/lib/desk-stack.ts`; `infra/test/stacks.test.ts`; https://d3djuoqhg6b8o2.cloudfront.net (2026-10-20) | live (integration) + tested |
| A load's replay file is exported with no coordinates, phone numbers, BSUIDs, message ids, ARNs, account id or S3 keys, its engine inputs reproduce the sealed verdict, and it type-checks against the page's contract | `npm run desk:snapshot -- <loadId>` (`scripts/desk-snapshot.ts`); `test/desk-snapshot.test.ts` | tested |
| Dispatch escalation emails are recorded on their load with the driver's contact removed (a test load's as not sent), and SES delivery or bounce is recorded for the claim and escalation emails as well as the notice | `services/src/escalate.ts`, `services/src/notice.ts`; `services/test/escalate.test.ts`. Live: escalation records on `SMOKE-mvh34j51`; claim email delivery recorded on `SMOKE-RCS-mvh32fui` | live (integration) + tested |
| An RCS-only driver load runs end to end: rich-card dispatch, Arrived and Released chips, location shares, a bill-of-lading photo the agent's tool read correctly, a sealed BILLABLE verdict and a claim filed by the agent | Load `SMOKE-RCS-mvh32fui` (2026-10-20, synthetic RCS events, rendered fictional BOL from `npm run bol:photos`, CLI test approval); `scripts/smoke-rcs.ts` | live (integration) |
| A failed WhatsApp dispatch switches the load to RCS once, and the load completes on RCS; an unreadable photo is reported not legible | Loads `SMOKE-RCS-mvh338l2` (2026-10-20) and `SMOKE-RCS-mvldfuyu` (2026-10-23, the failed WhatsApp receipt kept), both `SMOKE_RCS_START=whatsapp` | live (integration) |
| The console read API lists only demo-workspace loads (a sparse `byWorkspace` index set at dispatch for judge, test and flagged operator loads; 20 test loads backfilled), answers 404 for any other load, strips photo metadata, serves only photos the evidence path accepted, refuses non-images, and sends no response that fails the leak check | Live at https://d3djuoqhg6b8o2.cloudfront.net/api/ (stack `DockClockDesk`, 2026-10-20): `npm run api:check` passed on every route of 25 loads, operator load `LIVE-mve0rrez` answered 404; `services/api/handler.ts`, `infra/lib/read-api.ts`; `services/test/api.test.ts`, `infra/test/read-api.test.ts` | live (integration) + tested |
| Real-time test loads on the judge-demo clause, nothing backdated, through to a filed claim: WhatsApp `SMOKE-DEMO-mvh3xsdv` and RCS `SMOKE-DEMO-mvh3xsdq` (8 minutes at the dock, notice emailed about a minute after arrival and delivered, sealed BILLABLE $3.07, filed by the agent after a CLI test approval, claim email delivered); the WhatsApp one was followed through the deployed API from waiting for arrival to claim filed | `npm run smoke:demo -- whatsapp|rcs` (`scripts/smoke-demo.ts`), `npm run api:watch` with API_BASE (2026-10-20). Driver messages synthetic; the RCS photo is a rendered fictional BOL | live (integration) |
| The console fixtures are the read API's own responses on recorded loads and type-check against the contract | `npm run api:fixtures`; `test/api-fixtures.test.ts` | tested |

## Not built yet
| Claim | Status |
|---|---|
| Dispute replies | planned |
| Live phone runs of the photo retake and the judge path | planned |
| A judge-desk replay of a load driven from a real phone (needed for recorded outbound message text) | planned |
| Demo video | planned |
