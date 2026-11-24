import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"

import type { StackFrame, SymbolicatedStack } from "../errors/js-stack"
import { explainGrouping, groupingKey, groupingParts, type GroupingSample } from "./grouping"
import { compileGroupingRules, GroupingConfig, groupingConfigDigest, OrgGroupingRule } from "./grouping-rules"

const node = (
	type: string,
	message: string,
	frames: ReadonlyArray<string>,
	overrides: Partial<GroupingSample> = {},
): GroupingSample => ({
	serviceName: "api",
	exceptionType: type,
	statusMessage: message,
	exceptionStacktrace: Arr.join(
		[`${type}: ${message}`, ...Arr.map(frames, (frame) => `    at ${frame}`)],
		"\n",
	),
	...overrides,
})

describe("groupingKey", () => {
	it("joins a tagged error across deploys that moved it between bundle chunks", () => {
		const before = node("SiteUnavailable", "Site is unavailable under current access", [
			"resolveSite (dist/ssr/assets/design-access-service-BaWgZTwa.js:12:40)",
		])
		const after = node("SiteUnavailable", "Site is unavailable under current access", [
			"Hr (dist/ssr/assets/portal-native-resource-projection-VejMLjva.js:1104:1732)",
		])
		expect(groupingKey(before)).toBe(groupingKey(after))
	})

	it("joins one failure printed under a laptop checkout and a container root", () => {
		const laptop: GroupingSample = {
			serviceName: "api",
			exceptionType: "Error",
			statusMessage: "",
			exceptionStacktrace:
				"Error\n    at handle (/Users/sam/Sites/raak/.claude/worktrees/fix/backend/src/server.ts:43:11)",
		}
		const container = {
			...laptop,
			exceptionStacktrace: "Error\n    at handle (/app/backend/src/server.ts:41:9)",
		}
		expect(groupingKey(laptop)).toBe(groupingKey(container))
	})

	it("keeps a generic error's call sites apart", () => {
		const a = node("TypeError", "Cannot read properties of undefined", [
			"renderInvoice (/app/src/invoice.ts:4:2)",
		])
		const b = node("TypeError", "Cannot read properties of undefined", [
			"renderCart (/app/src/cart.ts:9:1)",
		])
		expect(groupingKey(a)).not.toBe(groupingKey(b))
	})

	it("keeps two messages of one tagged error apart", () => {
		const a = node("CustomerQueryError", 'relation "orders" does not exist', [
			"query (/app/src/db.ts:4:2)",
		])
		const b = node("CustomerQueryError", 'relation "invoices" does not exist', [
			"query (/app/src/db.ts:4:2)",
		])
		expect(groupingKey(a)).not.toBe(groupingKey(b))
	})

	it("keys a tagged error with no message on the first named function", () => {
		const viaLookup = node("StoreVaultError", "", [
			"worker-app-sOddjqIe.js:76:178753",
			"credentialsVault.forwardStore (worker-app-sOddjqIe.js:2465:204564)",
			"AppleSearchAdsProxyService.fetchLookup (worker-app-sOddjqIe.js:2300:1)",
		])
		const viaFetch = node("StoreVaultError", "", [
			"worker-app-BmcrjKiP.js:76:177268",
			"credentialsVault.forwardStore (worker-app-BmcrjKiP.js:2465:204000)",
			"credentialsVault.makeVaultFetch (worker-app-BmcrjKiP.js:2401:7)",
		])
		const elsewhere = node("StoreVaultError", "", [
			"credentialsVault.readStore (worker-app-BmcrjKiP.js:2470:1)",
		])
		expect(groupingParts(viaLookup).rule).toBe("type-function")
		expect(groupingKey(viaLookup)).toBe(groupingKey(viaFetch))
		expect(groupingKey(viaLookup)).not.toBe(groupingKey(elsewhere))
	})

	it("folds every chunk a service failed to load into one key", () => {
		const a = node(
			"TypeError",
			"Failed to fetch dynamically imported module: https://app.example/assets/HomeNav-BWSAQyjh.js",
			[],
		)
		const b = node(
			"TypeError",
			"Failed to fetch dynamically imported module: https://app.example/assets/Billing-C9EyLIyc.js",
			[],
		)
		const otherService = { ...a, serviceName: "web" }
		expect(groupingKey(a)).toBe(groupingKey(b))
		expect(groupingKey(a)).not.toBe(groupingKey(otherService))
	})

	it("lets maple.fingerprint decide, whatever the frames say", () => {
		const a = node("TypeError", "boom", ["a (/app/a.ts:1:1)"], { customFingerprint: "checkout-timeout" })
		const b = node("RangeError", "other", ["b (/app/b.ts:1:1)"], {
			customFingerprint: "checkout-timeout",
		})
		expect(groupingParts(a).rule).toBe("custom")
		expect(groupingKey(a)).toBe(groupingKey(b))
	})

	it("keys an error with no exception on its span, as the hash does", () => {
		const a: GroupingSample = {
			serviceName: "api",
			exceptionType: "500",
			statusMessage: "",
			exceptionStacktrace: "",
			span: { kind: "Server", name: "POST /queue" },
		}
		const b = { ...a, span: { kind: "Server", name: "GET /orders" } }
		expect(groupingParts(a).rule).toBe("span")
		expect(groupingKey(a)).not.toBe(groupingKey(b))
	})
})

