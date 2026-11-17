import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { renderUpdateBody } from "./markdown"

const LINK = 'rel="noopener nofollow ugc"'

const elapsed = (run: () => string): number => {
	const start = performance.now()
	run()
	return performance.now() - start
}

/**
 * How many times longer `whole` takes than `half`. Runs alternate and each side keeps its fastest,
 * so a busy machine slows both alike; the lowest of three rounds drops a round that was disturbed.
 */
const growth = (half: () => string, whole: () => string): number =>
	Math.min(
		...Arr.makeBy(3, () => {
			const runs = Arr.makeBy(7, () => ({ half: elapsed(half), whole: elapsed(whole) }))
			const fastestHalf = Math.min(...Arr.map(runs, (run) => run.half))
			const fastestWhole = Math.min(...Arr.map(runs, (run) => run.whole))
			return fastestWhole / Math.max(fastestHalf, 0.01)
		}),
	)

describe("renderUpdateBody", () => {
	it("renders paragraphs, line breaks and both kinds of list", () => {
		expect(renderUpdateBody("We are investigating.\nMore soon.\n\nThanks for your patience.")).toBe(
			"<p>We are investigating.<br>More soon.</p><p>Thanks for your patience.</p>",
		)
		expect(
			renderUpdateBody("Affected:\n- API\n- Dashboard\n  in the EU region\n\n1. Restart\n2) Verify"),
		).toBe(
			"<p>Affected:</p><ul><li>API</li><li>Dashboard in the EU region</li></ul><ol><li>Restart</li><li>Verify</li></ol>",
		)
		expect(renderUpdateBody("line one\r\nline two\r\n\r\n* item")).toBe(
			"<p>line one<br>line two</p><ul><li>item</li></ul>",
		)
		expect(renderUpdateBody("- first\n\n- second\ntext after")).toBe(
			"<ul><li>first</li></ul><ul><li>second</li></ul><p>text after</p>",
		)
	})

	it("renders bold, italic, code, links and bare URLs", () => {
		expect(
			renderUpdateBody(
				"Use **bold**, *italic* and `code <b>`. See [the runbook](https://example.com/run?a=1&b=2) or https://example.com/status.",
			),
		).toBe(
			`<p>Use <strong>bold</strong>, <em>italic</em> and <code>code &lt;b&gt;</code>. See <a href="https://example.com/run?a=1&amp;b=2" ${LINK}>the runbook</a> or <a href="https://example.com/status" ${LINK}>https://example.com/status</a>.</p>`,
		)
	})

	it("escapes raw HTML and leaves a link to an unsafe address as text", () => {
		expect(renderUpdateBody('[click](javascript:alert(1)) <script>alert(1)</script> & "quotes"')).toBe(
			"<p>[click](javascript:alert(1)) &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p>",
		)
	})

	it("links a label or an address of ordinary length, and leaves an oversized one as text", () => {
		const label = Str.repeat(40)("status ")
		expect(renderUpdateBody(`[${label}](https://example.com/a)`)).toBe(
			`<p><a href="https://example.com/a" ${LINK}>${label}</a></p>`,
		)
		const huge = Str.repeat(600)("x")
		expect(renderUpdateBody(`[${huge}](https://example.com/a)`)).toContain(`<p>[${huge}](<a href=`)
		const path = Str.repeat(3_000)("p")
		expect(renderUpdateBody(`[docs](https://example.com/${path})`)).toContain("<p>[docs](<a href=")
	})

	it("escapes a line longer than any update body without parsing it for marks", () => {
		const line = Str.repeat(5_000)("**b** <i> ")
		expect(renderUpdateBody(line)).toBe(`<p>${Str.repeat(5_000)("**b** &lt;i&gt; ")}</p>`)
		// A short line beside it is still parsed.
		expect(renderUpdateBody(`**b**\n${line}`)).toContain("<p><strong>b</strong><br>**b** &lt;i&gt; ")
	})
})

describe("renderUpdateBody cost", () => {
	// Growth is compared between two input sizes where it can be. The fixed time limits are many
	// times what the renderer needs and a fraction of what work growing with the square would take.

	it("renders a 20,000-character line of open brackets as text, in time that grows with its length", () => {
		const brackets = (count: number) => Str.repeat(count)("[")
		expect(renderUpdateBody(brackets(20_000))).toBe(`<p>${brackets(20_000)}</p>`)
		// Twice the input is about twice the work; four times would mean each bracket rescans the line.
		expect(
			growth(
				() => renderUpdateBody(brackets(10_000)),
				() => renderUpdateBody(brackets(20_000)),
			),
		).toBeLessThan(3)
	})

	it("renders a line of unfinished links in time that grows with its length", () => {
		const links = (count: number) => Str.repeat(count)("[a](x")
		expect(renderUpdateBody(links(4_000))).toBe(`<p>${links(4_000)}</p>`)
		expect(
			growth(
				() => renderUpdateBody(links(2_000)),
				() => renderUpdateBody(links(4_000)),
			),
		).toBeLessThan(3)
	})

	it("renders a line far past the cap without scanning it per bracket", () => {
		const line = Str.repeat(200_000)("[")
		const start = performance.now()
		expect(renderUpdateBody(line)).toBe(`<p>${line}</p>`)
		expect(performance.now() - start).toBeLessThan(1_000)
	})

	it("renders a body of 100,000 one-character lines, as one paragraph, many paragraphs or a list", () => {
		const count = 100_000
		const start = performance.now()
		expect(renderUpdateBody(Str.repeat(count)("a\n"))).toBe(
			`<p>${Arr.join(
				Arr.makeBy(count, () => "a"),
				"<br>",
			)}</p>`,
		)
		expect(renderUpdateBody(Str.repeat(count)("a\n\n"))).toBe(Str.repeat(count)("<p>a</p>"))
		expect(renderUpdateBody(Str.repeat(count)("- a\n"))).toBe(
			`<ul>${Str.repeat(count)("<li>a</li>")}</ul>`,
		)
		expect(renderUpdateBody(`- a\n${Str.repeat(count)(" b\n")}`)).toBe(
			`<ul><li>a${Str.repeat(count)(" b")}</li></ul>`,
		)
		expect(performance.now() - start).toBeLessThan(2_000)
	})
})
