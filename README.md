# DockClock

**Truck detention pay, claimed exactly as the contract owes it, with proof captured on the driver's WhatsApp.**

> **On 24 test loads the contracts owe $1,245.00 in detention. DockClock would claim $1,245.00 of it (100%) and nothing a contract denies: 9 claims, all 9 valid, 0 owed claims held back. The common "bill every stop over 2 hours" rule asks for $2,554.18, and $1,314.18 of that (51%) is denied by the contract, more than the clause pays, or unprovable.**
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
We'll tell you before you find it. Every line below is traced to a test, a file or a run in [`FACTS.md`](FACTS.md). Load ids say what kind of run it was: `LIVE-` loads were driven from a real phone; `SMOKE-` loads replay synthetic driver messages through the deployed stack, so everything after the phone (workflow, agent, SES, KMS) is real.

| Works today (proven) | Being built before the 2026-10-24 freeze |
|---|---|
| Steps 1–5 above, run live on a real phone over AWS End User Messaging Social (load `LIVE-mve0rrez`) | Replies to disputes |
| **The whole money loop, automatic after sealing:** the dispatcher gets a WhatsApp approval template, taps **Approve claim**, and the AgentCore agent files the claim by SES with the signed pack; the workflow then reads the claim record itself before it reports success (load `SMOKE-mve8yfv3`: synthetic driver messages, a real approval template and tap on the operator's phone, and the claim emailed by SES to our test mailbox 14 seconds after the tap) | A live phone run of the photo retake and of the judge try-it path (both built and tested) |
| **The detention notice:** EventBridge Scheduler fires before free time ends, SES emails the broker or shipper, the delivery event is recorded, and the sealed pack carries the notice, so clauses that require notice can pay (load `SMOKE-mveb2qnf`, synthetic driver messages: SES reported delivery to our test mailbox 0.7 s after sending) | |
| A **Bedrock AgentCore** claims agent (Harness + Gateway) bounded by Cedar policies and a code gate on the sealed amount and digest; it refuses without an approval, and a second filing for the same load is refused (the claim is reserved before SES is called) | |
| Bill-of-lading reading: **26 of 26 fields correct** on 7 fictional test photos, and an honest "not legible" on a real blurry phone photo; the reading is part of the signed evidence. An unreadable photo gets one request for a clearer one (tested; a live phone run is pending) | |
| **RCS** for drivers without WhatsApp and as failover when a WhatsApp send fails (live on a real phone, load `LIVE-mve1ve6d`: dispatch card, Arrived, two location pins and a bill-of-lading photo over RCS, 2026-10-18 12:52–12:54 EDT; the WhatsApp-to-RCS failover is tested and run with synthetic events) | |
| Duplicate, out-of-order and stale taps refused; STOP/START honoured; "Talk to dispatch" answers the driver and emails dispatch; a tampered pack fails verification; over 160 automated tests | |

Today the scorecard measures the clause engine on 24 hand-labelled test loads. Its truth column was written by us from each clause's text, so it is a consistency check, not field data.

## Try it yourself (judges)
Send **DEMO** on WhatsApp to the DockClock number given on the Devpost submission page (**DEMO ES** for Spanish, **DEMO FR** for Québécois French). It takes about 10 minutes, most of it the real wait. You are both the driver and the dispatcher:
1. Tap **Arrived** and share your location. In the demo any location counts; the pin is still recorded with WhatsApp's server timestamp.
2. Free time is 5 minutes. Wait longer than that. Shortly after you arrive a detention notice is emailed, and the chat tells you.
3. Tap **Released**, share your location again, write on a piece of paper the arrival and release times the chat and the form show (US Eastern time in the demo), and photograph it in the form. Keep the times the form suggests.
4. The contract's verdict arrives in the chat. If it is billable, tap **Approve claim**. The AgentCore agent files it, and the chat tells you the amount and the evidence pack's digest.

**Change one thing** (send DEMO again to start over):
- Tap Released before 5 minutes: the chat explains "the wait stayed within free time". Nothing is claimed, and nothing is "repaired".
- In the form, change the out time by more than 15 minutes: the typed time no longer matches your pin, so the load is held for a person instead of claimed.
- Send a blurred photo: you are asked once for a clearer one; if none comes within 10 minutes, the first photo is used.

**What is real and what is not.** The clause is fictional (5 minutes free, $60 an hour, $30 cap, notice required before free time ends) and is not part of the scored set. The demo yard accepts any location, so the demo does not test the geofence. Claim and notice emails go to our own test mailbox, never to you. The KMS signature proves the recorded messages, times and photo hash have not changed since sealing; it cannot prove where your phone really was. Each number gets 5 demos a day, reset at 00:00 UTC. We store your pins and photo with the demo load, as we would for a carrier; the signed pack records the times and the photo's hash, not your location.

## Check the evidence yourself
`npm run verify:pack -- docs/evidence/SMOKE-mve8yfv3.pack.json` checks a real sealed pack against the published KMS public key with no AWS account, and shows a tampered copy failing. See [`docs/evidence/`](docs/evidence/README.md).

## Architecture
![DockClock architecture](docs/architecture.png)

What each AWS service does: [`docs/architecture.md`](docs/architecture.md).

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
| Utility template `dockclock_notice_sent` | Tells the driver that the contract's detention notice was emailed and when free time ends |
| Utility template with Approve / Hold buttons (`dockclock_dispatch_approval`) | The dispatcher's one-tap decision that releases the claim; it resumes the waiting Step Functions workflow |

Per load this is **3 utility templates (driver dispatch, notice sent, dispatcher approval) plus about 5 messages inside the free 24-hour window**, and 2 SES emails (the notice and the claim).

## Run it
```bash
npm ci
npm test            # over 160 tests
npm run scorecard   # recomputes the headline above
```
Deploying to your own AWS account (CDK) needs an existing WhatsApp Business Account linked to AWS End User Messaging Social; see `.env.example`.

## License
[MIT](LICENSE)
