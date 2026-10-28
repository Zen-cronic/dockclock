# DockClock Console: design system "Door 05"

The site opens on a landing page at `/` (see "Landing" below); the console's Overview is at `/overview`. The console is where DockClock's messaging is monitored: WhatsApp, RCS and email, per load and across loads. Its `/judges` route follows one claim through the five reasons a broker denies detention, one step each: "You weren't there that long" (Proved), "You never gave notice" (Notice), "You filed too late" (Filed), "The evidence was edited" (Break) and "It isn't owed" (Change). It opens on the priced problem (ATRI 2024, about $204,000 a year for a 40-driver carrier) and ends on "Try it". Each step has one heading, one sentence, one proof card and a "Carried by" row naming the services behind that proof. `/judges/signed` is an old link and lands on Break.

Rules:
- It is an app, not a report. Each screen does one thing.
- Dense detail (raw records, the pack JSON, email bodies, agent tool calls) sits behind a click, in a drawer or a tab.
- Messages opens newest first: one chronological list with a date row at each change of day, and a load chip where each load's run of rows starts. "Oldest first" reverses it; "By load" groups rows under each load id in name order (a load on one day names the day in its header; one that spans days dates every row). The choice is `?sort=oldest|load` and combines with the channel and status filters.
- A load the recorded set has only as a summary is labelled "Summary only" in its row, at full contrast, and does not open; it is never faded.
- Under 860 px, Loads, Messages and Emails are two-line rows, not squeezed tables; the load tabs scroll with the active tab brought into view and a fade at the cut edge.

## The story behind the palette
**Door 05** is a loading-dock door at a distribution centre, the place a detention claim starts. A truck backs onto the door and waits.

| Source | Becomes |
|---|---|
| The black door-number sign, framed in safety yellow | The navigation and the dock clock |
| The roll-up door | The page ground |
| Dock-light green and red | Delivered/valid and refused |
| The three-part carbonless bill of lading (white original, canary copy, blue-black form ink) | Cards and the evidence pack |

The palette comes from photos of a dock wayfinding sign, a dock-number sign and a three-part bill of lading.

## Colour (one meaning per accent)
| Token | Hex | Meaning; used only for this |
|---|---|---|
| `--ground` | `#eef0ee` | Page, the roll-up door |
| `--card` / `--card-2` | `#ffffff` / `#f6f7f6` | Cards (bill-of-lading original), table headers |
| `--side` / `--side-2` / `--side-3` | `#121316` / `#1c1e22` / `#2a2d33` | Navigation and the dock clock (the door sign) |
| `--canary` | `#fbf0b8` | The evidence pack only (the canary copy) |
| `--ink` / `--ink-2` / `--ink-3` | `#15171c` / `#454b57` / `#5e6573` | Text |
| `--form-ink` | `#1f2a55` | Text printed on the canary pack |
| `--safety` | `#ffc400` | **Money and billable time.** Always with ink text, never white; the billable stretch of the clock uses the yellow-and-black hazard stripe |
| `--safety-ink` | `#6b5300` | Safety meaning as text on a light ground |
| `--go` | `#0f7543` | **Valid, approved, delivered** |
| `--stop` | `#c8261a` | **Refused, changed, failed, not owed** |
| `--carbon` | `#2f55d4` | **The AI agent** |
| `--pink` | `#b0285e` | **COMPUTED**: an edited copy, not the original |

### Measured contrast (WCAG ratio)
| Pair | Ratio |
|---|---|
| ink / ground | 15.7 |
| ink-2 / ground | 7.7 |
| ink-3 / ground | 5.1 |
| ink-3 / card | 5.9 |
| ink / safety | 11.2 |
| safety / side | 11.6 |
| go / ground | 5.0 |
| go / card, white / go | 5.8 |
| stop / card, white / stop | 5.6 |
| carbon / card, white / carbon | 6.2 |
| pink / card, white / pink | 6.3 |
| form-ink / canary | 12.0 |
| nav text / side | 11.6 |
| nav dim / side | 5.9 |

