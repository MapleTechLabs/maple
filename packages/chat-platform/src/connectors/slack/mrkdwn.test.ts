/**
 * The dialect conversion, which is where a turn either reads like an answer or reads like its own
 * source code.
 *
 * The cases that matter most are the ones where the two markdowns DISAGREE — `*x*` is italic in
 * one and bold in the other — and the ones where mrkdwn simply has no equivalent.
 */
import { describe, expect, it } from "vitest"
import { escapeMrkdwn, toMrkdwn } from "./mrkdwn"

describe("escaping", () => {
	it("neutralizes Slack's three control characters, ampersand first", () => {
		expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d")
	})

	it("stops a quoted mention from paging a workspace", () => {
		// An agent reading a log line back must not notify a company with it.
		expect(toMrkdwn("the log said <!channel> was paged")).toContain("&lt;!channel&gt;")
		expect(toMrkdwn("<@U123> reported it")).toContain("&lt;@U123&gt;")
	})
})

describe("emphasis", () => {
	it("maps markdown bold onto Slack bold", () => {
		expect(toMrkdwn("**checkout** is slow")).toBe("*checkout* is slow")
		expect(toMrkdwn("__checkout__ is slow")).toBe("*checkout* is slow")
	})

	it("maps markdown italic onto Slack italic rather than leaving it as bold", () => {
		// The whole reason this module exists: `*x*` means different things in the two dialects.
		expect(toMrkdwn("this is *probably* the cause")).toBe("this is _probably_ the cause")
	})

	it("maps strikethrough onto Slack's single tilde", () => {
		expect(toMrkdwn("~~not this~~")).toBe("~not this~")
	})

	it("leaves a lone asterisk alone", () => {
		expect(toMrkdwn("2 * 3 = 6")).toBe("2 * 3 = 6")
	})
})

describe("links", () => {
	it("rewrites a markdown link into Slack's angle-bracket form", () => {
		expect(toMrkdwn("see [the trace](https://app.maple.dev/traces/abc)")).toBe(
			"see <https://app.maple.dev/traces/abc|the trace>",
		)
	})

	it("drops an empty label rather than leaving a dangling pipe", () => {
		expect(toMrkdwn("[](https://maple.dev)")).toBe("<https://maple.dev>")
	})

	it("keeps a label that contains a pipe from cutting its own text", () => {
		expect(toMrkdwn("[a|b](https://maple.dev)")).toBe("<https://maple.dev|a/b>")
	})

	it("treats an image the same as a link — a real chart arrives as an image block", () => {
		expect(toMrkdwn("![plot](https://maple.dev/p.png)")).toBe("<https://maple.dev/p.png|plot>")
	})
})

describe("what mrkdwn does not have", () => {
	it("renders a heading as a bold line", () => {
		expect(toMrkdwn("## What I found")).toBe("*What I found*")
		expect(toMrkdwn("### Deeper\ntext")).toBe("*Deeper*\ntext")
	})

	it("fences a table so its columns still line up", () => {
		const table = ["| service | p99 |", "| --- | --- |", "| checkout | 2.1s |", "", "after"].join("\n")
		expect(toMrkdwn(table)).toBe(
			["```", "| service | p99 |", "| --- | --- |", "| checkout | 2.1s |", "```", "", "after"].join(
				"\n",
			),
		)
	})

	it("leaves a row that is not a table as prose", () => {
		// No delimiter line, so it is somebody writing with pipes rather than a table.
		expect(toMrkdwn("| not | a | table |")).toBe("| not | a | table |")
	})

	it("turns list markers into bullets, which mrkdwn has no syntax for", () => {
		expect(toMrkdwn("- one\n- two")).toBe("•  one\n•  two")
		expect(toMrkdwn("  * nested")).toBe("  •  nested")
	})
})

describe("code", () => {
	it("keeps a fenced block verbatim and drops the language tag", () => {
		const source = ["```sql", "SELECT **a** FROM t -- [x](y)", "```"].join("\n")
		expect(toMrkdwn(source)).toBe(["```", "SELECT **a** FROM t -- [x](y)", "```"].join("\n"))
	})

	it("closes a block the model never closed", () => {
		expect(toMrkdwn("```\nSELECT 1")).toBe("```\nSELECT 1\n```")
	})

	it("leaves an inline span alone while converting the text around it", () => {
		expect(toMrkdwn("**run** `a **b** c` now")).toBe("*run* `a **b** c` now")
	})
})
