import type { ClauseSpec } from "./types.js";

// Every counterparty is fictional. Each clause is modelled on a published term and lists the
// values the source does not state, so a reviewer can separate quoted terms from assumptions.
export const CLAUSES: readonly ClauseSpec[] = [
  {
    id: "lakeshore-foods",
    counterparty: "Lakeshore Foods (fictional shipper)",
    role: "shipper",
    modelledOn: {
      label: "Campbell's Motor Carrier Agreement, Exhibit 2 (truckload detention)",
      url: "https://www.thecampbellscompany.com/resources/motor-carrier",
      fetched: "2026-10-16",
    },
    assumptions: ["Claim window not stated in source; DockClock default of 7 days used"],
    freeTimeMinutes: 120,
    freeTimeAnchor: "appointment",
    requireOnTimeArrival: true,
    onTimeGraceMinutes: 0,
    ratePerHourUsd: 60,
    capUsdPerOccurrence: 360,
    capHoursPerDay: null,
    noticeLeadMinutes: null,
    acceptedRecords: ["status_214", "signed_bol_times"],
    claimWindowHours: 168,
    shipperConfirmationRequired: false,
  },
  {
    id: "ridgeline-supply",
    counterparty: "Ridgeline Supply (fictional shipper)",
    role: "shipper",
    modelledOn: {
      label: "Union Pacific Supply Logistics Carrier Information Packet (2024-01-08)",
      url: "https://www.up.com/cs/groups/public/@uprr/@suppliers/documents/up_pdf_nativedocs/wcccon1090856.pdf",
      fetched: "2026-10-16",
    },
    assumptions: [
      "Hourly rate not stated in source; $50/h used (ATRI 2024 truckload median)",
      "Free time counted from arrival (source says first 2 hours free without naming the anchor)",
      "Claim window not stated in source; DockClock default of 7 days used",
    ],
    freeTimeMinutes: 120,
    freeTimeAnchor: "arrival",
    requireOnTimeArrival: false,
    onTimeGraceMinutes: 0,
    ratePerHourUsd: 50,
    capUsdPerOccurrence: null,
    capHoursPerDay: 6,
    noticeLeadMinutes: 30,
    acceptedRecords: ["signed_bol_times", "status_214"],
    claimWindowHours: 168,
    shipperConfirmationRequired: false,
  },
  {
    id: "atlas-brokerage",
    counterparty: "Atlas Brokerage (fictional broker)",
    role: "broker",
    modelledOn: {
      label: "TQL carrier FAQ (detention notice and paperwork)",
      url: "https://www.tql.com/faqs",
      fetched: "2026-10-16",
    },
    assumptions: [
      "Rate not published; $50/h used (ATRI 2024 truckload median)",
      "Claim window not published; 48 hours used (FreightWaves: most brokers 24-48 hours)",
    ],
    freeTimeMinutes: 120,
    freeTimeAnchor: "appointment",
    requireOnTimeArrival: true,
    onTimeGraceMinutes: 0,
    ratePerHourUsd: 50,
    capUsdPerOccurrence: null,
    capHoursPerDay: null,
    noticeLeadMinutes: 30,
    acceptedRecords: ["signed_bol_times"],
    claimWindowHours: 48,
    shipperConfirmationRequired: false,
  },
  {
    id: "freightline-digital",
    counterparty: "Freightline Digital (fictional broker)",
    role: "broker",
    modelledOn: {
      label: "Uber Freight: How to request detention (2020)",
      url: "https://www.uberfreight.com/blog/how-to-request-detention-on-uber-freight",
      fetched: "2026-10-16",
    },
    assumptions: [
      "Rate not published; $50/h used (ATRI 2024 truckload median)",
      "Free time of 2 hours used (industry standard per CRS R48759)",
    ],
    freeTimeMinutes: 120,
    freeTimeAnchor: "arrival",
    requireOnTimeArrival: true,
    onTimeGraceMinutes: 0,
    ratePerHourUsd: 50,
    capUsdPerOccurrence: null,
    capHoursPerDay: null,
    noticeLeadMinutes: null,
    acceptedRecords: ["app_gps", "signed_bol_times"],
    claimWindowHours: 24,
    shipperConfirmationRequired: false,
  },
  {
    id: "valley-ag",
    counterparty: "Valley Ag (fictional shipper)",
    role: "shipper",
    modelledOn: {
      label: "J.R. Simplot AgriBusiness Carrier Packet, Delay Time Policy",
      url: "https://techsheets.simplot.com/Simplot/Simplot-Carrier-Packet.pdf",
      fetched: "2026-10-16",
    },
    assumptions: [
      "Rate not stated on the policy page; $50/h used (ATRI 2024 truckload median)",
      "Scale-house entry time modelled as the server-timestamped arrival pin",
      "Claim window not stated; DockClock default of 7 days used",
    ],
    freeTimeMinutes: 120,
    freeTimeAnchor: "arrival",
    requireOnTimeArrival: false,
    onTimeGraceMinutes: 0,
    ratePerHourUsd: 50,
    capUsdPerOccurrence: null,
    capHoursPerDay: null,
    noticeLeadMinutes: null,
    acceptedRecords: ["signed_bol_times"],
    claimWindowHours: 168,
    shipperConfirmationRequired: true,
  },
];

// The clause behind the judge try-it path (text DEMO to the WhatsApp number). Short on purpose, so a
// judge sees a billable claim in minutes. It is not one of the scored clauses and is modelled on no
// published terms.
export const JUDGE_DEMO_CLAUSE: ClauseSpec = {
  id: "judge-demo",
  counterparty: "Demo Receiving Co. (fictional)",
  role: "shipper",
  modelledOn: { label: "DockClock judge demo, not modelled on any published terms", url: "https://github.com/Zen-cronic/dockclock", fetched: "2026-10-18" },
  assumptions: ["5 minutes of free time so the demo fits in a few minutes", "$30 cap per load to bound the demo"],
  freeTimeMinutes: 5,
  freeTimeAnchor: "arrival",
  requireOnTimeArrival: false,
  onTimeGraceMinutes: 0,
  ratePerHourUsd: 60,
  capUsdPerOccurrence: 30,
  capHoursPerDay: null,
  noticeLeadMinutes: null,
  acceptedRecords: ["app_gps", "signed_bol_times"],
  claimWindowHours: 24,
  shipperConfirmationRequired: false,
};

export function clauseById(id: string): ClauseSpec {
  const clause = CLAUSES.find((c) => c.id === id) ?? (id === JUDGE_DEMO_CLAUSE.id ? JUDGE_DEMO_CLAUSE : undefined);
  if (!clause) throw new Error(`unknown clause ${id}`);
  return clause;
}