White on safety yellow fails (1.4) and is never used.

## Type (all OFL, self-hosted from `@fontsource`, latin subsets)
| Family | Role | Why |
|---|---|---|
| **Big Shoulders Display** 600/800 | Headings, KPI numbers, load ids | A condensed grotesque drawn for city signage; it reads like dock-door numbers |
| **Overpass** 400/600/700 | All UI text | Descends from Highway Gothic, the US road-sign face; legible and not a default |
| **Overpass Mono** 400/600 | Times, ids, digests, the pack, service tags | Overpass's own mono |
| **Doto** 800 | The dock-clock digits only | A dot-matrix face, like a dock-door LED timer; the colon is set in Big Shoulders for legibility |

**Scale:** 11.5 (uppercase labels, 0.1em tracking) · 13 · 14 (body) · 16 · 20 · 28 · 40 (page title) · 56 (KPI). The clock is 64 px (46 px on phones).

## Space, shape, motion
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48.
- **Radii:** 6 (controls), 10 (cards), 16 (dock clock, coach), 36 (phone).
- **Shadow:** one soft card shadow.
- **Motion:**
  - Drawers slide 180 ms.
  - The bubbles and the LIVE dot are the only other motion.
  - Everything stops under `prefers-reduced-motion`.

## Brand mark
- **One master mark:** `public/brand-mark.svg`. A black door sign framed in safety yellow, holding a white roll-up dock door with a yellow-and-black hazard bumper. The yellow frame is the outer edge, so the mark reads the same on the black nav and in a light browser tab.
- **Generated from it**, by `npm run brand -w @dockclock/site` (`scripts/brand.mjs`):
  - `favicon.svg`: a byte-identical copy;
  - `logo.svg`: the mark plus the DOCKCLOCK wordmark;
  - `favicon-32.png` and `apple-touch-icon.png`: raster fallbacks.
- **Where it appears:** the nav logo and the phone-frame sender avatar both use `brand-mark.svg`.
- **Cache-busting:** icon links carry `?v=door05`, so browsers that cached an older mark refetch it.
- **Guard:** a site test fails if `favicon.svg` and the master ever differ.

