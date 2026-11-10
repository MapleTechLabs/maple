import { describe, expect, it } from "vitest"
import { isSafeScopePath } from "./scope-path"
import { isSafeRelativePath } from "./validators"

const samples = [
	"src",
	"src/api",
	"apps/web/src/page.ts",
	"",
	" src",
	"src ",
	"/etc/passwd",
	"~/secrets",
	"C:/windows",
	"C:windows",
	"a:b",
	"src\\api",
	"src//api",
	"src/./api",
	"src/../api",
	"..",
	".",
	"src/api.",
	"src/api /x",
	"con",
	"src/NUL.txt",
	"src/com1",
	"src/com²",
	"src/lpt9.log",
	"src/console",
	"src/\u0000x",
	"src/\u200bx",
	"src/\u2028x",
	"src/\ud800x",
	"src/é/ü",
	"src/日本語",
]

describe("isSafeScopePath", () => {
	it.each(samples)("agrees with the skill's validator on %j", (sample) => {
		expect(isSafeScopePath(sample)).toBe(isSafeRelativePath(sample))
	})
})
