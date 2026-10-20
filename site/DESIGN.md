# DockClock judge desk: design system

"Dock ledger": a dispatcher's ledger under a dock clock. It uses warm paper, ink and monospace times, with one accent per meaning. Time is the main character. The money (billable minutes) is visible before any text is read.

The page has three tabs, and each one carries a provenance badge:
- **Watch the load** (REPLAY)
- **Break the signature** (REPLAY data, checked in the browser)
- **Change one fact** (COMPUTED)

LIVE is reserved for a judge's own DEMO run. That mode is not built yet.

## Colour tokens (`src/styles.css` `:root`)
The page is light only. The pack is drawn as a printout and a judge's visit is short, so a dark theme would add review surface without helping the reader. `color-scheme: light` is set.

| Token | Value | Meaning; used only for this |
|---|---|---|
| `--paper` / `--paper-2` | `#f3f0e8` / `#e9e4d6` | Page and hatching |
| `--card` / `--printout` | `#fbfaf6` / `#fffef9` | Panels / the evidence pack |
| `--ink` / `--ink-2` / `--ink-3` | `#1c1b17` / `#4f4c44` / `#6b675d` | Text, at 15:1 / 7.5:1 / 5:1 on paper |
| `--rule` / `--rule-2` | `#d6d1c3` / `#c4bead` | Borders |
| `--amber` (+`-soft`, `-ink`) | `#c98300` / `#f6e3b8` / `#6e4600` | **Billable time and money owed.** Amber text always uses `--amber-ink` (7:1); labels on the amber bar are ink (5.3:1), never white (3.1:1) |
| `--green` (+`-soft`) | `#2a7449` / `#dcebdf` | **Verified, approved, sent** |
| `--red` (+`-soft`) | `#a8261e` / `#f4dcd8` | **Refused, changed, not owed** |
| `--blue` (+`-soft`) | `#2457a6` / `#dee7f4` | **The AI agent, and COMPUTED** |
| `--wa-*` | WhatsApp-like greens and greys | Inside the phone frame only |

## Type
- **Fonts:** IBM Plex Sans (400–700) for words and IBM Plex Mono (400–600) for times, ids, amounts, digests and the clock. Both load from Google Fonts, with system fallbacks.
- **Scale:**
  - 12 px: labels (uppercase, 0.08em tracking)
  - 13 px: secondary text
  - 14 px: body
  - 16 px: lede
  - 20 px
  - 28 px
  - 40 px: hero (28 px on mobile)
  - 46 px: dock clock (34 px on mobile)
- **Numerals:** tabular in the clock and timeline.

## Space, shape, motion
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48. The page gutter is 28 px (16 px on mobile).
- **Radii:** 3 px for controls and badges, 6 px for panels, 40 px for the phone.
- **Borders and shadows:** 1 px rules everywhere. The only drop shadow is under the phone.
- **Motion:**
  - opening sweep: 2.2 s cubic ease-out, the dock clock running from arrival to the claim;
  - new chat bubble: 220 ms rise of 6 px;
  - verdict stamp: lands in 160 ms, with no bounce.
- **Reduced motion:** `prefers-reduced-motion` disables the sweep and all animation. Playback then steps without transitions.

