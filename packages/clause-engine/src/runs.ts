// What kind of run a load was, matching FACTS.md's status key, and its label in a few words. The
// console read API (services/api) sends the label as runLabel and the site shows the same words,
// so both read them here: the backend never imports from the site's source.
//   phone:       driven end to end from a real phone
//   operator:    a real person tapped on a real phone; driver messages were synthetic
//   integration: synthetic driver messages through the deployed stack; everything after is real
//   demo:        a judge's DEMO keyword run
export type RunKind = "phone" | "operator" | "integration" | "demo";

export const RUN_LABELS: Record<RunKind, string> = { phone: "Real phone", operator: "Test load ∙ real tap", integration: "Test run", demo: "Judge demo" };