## Components (`src/ui/`)
| Component | File | Notes |
|---|---|---|
| LoadHeader | `routes/LoadDetail.tsx` | Place name, load id, channel, a quiet "Real phone" chip only for a real-phone run, then the verdict sign, which carries the amount when it is owed. An owed load that was never filed says "Not filed: no approval" under the amount, in safety ink (it needs action; it is not a refusal). Under 860 px the sign sits under the load id |
| AppShell, NavRail, TopBar, Page | `AppShell.tsx` | The sign-black rail (Overview, Messages, Loads, Judges path). Under 860 px the rail becomes a top bar with four equal tabs, all reachable at 390 px with no sideways scroll. The TopBar has the breadcrumb, quiet badges and at most two actions |
| KpiTile | `KpiTile.tsx` | One label and one number. The top rule carries the meaning: hazard stripe = money, green = good |
| DockClockBand | `DockClockBand.tsx` | **The signature visual.** A dot-matrix "at the dock" clock, free and billable minutes, and a track with free time as a dashed floor marking and billable time as a hazard stripe, with the in, out and release-pin times marked on it. No per-record dots: on the Timeline tab the labelled record list sits right under the band and steps with the replay. Plays the replay. The track is scaled to the stay plus a margin. Records long after release (a seal hours later, an approval timeout days later) are not drawn; a short "later" stub past a break mark appears only when the band draws something there (a late release pin, or the replay cursor on a later record). In and out marks that would collide merge into one label. A thin yellow frame (1 px at 70%) |
| ProvenanceBadge | `badges.tsx` | Square-cut 3 px tags like the verdict sign, not pills; COMPUTED is outlined in pink. LIVE (green, pulsing) · RECORDED (responses recorded from the read API) · REPLAY (ink) · COMPUTED (pink) · TEST (outline). Always present, never a paragraph |
| ChannelBadge, ChannelIcon | `badges.tsx` | WhatsApp, RCS, Email, SMS, with neutral line icons. SMS appears only when SMS records exist |
| StatusPill | `badges.tsx` | A four-cell receipt strip read like the clock track: accepted, sent, delivered, read fill one cell each (green once delivered); failed or rerouted fills red; an inbound message is one hollow ring; a send the gates stopped is one dashed cell. The status word always follows the strip |
| Verdict | `badges.tsx` | The contract's answer as a dock-door sign with a dock light and the word in Big Shoulders Display. **Owed**, the usual case, is outlined in ink with a go-green light (`#0f7543`, 5.8:1 on white). **Not owed** (red light `#ff6b5e`, 6.7:1 on the plate) is filled sign black so it stands out in a list; white on the plate is 18.6:1. **Review** waits for a person: a white plate with a 1.5 px dashed ink-2 outline (`#454b57`, 8.8:1 on white) and an unlit ink-2 ring; its word is ink. **Open** is outlined in rule grey with a dashed ring. With `amountUsd` an owed sign adds a safety-yellow panel with the amount in ink (11.2:1), the money rule; a large refused sign shows $0.00 on a neutral panel. `large` is the load header and What-if size; in the two-up What-if cards the sign stacks over its amount so both cards have one shape. The table size is 26 px tall. It replaced a rotated rubber stamp |
| ConversationView | `ConversationView.tsx` | A neutral phone frame drawn from message records. On WhatsApp, buttons sit under the bubble. On RCS, a rich card with suggestion chips and a "Share location" chip. A failover shows as one chip: "WhatsApp failed → resent on RCS". Dashed bubbles were never sent. It copies neither app's branding |
| EmailView | `EmailView.tsx` | From, To with its test-mailbox note, Sent, Subject, body, attachments with sha256 on hover |
| AgentFlow | `AgentFlow.tsx` + `model/flow.ts` | The load's workflow as a vertical node graph built only from records: driver messages, notice, seal, **every agent run including refusals**, approval and claim email. Each node is tagged with its AWS services. An inferred Cedar decision is marked. Steps the API marks `failed` are red (an approval nobody answered: "No answer from dispatch ∙ timed out"); steps marked `skipped` have a dashed node and no time ("No bill-of-lading photo ∙ pins only", "Claim not filed ∙ no approval"). The workflow's reason opens in the drawer. A node on a later day carries its date |
| EvidencePanel | `EvidencePanel.tsx` | The pack as a canary carbon copy, ruled per row (a hairline under each field, never a background stripe, so wrapped and stacked values stay on their line), the in-browser KMS signature check, three tamper switches with a was → now list, bill-of-lading photos with the agent's reading and the sha256 match, and the raw pack in a drawer |
| WhatIfPanel | `WhatIfPanel.tsx` | The workflow's own clause engine, re-run with one fact changed. One line says what to do; only the facts this contract can turn on are listed, as plain sentences with a hint. The computed card waits ("Flip a switch…") until a fact changes, so the amount isn't repeated. Under 1100 px the result sits above the switches. Each side shows its verdict sign, with the amount on the sign when owed. The failed rule's reason reads under the signs. The judges path uses `QuickWhatIf`: three named facts (left early, notice late, filed late), the two signs and the reason |
| Timeline | `Timeline.tsx` | One title row per record, grouped (driver replayed / workflow). A list that crosses days gets a date row at each change of day. The record opens in a drawer |
| Drawer, Json | `Drawer.tsx` | A right-hand sheet. Escape closes it, and focus returns to the opener |
| EmptyState | `EmptyState.tsx` | One line and an optional hint. While loading, a 40 px Doto dot-matrix readout with three blinking cells (`role="status"`; still under reduced motion) |
| Judges stepper | `routes/Judges.tsx` | Numbered door plates 01 to 07: a step passed is a sign-black plate with a green light under its number, the current step stands on a safety keyline, a step still to come is an empty light plate. Under 860 px, a row of small numbered plates |
| TourCoach | `TourCoach.tsx` | A sign-black coach card with a yellow keyline, for guided steps |

