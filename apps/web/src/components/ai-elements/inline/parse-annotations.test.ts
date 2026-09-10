import { describe, expect, it } from "vitest";
import { parseAnnotations } from "./parse-annotations";

const service =
  '<<maple:service:{"name":"maple-chat","throughput":10,"errorRate":50,"p99Ms":14424.99}>>';

describe("parseAnnotations", () => {
  it("returns plain text untouched", () => {
    expect(parseAnnotations("hello **world**")).toEqual([
      { type: "text", content: "hello **world**" },
    ]);
  });

  it("turns a standalone annotation into a card segment", () => {
    expect(parseAnnotations(`Findings:\n\n${service}\n\nDone.`)).toEqual([
      { type: "text", content: "Findings:\n\n" },
      {
        type: "service",
        data: {
          name: "maple-chat",
          throughput: 10,
          errorRate: 50,
          p99Ms: 14424.99,
        },
      },
      { type: "text", content: "\n\nDone." },
    ]);
  });

  it("replaces an annotation inside a line with an inline label", () => {
    const text = `Needs attention:\n\n- ${service} — 50% of requests failing.\n- **maple-ios** — 3.2%`;
    expect(parseAnnotations(text)).toEqual([
      {
        type: "text",
        content:
          "Needs attention:\n\n- **maple-chat** — 50% of requests failing.\n- **maple-ios** — 3.2%",
      },
    ]);
  });

  it("labels every entity type inline", () => {
    const text = [
      'see <<maple:trace:{"id":"abc","name":"GET /","durationMs":1,"hasError":false}>>,',
      '<<maple:error:{"errorType":"TimeoutError","count":3}>>,',
      'and <<maple:log:{"severity":"WARN","body":"disk full"}>>',
    ].join(" ");
    expect(parseAnnotations(text)).toEqual([
      { type: "text", content: "see `abc`, **TimeoutError**, and `disk full`" },
    ]);
  });

  it("accepts single angle brackets", () => {
    expect(
      parseAnnotations('- <maple:service:{"name":"api"}> is fine'),
    ).toEqual([{ type: "text", content: "- **api** is fine" }]);
  });

  it("leaves malformed JSON visible as text", () => {
    const bad = "<<maple:service:{not json}>>";
    expect(parseAnnotations(`x ${bad} y`)).toEqual([
      { type: "text", content: `x ${bad} y` },
    ]);
  });
});
