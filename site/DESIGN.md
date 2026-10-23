# DockClock Console: design system "Door 05"

The console is where DockClock's messaging is monitored: WhatsApp, RCS and email, per load and across loads. Its `/judges` route follows one claim through the five reasons a broker denies detention, one step each: "You weren't there that long" (Proved), "You never gave notice" (Notice), "You filed too late" (Filed), "The evidence was edited" (Break) and "It isn't owed" (Change). It opens on the priced problem (ATRI 2024, about $204,000 a year for a 40-driver carrier) and ends on "Try it". Each step has one heading, one sentence, one proof card and a "Carried by" row naming the services behind that proof. `/judges/signed` is an old link and lands on Break.

Rules:
- It is an app, not a report. Each screen does one thing.
- Dense detail (raw records, the pack JSON, email bodies, agent tool calls) sits behind a click, in a drawer or a tab.
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
| **Big Shoulders Stencil Display** 800 | The OWED / NOT OWED stamp only | Stencilled crate and trailer markings |
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
  - The stamp, the bubbles and the LIVE dot are the only other motion.
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
| LoadHeader | `routes/LoadDetail.tsx` | Place name, load id, channel, a quiet "Real phone" chip only for a real-phone run, then the stamp and amount. An owed load that was never filed says "Not filed: no approval" under the amount, in safety ink (it needs action; it is not a refusal). Under 860 px the stamp and amount share one row |
| AppShell, NavRail, TopBar, Page | `AppShell.tsx` | The sign-black rail (Overview, Messages, Loads, Judges path). Under 860 px the rail becomes a top bar with four equal tabs, all reachable at 390 px with no sideways scroll. The TopBar has the breadcrumb, quiet badges and at most two actions |
| KpiTile | `KpiTile.tsx` | One label and one number. The top rule carries the meaning: hazard stripe = money, green = good |
| DockClockBand | `DockClockBand.tsx` | **The signature visual.** A dot-matrix "at the dock" clock, free and billable minutes, and a track with free time as a dashed floor marking and billable time as a hazard stripe, with records pinned at their true times. Plays the replay. The track is scaled to the stay plus a margin; records long after release (a seal hours later, an approval timeout days later) sit in a short "later" stub past a break mark. In and out marks that would collide merge into one label |
| ProvenanceBadge | `badges.tsx` | LIVE (green, pulsing) · RECORDED (responses recorded from the read API) · REPLAY (ink) · COMPUTED (pink) · TEST (outline). Always present, never a paragraph |
| ChannelBadge, ChannelIcon | `badges.tsx` | WhatsApp, RCS, Email, SMS, with neutral line icons. SMS appears only when SMS records exist |
| StatusPill | `badges.tsx` | accepted → sent → delivered → read, then failed / failover / received / not sent |
| Stamp | `badges.tsx` | Stencil stamp, rotated −2°: Owed (green), Not owed (red), Review (dark yellow) |
| ConversationView | `ConversationView.tsx` | A neutral phone frame drawn from message records. On WhatsApp, buttons sit under the bubble. On RCS, a rich card with suggestion chips and a "Share location" chip. A failover shows as one chip: "WhatsApp failed → resent on RCS". Dashed bubbles were never sent. It copies neither app's branding |
| EmailView | `EmailView.tsx` | From, To with its test-mailbox note, Sent, Subject, body, attachments with sha256 on hover |
| AgentFlow | `AgentFlow.tsx` + `model/flow.ts` | The load's workflow as a vertical node graph built only from records: driver messages, notice, seal, **every agent run including refusals**, approval and claim email. Each node is tagged with its AWS services. An inferred Cedar decision is marked. Steps the API marks `failed` are red (an approval nobody answered: "No answer from dispatch ∙ timed out"); steps marked `skipped` have a dashed node and no time ("No bill-of-lading photo ∙ pins only", "Claim not filed ∙ no approval"). The workflow's reason opens in the drawer. A node on a later day carries its date |
| EvidencePanel | `EvidencePanel.tsx` | The pack as a canary carbon copy, ruled per row (a hairline under each field, never a background stripe, so wrapped and stacked values stay on their line), the in-browser KMS signature check, three tamper switches with a was → now list, bill-of-lading photos with the agent's reading and the sha256 match, and the raw pack in a drawer |
| WhatIfPanel | `WhatIfPanel.tsx` | The workflow's own clause engine, re-run with one fact changed. One line says what to do; only the facts this contract can turn on are listed, as plain sentences with a hint. The computed card waits ("Flip a switch…") until a fact changes, so the amount isn't repeated. Under 1100 px the result sits above the switches. The failed rule's reason reads under the stamps. The judges path uses `QuickWhatIf`: three named facts (left early, notice late, filed late), the two stamps and the reason |
| Timeline | `Timeline.tsx` | One title row per record, grouped (driver replayed / workflow). A list that crosses days gets a date row at each change of day. The record opens in a drawer |
| Drawer, Json | `Drawer.tsx` | A right-hand sheet. Escape closes it, and focus returns to the opener |
| EmptyState | `EmptyState.tsx` | One line and an optional hint |
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
- Switches are real checkboxes with `role="switch"`, toggled with Space.
- Under `prefers-reduced-motion` no animation runs; replay playback is user-started and steps without transitions.

## Copy budget
- The first viewport of each route stays under about 40 words.
- Headings are nouns or short verbs: Overview, Messages, Loads, Proved, Signed, Filed. Definitions and explanations live in drawers.