describe("grouping key encoding", () => {
	it("keeps a message key apart from a function key with the same text", () => {
		const byMessage = node("PaymentError", "chargeCard", ["x (/app/x.ts:1:1)"])
		const byFunction = node("PaymentError", "", ["chargeCard (/app/pay.ts:1:1)"])
		expect(groupingKey(byMessage)).not.toBe(groupingKey(byFunction))
	})
})

describe("{{default}} keys", () => {
	it("splits the default group by what the key adds, and only by that", () => {
		const tenant = (frame: string, key: string) =>
			node("SiteUnavailable", "Site is unavailable", [frame], { customFingerprint: key })
		const a1 = tenant("resolve (dist/a-BaWgZTwa.js:1:1)", "{{default}} tenant-a")
		const a2 = tenant("Hr (dist/b-VejMLjva.js:9:9)", "{{ default }} tenant-a")
		const b = tenant("resolve (dist/a-BaWgZTwa.js:1:1)", "{{default}} tenant-b")
		expect(groupingKey(a1)).toBe(groupingKey(a2))
		expect(groupingKey(a1)).not.toBe(groupingKey(b))
	})
})

describe("org grouping rules", () => {
	const rules = (...list: ReadonlyArray<ConstructorParameters<typeof OrgGroupingRule>[0]>) =>
		compileGroupingRules(
			new GroupingConfig({ rules: Arr.map(list, (rule) => new OrgGroupingRule(rule)) }),
		)

	it("a merge rule joins every matching error of a service, whatever the message", () => {
		const timeouts = rules({ id: "db-timeouts", kind: "merge", message: "*timed out*" })
		const a = node("TypeError", "query on orders timed out after 30s", ["a (/app/a.ts:1:1)"])
		const b = node("RangeError", "insert into events timed out", ["b (/app/b.ts:1:1)"])
		const other = node("TypeError", "connection refused", ["a (/app/a.ts:1:1)"])
		expect(explainGrouping(a, timeouts).orgRule?.id).toBe("db-timeouts")
		expect(groupingKey(a, timeouts)).toBe(groupingKey(b, timeouts))
		expect(groupingKey(other, timeouts)).not.toBe(groupingKey(a, timeouts))
	})

	it("a library-frames rule keys an error on its caller instead of a shared package", () => {
		const shared = rules({ id: "acme-http", kind: "library-frames", frame: "*packages/http/*" })
		const viaCheckout = node("FetchFailed", "", [
			"request (/app/packages/http/client.ts:4:2)",
			"loadCart (/app/checkout/cart.ts:9:1)",
		])
		const viaBilling = node("FetchFailed", "", [
			"request (/app/packages/http/client.ts:4:2)",
			"loadInvoice (/app/billing/invoice.ts:3:3)",
		])
		expect(groupingKey(viaCheckout)).toBe(groupingKey(viaBilling))
		expect(groupingKey(viaCheckout, shared)).not.toBe(groupingKey(viaBilling, shared))
		expect(explainGrouping(viaCheckout, shared).skippedFrames).toHaveLength(1)
	})

	it("lets a later rule override an earlier broad one, and matches services by glob", () => {
		const layered = rules(
			{ id: "all-type-errors", kind: "merge", exceptionType: "TypeError" },
			{ id: "checkout-plan", kind: "merge", service: "checkout-*", message: "*plan*" },
		)
		const plan = node("TypeError", "plan missing", ["a (/app/a.ts:1:1)"], { serviceName: "checkout-web" })
		const other = node("TypeError", "cart empty", ["a (/app/a.ts:1:1)"], { serviceName: "checkout-web" })
		expect(explainGrouping(plan, layered).orgRule?.id).toBe("checkout-plan")
		expect(explainGrouping(other, layered).orgRule?.id).toBe("all-type-errors")
	})

	it("applies a frame rule only to the errors its other fields name", () => {
		const scoped = rules({
			id: "http",
			kind: "library-frames",
			exceptionType: "FetchFailed",
			frame: "*packages/http/*",
		})
		const frames = ["request (/app/packages/http/client.ts:4:2)", "loadCart (/app/checkout/cart.ts:9:1)"]
		expect(explainGrouping(node("FetchFailed", "", frames), scoped).skippedFrames).toHaveLength(1)
		expect(explainGrouping(node("OtherFailed", "", frames), scoped).skippedFrames).toHaveLength(0)
	})

	it("matches a hostile glob against a long message in bounded time", () => {
		const hostile = rules({ id: "h", kind: "merge", message: `${Str.repeat(40)("*a")}*b` })
		const started = performance.now()
		groupingKey(node("TypeError", Str.repeat(5000)("a"), []), hostile)
		expect(performance.now() - started).toBeLessThan(200)
	})

	it("leaves the default grouping untouched with no rules, and names no rules with an empty digest", () => {
		const sample = node("TypeError", "boom", ["a (/app/a.ts:1:1)", "b (/app/b.ts:2:2)"])
		expect(groupingKey(sample, rules())).toBe(groupingKey(sample))
		expect(groupingConfigDigest(new GroupingConfig({ rules: [] }))).toBe("")
	})
})