## Components
| Component | Class | Notes |
|---|---|---|
| Proof step | `.proof .tick` | 1/2/3 in ink only. Colours stay reserved for their meanings |
| Provenance badge | `.badge.replay/.live/.computed/.ghost` | Mono caps. Every surface carries one |
| Dock clock band | `.band` | The signature element. Left: elapsed "h:mm at the dock". Track: early (unpaid, light hatch), free time (hatch), billable (amber), then a cursor. Marks show Arrived, Free time ends and Released at their true times. Pins for refused taps (red), money (amber), agent (blue) and approved (green). Right: play/pause, the record counter and the recorded zone, plus a scrubber |
| Phone frame | `.phone` `.screen` `.msg` | WhatsApp-like, drawn from records. Driver/Dispatcher switch. Bubble tag line: test message / not sent · test driver / template · name / sent / received. Dashed bubbles were never sent. Locations show only "inside the facility area" |
| Timeline row | `.row` `.grp` | Rows are grouped: replayed driver messages, then the workflow. A group shows its service route once; a row shows a route only when it differs. Outcome codes appear on refusals only, and a dot legend sits at the top. A click opens the record drawer |
| Record drawer | `dialog.drawer` | Native `<dialog>`, so Escape closes it. Shows provenance in words, services, and the sanitized stored record as JSON |
| Verdict stamp | `.stamp` | OWED (green), NOT OWED (red), NEEDS A PERSON (amber ink). Rotated −2° like a rubber stamp; the amount sits beside it in mono. On tab 1 it appears once, on the claim slip; the "Why it is owed" card below holds the clause terms in plain words and the math line |
| Claim slip | `.slip` | Printout-white card in the hero: stamp, amount, owed by, approval, and a live in-browser signature check |
| Mailbox | `.mail` | From, To (fictional name + "test mailbox" note), Sent (with seconds after Approve), Subject, body (fades, expands), attachment chips |
| Agent trace | `.agentcard .trace` | Typed rows Task / Tool / Policy / Guard with ran / permit / match outcomes. An inferred Cedar decision is labelled "Inferred" |
| Fan-fold pack | `.feed` | Continuous-feed paper with tractor holes and mono key/value rows. A changed value is highlighted red |
| Verify result | `.vres.good/.bad/.wait` | One line of verdict, then the fingerprint |
| Toggle | `.toggle` + `input[role=switch]` | A real checkbox. Disabled rows say why ("This contract does not require a notice") |
| Scorecard | `.score` | Three numbers from the clause engine, computed in the browser, with the fixture hash |

## Logo
- `public/logo-mark.svg`: a clock ring whose amber wedge is the billable time past the mark, an ink hand on the wedge's edge, and a dock-floor rule beneath.
- `public/logo.svg`: the mark plus the "DockClock" wordmark (Plex Sans 700).
- `public/favicon.svg`: the mark on a paper tile.
- `public/avatar.svg`: an inverted mark for the chat header.

The marks are original and generic, with no vehicle imagery.

## Copy rules
- Plain words in headings; no AWS or engine jargon in a title. Service names appear only in chips and the footer.
- "Detention" and "bill of lading" are defined once, under the hero.
- **Every time is in the facility's zone, with the zone named.** Every number comes from the snapshot or from the clause engine at runtime; none is typed into the page.
- **Every company is fictional and says so.** The email goes to "our test mailbox, not a real company".
- **Never shown:** coordinates, phone numbers, WhatsApp ids, S3 keys, the KMS key ARN, the account id.

## The first 30 seconds
1. **First viewport, before any click (1440×900).** On the left:
   - REPLAY badge and the load line;
   - "The contract owed **$90.99**. DockClock proved it, signed it and emailed the claim.";
   - the wait in one sentence;
   - one line defining detention and bill of lading.

   On the right, the **claim slip**: OWED stamp, $90.99, who owes it, "Dispatcher tapped Approve; the AI agent emailed it 14 s later", and **Signature ✓ valid, checked in your browser just now**. That check is real; it runs on page load. Under it sits **Try to break the signature →**.

   Below these: three neutral proof cells (Proved / Signed / Filed) with the what-was-real line as their caption, then the dock clock band with its single **Play the replay** control.

   The band sweeps from arrival to the claim in 2.2 s, and the stamp lands.
2. **First click, either:**
   - Play: about 25 s, one record every 1.5 s, the phone switching between driver and dispatcher.
   - Break the signature: one switch turns "valid" into "does not match".

## Accessibility
- The tabs use `role=tablist`; the toggles are real switches.
- The scrubber is a labelled range input. Space plays and pauses, and the arrow keys step.
- Focus rings are a 2 px ink outline.
- Text contrast is at least 4.5:1, and stamps carry text, not colour alone.
- The verify result is an `aria-live` region.
