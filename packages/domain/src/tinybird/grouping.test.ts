import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"

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

	it("leaves the default grouping untouched with no rules, and names no rules with an empty digest", () => {
		const sample = node("TypeError", "boom", ["a (/app/a.ts:1:1)", "b (/app/b.ts:2:2)"])
		expect(groupingKey(sample, rules())).toBe(groupingKey(sample))
		expect(groupingConfigDigest(new GroupingConfig({ rules: [] }))).toBe("")
	})
})
