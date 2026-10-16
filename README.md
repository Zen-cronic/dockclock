# DockClock

> **On 24 test loads, DockClock filed 9 claims, all 9 contract-valid (0 false holds), held 11 with the clause reason and sent 4 to a person. The industry's 2-hour rule would have filed 21: 9 the contract denies ($800.01) and 3 the evidence can't support.** Reproduce with `npm run scorecard` (fixtures frozen at sha256 `d45ae579…`; clauses modelled on published shipper and broker terms, every assumption labelled in [`packages/clause-engine/src/clauses.ts`](packages/clause-engine/src/clauses.ts)).

**Truckers wait hours at docks and get paid for less than half of it. DockClock turns the driver's WhatsApp into tamper-evident proof, files a detention claim only when the counterparty's contract says it's owed, and works the dispute until it's paid.**

> Status: under active build for the AWS Communication Developer Services (CDS) Agentic AI Partner Hackathon. This README grows with the build; every claim in it is listed in [`FACTS.md`](FACTS.md) once that file exists.

## What is real and what is simulated
| Piece | Status |
|---|---|
| Carrier, factor, brokers, shippers, loads | **Fictional.** Contract clauses are modelled on published shipper and broker terms; each fixture names its source and any assumed value |
| Industry economics | **US survey data** (ATRI 2024, OOIDA 2023, US DOT OIG 2018), labelled as such |
| WhatsApp, SES, RCS, AgentCore | Real AWS services, wired as the build progresses |

## Run it
```bash
npm ci
npm test
npm run scorecard
```

## License
[MIT](LICENSE)