## Marks and glyphs
- Pass and fail ticks are drawn (`Mark` in `badges.tsx`, `IconCheck` and `IconClose`), never the ✓ ✕ font glyphs.
- "Go" links end in the drawn chevron (`IconChevron`, class `go`, nudges 2 px on hover), never "›" or "→".
- Chat ticks inside the phone frame stay as text: they imitate a chat app's delivery ticks.

## Data and provenance
- **One view model.** Screens read the model in `src/model/model.ts`. Adapters turn the read API (`src/api.ts`, `fromApi.ts`) and the bundled replays (`replay/*.json`, `fromReplay.ts`) into it, and `src/model/client.ts` decides the source: live `/api`, then the recorded responses in `fixtures/api/` (RECORDED), then the replays (REPLAY). `?data=live|fixtures|replay` overrides it for the session.
- **Featured loads** live in `src/featured.ts`: one WhatsApp id for the judges default and the Overview clock, one RCS id for the RCS lane.
- **Copy follows provenance** (`src/copy/provenance.ts`):
  - "WhatsApp server times" appears only for a real phone run; a test load says "Replayed test times".
  - "Dispatcher tapped Approve" appears only when an approval record says so; with no approval record a filed claim says "Approved by a test command".
  - `test/site.test.ts` renders every replay through these functions and fails otherwise.
- On the judge-demo yard any location counts (`acceptsAnyLocation`), so its pins read "any location", never "in yard" or "inside the facility".
- **Never shown:** coordinates, phone numbers, BSUIDs, WhatsApp message ids, S3 keys, the KMS key ARN, the account id.
- **Fictional names:** every company is fictional and labelled so.

## Keyboard and motion
- A "Skip to content" link is the first Tab stop on every page.
- Every control shows a 2 px carbon-blue focus ring.
- Table rows open with Enter. A drawer keeps Tab inside it, closes on Escape, and returns focus to its opener.
- Switches are real checkboxes with `role="switch"`, toggled with Space, drawn as latch switches: a square-cut slot with a lever block. Off is an empty light slot with a light lever; on is sign black with the lever right and a yellow light. The latch keeps its own column so a long fact wraps beside it.
- Under `prefers-reduced-motion` no animation runs; replay playback is user-started and steps without transitions.

## Copy budget
- The first viewport of each route stays under about 40 words.
- Headings are nouns or short verbs: Overview, Messages, Loads, Proved, Signed, Filed. Definitions and explanations live in drawers.

## Landing (`/`, `src/landing/`)
The landing page tells one recorded load from dispatch to the filed claim, then points to the phone demo, the judge path and the console. It is in the first bundle, so it paints without a second round trip; the console's shell and routes, with the data client and its bundled replays, load on the first visit to a console path. Its routes live in `src/routes/table.ts`; `test/landing.test.ts` checks that `/judges`, `/judges/:step`, `/messages`, `/loads` and `/loads/:id[/:tab]` still resolve where they always did.

**Type blend.** The landing talks to a person, so its own type leads. Every product surface inside it (phones, mail, dock clock, verdict sign, amounts, load ids) keeps Door 05 type, so it reads as the same product as the console.

| Family | Role on the landing | Why |
|---|---|---|
| **Young Serif** 400 | Headlines, the refusal quotes, the storyboard step names | A sturdy serif with soft ball terminals; warm and plain-spoken next to the dock signage faces |
| **Figtree** 400/600/700 | Body, buttons, nav | A round geometric sans, open at small sizes |
| **IBM Plex Mono** 500 | Kickers and small uppercase tags, set on a highlight bar | A neutral mono that sits beside Overpass Mono without competing |