describe("source-mapped frames", () => {
	const unresolvedFrame = (raw: string): StackFrame => ({
		raw,
		function: null,
		file: null,
		line: null,
		column: null,
		in_app: true,
		resolved: false,
		context: null,
	})
	const mappedFrame = (raw: string, fn: string | null, file: string): StackFrame => ({
		raw,
		function: fn,
		function_from_map: fn !== null,
		file,
		line: 12,
		column: 4,
		in_app: !Str.includes("node_modules/")(file),
		resolved: true,
		context: null,
	})
	const stackOf = (frames: ReadonlyArray<StackFrame>): SymbolicatedStack => {
		const resolved = Arr.filter(frames, (frame) => frame.resolved).length
		return {
			status: resolved === 0 ? "missing_map" : resolved === frames.length ? "resolved" : "partial",
			frames,
			missing: [],
		}
	}
	const withStack = (sample: GroupingSample, frames: ReadonlyArray<StackFrame>): GroupingSample => ({
		...sample,
		symbolicatedStack: stackOf(frames),
	})

	it("keeps today's key when the lookup resolves nothing", () => {
		const fixtures: ReadonlyArray<GroupingSample> = [
			node("TypeError", "Cannot read properties of undefined", [
				"a (https://app.example/assets/index-Bx81.js:1:4410)",
			]),
			node("StoreVaultError", "", [
				"credentialsVault.forwardStore (worker-app-sOddjqIe.js:2465:204564)",
			]),
			node("SiteUnavailable", "Site is unavailable under current access", [
				"Hr (dist/ssr/assets/portal-native-resource-projection-VejMLjva.js:1104:1732)",
			]),
			{
				serviceName: "api",
				exceptionType: "Error",
				statusMessage: "",
				exceptionStacktrace: "Error\n    at handle (/app/backend/src/server.ts:41:9)",
			},
		]
		Arr.forEach(fixtures, (sample) => {
			const frames = Arr.map(
				Arr.filter(Str.split("\n")(sample.exceptionStacktrace), (line) => Str.includes(" at ")(line)),
				unresolvedFrame,
			)
			const missing = withStack(sample, frames)
			const notApplicable: GroupingSample = {
				...sample,
				symbolicatedStack: { status: "not_applicable", frames, missing: [] },
			}
			// Mapped, but only into a dependency: no app frame to key on.
			const libraryOnly = withStack(
				sample,
				Arr.map(frames, (frame) => mappedFrame(frame.raw, "request", "node_modules/ky/index.js")),
			)
			expect(groupingKey(missing)).toBe(groupingKey(sample))
			expect(groupingKey(notApplicable)).toBe(groupingKey(sample))
			expect(groupingKey(libraryOnly)).toBe(groupingKey(sample))
			expect(groupingParts(missing).rule).toBe(groupingParts(sample).rule)
		})
	})

	it("keys a generic error on original files and functions, never lines", () => {
		const release = (bundle: string, minified: string, line: number) => {
			const raw = `at ${minified} (https://app.example/assets/${bundle}.js:1:${line})`
			const sample = node("TypeError", "Cannot read properties of undefined", [
				`${minified} (https://app.example/assets/${bundle}.js:1:${line})`,
			])
			return withStack(sample, [
				{ ...mappedFrame(raw, "renderInvoice", "src/invoice.ts"), line, column: line },
			])
		}
		const v1 = release("index-Bx81", "a", 100)
		const v2 = release("index-Qz07", "xe", 2000)
		expect(groupingKey(stripStack(v1))).not.toBe(groupingKey(stripStack(v2)))
		expect(groupingKey(v1)).toBe(groupingKey(v2))
		const why = explainGrouping(v1)
		expect(why.rule).toBe("source-mapped")
		expect(why.frames).toEqual(["at renderInvoice (src/invoice.ts)"])
	})

	it("keeps the rules above frames in front: custom keys, org merges, chunk loads, type and message", () => {
		const frames = [
			mappedFrame("at a (https://app.example/a-1.js:1:1)", "renderInvoice", "src/invoice.ts"),
		]
		const custom = withStack(node("TypeError", "boom", ["a (https://app.example/a-1.js:1:1)"]), frames)
		const keyed = { ...custom, customFingerprint: "invoice" }
		expect(groupingParts(keyed).rule).toBe("custom")
		const extended = { ...custom, customFingerprint: "{{default}} tenant-a" }
		expect(groupingParts(extended).parts).toContain("tenant-a")
		expect(groupingParts(extended).rule).toBe("source-mapped")

		const merge = compileGroupingRules(
			new GroupingConfig({
				rules: [new OrgGroupingRule({ id: "booms", kind: "merge", message: "boom" })],
			}),
		)
		expect(groupingParts(custom, merge).rule).toBe("org-rule")

		const chunk = withStack(
			node("TypeError", "Failed to fetch dynamically imported module: https://app.example/a-1.js", []),
			frames,
		)
		expect(groupingParts(chunk).rule).toBe("chunk-load")

		const tagged = withStack(
			node("InvoiceMissing", "no invoice", ["a (https://app.example/a-1.js:1:1)"]),
			frames,
		)
		expect(groupingParts(tagged).rule).toBe("type-message")
		expect(groupingKey(tagged)).toBe(groupingKey(stripStack(tagged)))
	})

	it("tells unnamed throw sites in one file apart by their source line, not its number", () => {
		const site = (bundle: string, minified: string, line: number, text: string | null) => {
			const raw = `at ${minified} (https://app.example/assets/${bundle}.js:1:${line})`
			const sample = node("TypeError", "Cannot read properties of undefined (reading 'total')", [
				`${minified} (https://app.example/assets/${bundle}.js:1:${line})`,
			])
			// No caller names the frame, so it keeps its minified name.
			return withStack(sample, [
				{
					...mappedFrame(raw, minified, "src/checkout.ts"),
					function_from_map: false,
					line,
					context: text === null ? null : { pre: [], line: text, post: [] },
				},
			])
		}
		const invoice = site("index-Bx81", "a", 40, "  return invoice.total")
		const payment = site("index-Bx81", "b", 90, "  return payment.total")
		expect(groupingKey(invoice)).not.toBe(groupingKey(payment))
		expect(explainGrouping(invoice).frames).toEqual(["at src/checkout.ts | return invoice.total"])

		// The same throw site after a deploy: new bundle, new minified name, lines moved.
		const invoiceNext = site("index-Qz07", "xe", 52, "\treturn   invoice.total ")
		expect(groupingKey(invoiceNext)).toBe(groupingKey(invoice))

		// With neither a name nor source text, the mapped key would be the file alone: raw key instead.
		const bare = site("index-Bx81", "a", 40, null)
		expect(groupingKey(bare)).toBe(groupingKey(stripStack(bare)))
		expect(groupingParts(bare).rule).toBe("frames")
	})

	it("keeps a map-supplied name that happens to equal the generated one", () => {
		const release = (bundle: string, generated: string) =>
			withStack(node("TypeError", "boom", [`${generated} (https://app.example/${bundle}.js:1:9)`]), [
				mappedFrame(
					`at ${generated} (https://app.example/${bundle}.js:1:9)`,
					"renderInvoice",
					"src/invoice.ts",
				),
			])
		// An unminified build keeps the original name; a minified one renames it. Both map to it.
		expect(groupingKey(release("plain", "renderInvoice"))).toBe(groupingKey(release("min", "a")))
		expect(explainGrouping(release("plain", "renderInvoice")).frames).toEqual([
			"at renderInvoice (src/invoice.ts)",
		])
	})

	it("keys a tagged error with no message on the original function", () => {
		const raw = (name: string, bundle: string) => `at ${name} (https://app.example/${bundle}.js:1:9)`
		const v1 = withStack(node("StoreVaultError", "", [`Hr (https://app.example/w-1.js:1:9)`]), [
			mappedFrame(raw("Hr", "w-1"), "forwardStore", "src/vault.ts"),
		])
		const v2 = withStack(node("StoreVaultError", "", [`Tq (https://app.example/w-2.js:1:9)`]), [
			mappedFrame(raw("Tq", "w-2"), "forwardStore", "src/vault.ts"),
		])
		const other = withStack(node("StoreVaultError", "", [`Tq (https://app.example/w-2.js:1:9)`]), [
			mappedFrame(raw("Tq", "w-2"), "readStore", "src/vault.ts"),
		])
		expect(groupingParts(v1).rule).toBe("source-mapped")
		expect(groupingKey(v1)).toBe(groupingKey(v2))
		expect(groupingKey(v1)).not.toBe(groupingKey(other))
	})
})

const stripStack = ({ symbolicatedStack: _stack, ...sample }: GroupingSample): GroupingSample => sample
