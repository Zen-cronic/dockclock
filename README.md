# DockClock

**Truck detention pay, claimed exactly as the contract owes it, with proof captured on the driver's WhatsApp.**

> **On 24 test loads the contracts owe $1,245.00 in detention. DockClock claims $1,245.00 of it (100%) and nothing a contract denies: 9 claims, all 9 valid, 0 owed claims held back. The common "bill every stop over 2 hours" rule asks for $2,554.18, and $1,314.18 of that (51%) is denied by the contract, more than the clause pays, or unprovable.**
> Recompute it: `npm run scorecard` (fixtures frozen at sha256 `d45ae579…`).

## The problem, in one paragraph
When a shipper keeps a truck waiting at the dock past the free time (usually 2 hours), the carrier is owed **detention** pay. That pay is written into a clause of each load's rate confirmation. Most of it is never collected. US truckload carriers are paid on only **55% of the detention invoices they send**, and ATRI estimates **$5,103.95 of unreimbursed detention per truckload driver per year**. That is about **$204,000 a year for a carrier with 40 truckload drivers** (ATRI, *Costs and Consequences of Truck Driver Detention*, 2024; survey estimates). Claims are lost for reasons the contract spells out: the carrier
- did not send notice before detention started,
- filed after the claim window closed,
- had no signed bill of lading with in and out times,
- arrived late for the appointment, or
- had no shipper confirmation.

Carriers also skip billing because they expect to be refused and don't want to damage the account.

## Who is in the story
| Role | Who | Real or fictional |
|---|---|---|
| **Harmed** | A small trucking carrier and its driver, who sat at the dock unpaid | Fictional 40-truck US dry-van carrier |
| **Owes the money** | The broker or shipper, under the detention clause of the load's rate confirmation | Five fictional counterparties. Their clauses are modelled on published shipper and broker terms; each source and every assumed value is labelled in [`clauses.ts`](packages/clause-engine/src/clauses.ts) |
| **Buys DockClock** | A freight factoring company. It already advances carriers' invoices and is paid when the broker pays, so a provable detention claim becomes collectable receivable | Fictional. This is our target customer, not a signed one |

## What DockClock does
1. **Dispatch.** The carrier sends the load to the driver as a WhatsApp utility template with an **Arrived** button, in English, Spanish or Québécois French.
2. **Arrival proof.** The driver taps Arrived at the dock. DockClock sends a WhatsApp **location request**, and the pin (with WhatsApp's server timestamp) is checked against the facility's geofence.
3. **Release proof.** The driver taps **Released** and shares a second pin. A two-screen **WhatsApp Flow** asks for:
   - a **camera-only** photo of the bill of lading;
   - the in and out times written on it;
   - whether the receiver signed it;
   - the reason for the delay.
4. **Sealed evidence.** Every photo is downloaded into S3 and hashed. The evidence pack is signed with an AWS KMS key and stored under S3 Object Lock, so anyone with the public key can check it later.
5. **The contract decides, not the model.** A deterministic clause engine returns `BILLABLE`, `NOT_BILLABLE` (with the clause's reason) or `NEEDS_HUMAN`. Pre-filled times the driver left unchanged do not count as independent proof.
6. **Dispatch approves on WhatsApp.** A BILLABLE load sends the dispatcher the `dockclock_dispatch_approval` template. Only the dispatcher's number, with that request's nonce, can approve, and only once. **Hold** stops the claim; no answer in two days hands it to a person.
7. **The agent files the claim.** A Bedrock AgentCore agent reads the bill-of-lading photo before sealing, then, once dispatch approves, writes the claim email to the broker or shipper and sends it with Amazon SES, attaching the signed pack. It can only call DockClock's tools through an AgentCore Gateway, where Cedar policies allow the claim tool only with an approval and an amount under a cap. The tool then refuses unless the amount and pack digest equal the sealed values, so a prompt cannot change the money.

## What works today, and what is still being built
We'll tell you before you find it. Every line below is traced to a test, a file or a live run in [`FACTS.md`](FACTS.md).

| Works today (proven) | Being built before the 2026-10-24 freeze |
|---|---|
| Steps 1–5 above, run live on a real phone over AWS End User Messaging Social (load `LIVE-mve0rrez`) | The **detention notice** emailed by SES before free time ends (several clauses require it) |
| **The whole money loop, automatic after sealing:** the dispatcher gets a WhatsApp approval template, taps **Approve claim**, and the AgentCore agent files the claim by SES with the signed pack; the workflow then reads the claim record itself before it reports success (load `SMOKE-mve8yfv3`: tap to email in 14 seconds) | Asking the driver for a clearer photo when the bill of lading is unreadable |
| A **Bedrock AgentCore** claims agent (Harness + Gateway) bounded by Cedar policies and a code gate on the sealed amount and digest; it refuses without an approval and never files twice | Replies to disputes |
| Bill-of-lading reading: **26 of 26 fields correct** on 7 fictional test photos, and an honest "not legible" on a real blurry phone photo; the reading is part of the signed evidence | A way for judges to try it themselves; the architecture diagram |
| **RCS** for drivers without WhatsApp and as failover when a WhatsApp send fails (live round trip on a real phone, load `LIVE-mve1ve6d`) | |
| Duplicate, out-of-order and stale taps refused; STOP/START honoured; "Talk to dispatch" emails a person; a tampered pack fails verification; about 150 automated tests | |

Today the scorecard measures the clause engine on 24 hand-labelled test loads. Its truth column was written by us from each clause's text, so it is a consistency check, not field data.

## How we use AWS End User Messaging Social (WhatsApp)
| WhatsApp feature | Its job in DockClock |
|---|---|
| Utility template with quick-reply buttons (`dockclock_load_dispatch`, 3 languages) | Opens the conversation for each load; the buttons carry the load id and that load's nonce, so a tap cannot act on another load |
| Location request messages | Server-timestamped arrival and release pins, checked against a geofence |
| WhatsApp Flow with a camera-only PhotoPicker | Captures the bill of lading in a way a gallery photo cannot replace |
| Media download (`GetWhatsAppMessageMedia`) to S3 | Keeps our own copy of each photo, hashed and locked |
| Delivery and read receipts | Recorded against each send, as proof that a message reached the driver |
| Business-scoped user IDs (BSUID) | Drivers stay matched when WhatsApp reports a BSUID instead of a phone number |
| Opt-in record and STOP/START | No message without a recorded opt-in; STOP stops every message |
| Utility template with Approve / Hold buttons (`dockclock_dispatch_approval`) | The dispatcher's one-tap decision that releases the claim; it resumes the waiting Step Functions workflow |

Per load this is **2 utility templates (driver dispatch, dispatcher approval) plus about 5 messages inside the free 24-hour window**, and 1 SES email for the claim (2 once the notice is built).

## Run it
```bash
npm ci
npm test            # about 150 tests
npm run scorecard   # recomputes the headline above
```
Deploying to your own AWS account (CDK) needs an existing WhatsApp Business Account linked to AWS End User Messaging Social; see `.env.example`.

## License
[MIT](LICENSE)
