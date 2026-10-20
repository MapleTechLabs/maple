import { describe, expect, it } from "vitest"
import { MATH_MARK, prepareMath } from "./math"

// remark-math with `singleDollarTextMath: false`, as `@streamdown/math` configures it.

describe("prepareMath", () => {
	it("turns text math into a marked code span and leaves single dollars alone", () => {
		expect(prepareMath("p95 is $$p_{95} \\le 800$$ at $5 a run")).toBe(`p95 is \`${MATH_MARK}p_{95} \\le 800\` at $5 a run`)
	})

	it("turns a $$ fence into a math fence, closing at the end when it never closes", () => {
		expect(prepareMath("Rate:\n$$\nx = \\frac{a}{b}\n$$\nDone.")).toBe("Rate:\n```math\nx = \\frac{a}{b}\n```\nDone.")
		expect(prepareMath("$$\ny = 1")).toBe("```math\ny = 1\n```")
	})

	it("leaves code fences, code spans and escaped dollars as written", () => {
		const fenced = "```sql\nSELECT '$$x$$'\n```"
		expect(prepareMath(fenced)).toBe(fenced)
		expect(prepareMath("`$$a$$` and \\$$b")).toBe("`$$a$$` and \\$$b")
	})

	it("scans left to right, so math opened before a backtick wins over the code span", () => {
		expect(prepareMath("$$a ` b$$ `c`")).toBe(`\`\`${MATH_MARK}a \` b\`\` \`c\``)
	})

	it("strips one padding space from each side of text math", () => {
		expect(prepareMath("$$ x $$")).toBe(`\`${MATH_MARK}x\``)
	})
})
