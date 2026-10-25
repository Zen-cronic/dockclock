import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Verdict } from "../src/ui/badges.js";

const html = (verdict: Parameters<typeof Verdict>[0]["verdict"], amountUsd?: number, large?: boolean) =>
  renderToStaticMarkup(createElement(Verdict, { verdict, amountUsd, large: large ?? false }));

// The verdict sign: the word is always text (never colour alone), and only an owed verdict
// carries money, on the safety-yellow panel.
describe("verdict sign", () => {
  it("names each verdict in words", () => {
    expect(html("BILLABLE")).toContain(">Owed<");
    expect(html("NOT_BILLABLE")).toContain(">Not owed<");
    expect(html("NEEDS_HUMAN")).toContain(">Review<");
    expect(html(null)).toContain(">Open<");
  });

  it("carries the amount only when it is owed", () => {
    expect(html("BILLABLE", 17.28, true)).toContain('<span class="amount">$17.28</span>');
    expect(html("BILLABLE")).not.toContain("amount");
    expect(html("NOT_BILLABLE", 0, true)).toContain('<span class="amount none">$0.00</span>');
    expect(html("NOT_BILLABLE", 0)).not.toContain("amount");
    expect(html("NEEDS_HUMAN", 11.92)).not.toContain("amount");
  });

  it("is a sign, not a rubber stamp", () => {
    const out = html("BILLABLE", 17.28, true);
    expect(out).toContain('class="verdict v-owed lg"');
    expect(out).not.toContain("stamp");
    expect(out).toContain('aria-hidden="true"');
  });
});

import { StatusPill } from "../src/ui/badges.js";
import { EmptyState } from "../src/ui/EmptyState.js";

describe("receipt strip and loading readout", () => {
  const strip = (status: Parameters<typeof StatusPill>[0]["status"]) => renderToStaticMarkup(createElement(StatusPill, { status }));
  const lit = (html: string) => (html.match(/<i class="on"><\/i>/g) ?? []).length;

  it("fills one cell per receipt and always names the status", () => {
    expect(lit(strip("accepted"))).toBe(1);
    expect(lit(strip("sent"))).toBe(2);
    expect(lit(strip("delivered"))).toBe(3);
    expect(lit(strip("read"))).toBe(4);
    expect(strip("read")).toContain("read</span>");
    expect(lit(strip("not_sent"))).toBe(0);
    expect(strip("received").match(/<i/g)).toHaveLength(1);
  });

  it("shows loading as a status readout and other empty states as a line", () => {
    expect(renderToStaticMarkup(createElement(EmptyState, { title: "Loading" }))).toContain('role="status"');
    expect(renderToStaticMarkup(createElement(EmptyState, { title: "No loads yet" }))).toContain("<b>No loads yet</b>");
  });
});