All three are OFL, self-hosted from `@fontsource` (latin subsets), pinned exact.

**Tokens** (scoped to `.lp` in `landing.css`): `--serif`, `--sans`, `--tag`; `--door` `#dfe3df` (the kicker bar). The roll-up door plate is 30 px slats of `#e4e7e4` with a `#d3d8d3` rib and a `#f1f3f1` highlight, a sign-black bottom seal and the hazard bumper. Colours are Door 05's, with the same meanings: safety yellow is money and billable time (plus the primary button, as in the console).

| Component | File | Notes |
|---|---|---|
| StaticHero | `HeroPlayer.tsx` | Reduced motion, top of the page: the filed claim in the receiver's inbox, still, with "Play the recording" (an explicit choice) on the sill |
| Story | `story.ts` | Builds six chapters (Dispatched, Arrived, Notice, Released, Approved, Filed) from the featured WhatsApp load's recorded read-API responses and its two emails, picking records by purpose. No message, time or email is written by hand; changing `FEATURED.whatsapp` changes the hero |
| HeroPlayer | `HeroPlayer.tsx` | The recorded load, one record at a time, on the device that received it: driver's phone, receiver's inbox, dispatcher's phone. A plate drawn as a roll-up door with a hazard bumper. Chapter list with recorded times (desktop). On the plate, a sign-black sill (bottom on desktop, top on phones) holds a 44 px Play/Pause button, one thin scrubber split into six seekable steps and the recorded time of the frame, so the control is visible whenever the player is. The plate's height follows the viewport (440 to 584 px) and the phone and emails size to it. Under it: a one-line caption and the provenance line. Starts on first paint when on screen, pauses off screen or in a hidden tab, and after the last step holds 3.2 s and starts again. Under reduced motion the hero shows the filed claim still with "Play the recording" on the sill |
| Phone, Mail | `Devices.tsx` | The phone reuses the console's `.phone`/`.bub` classes; a tap shows a press ripple on the button before the reply. The mail view stops at the signature separator (the hashes are in the console), keeps whole paragraphs that fit and marks a cut with […], and names attachments plainly |
| Storyboard | `HeroPlayer.tsx` | Reduced motion: all six chapters at once, as numbered frames (3 columns, 2 under 1080 px, 1 under 640 px) |
| WaitScene | `WaitScene.tsx` | A pinned scroll scene on sign black: a flat truck backs onto door 05 while the dot-matrix clock runs from the arrival pin to the release pin (white, then safety yellow once billable), the track fills (free time dashed, billable striped) and the verdict sign with the amount lands, at a larger size. Every number comes from the load. Under reduced motion it is drawn once at its last frame and does not pin |
| Refusals | `Landing.tsx` | The five refusals as quotes, each answered in one sentence with a mono proof chip of the load's own times and a "See it" link to its judge step |
| Numbers | `Landing.tsx` | A sentence that fills from grey to ink as it scrolls, and three ATRI figures that count up once (the money figure carries the hazard rule) |
| Try, Closing, Footer | `Landing.tsx` | The DEMO steps on sign black; the judge path and console CTAs beside the load's sealed evidence pack as a canary card (load, sealed time, digest, KMS signature, Object Lock, a link to break it); a hazard rule over the footer's console links and the fictional-companies line |

**Motion:** the hero loops; message beat 1050 ms, button press 560 ms, mail hold 4.6 s, device swap 420 ms opacity and 520 ms lift on `--ease`, bubble rise 300 ms; count-up 1.2 s; the wait scene and the fill sentence follow the scroll. Under `prefers-reduced-motion` nothing autoplays or animates; the hero plays only when the visitor presses Play, and then without transitions.

**Copy:** the first viewport stays near 40 words. The hero says where its records come from ("Recorded from a real load on a real phone, <date>. WhatsApp server times, EDT. The companies are fictional.").
