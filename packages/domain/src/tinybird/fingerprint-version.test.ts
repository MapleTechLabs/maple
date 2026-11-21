import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import { computeFingerprintInputs, FINGERPRINT_VERSION } from "./fingerprint"

/**
 * One stack per shape the fingerprint reads: runtimes, library frames, messages and
 * user keys. A change that moves any of their hash inputs rotates production hashes.
 */
const CORPUS = [
	{
		exceptionType: "TypeError",
		exceptionStacktrace:
			"TypeError: x\n    at getUser (/app/src/users.ts:42:18)\n    at handle (/app/src/routes.ts:9:1)",
		statusMessage: "Cannot read properties of undefined (reading 'id')",
	},
	{
		exceptionType: "ZodError",
		exceptionStacktrace:
			"ZodError\n    at parse (/app/node_modules/zod/lib/types.js:120:7)\n    at saveOrder (/app/src/orders.ts:42:5)",
		statusMessage: '{"issues":[{"path":["email"]}],"name":"ZodError"}',
	},
	{
		exceptionType: "@maple/http/errors/UpstreamUnavailable",
		exceptionStacktrace:
			"    at toUpstreamError (/app/src/upstream.ts:40:11)\n    at listTraces (/app/src/t.ts:1:1)",
		statusMessage: "upstream returned 503 for org_2abcDEF123456789xyz",
	},
	{
		exceptionType: "KeyError",
		exceptionStacktrace: Arr.join(
			[
				"Traceback (most recent call last):",
				'  File "/app/main.py", line 10, in run',
				'  File "/usr/local/lib/python3.12/site-packages/requests/api.py", line 5, in get',
			],
			"\n",
		),
		statusMessage: "'user_id'",
	},
	{
		exceptionType: "java.lang.NullPointerException",
		exceptionStacktrace:
			"\tat java.util.HashMap.get(HashMap.java:10)\n\tat com.acme.Orders.load(Orders.java:42)",
		statusMessage: "Cannot invoke String.length() on null",
	},
	{
		exceptionType: "*errors.errorString",
		exceptionStacktrace:
			"\t/app/handler.go:42 +0x1d\n\t/root/go/pkg/mod/github.com/acme/db@v1.2.3/conn.go:9 +0x2f",
		statusMessage: "dial tcp 10.0.0.12:5432: connect: connection refused",
	},
	{
		exceptionType: "EXC_BAD_ACCESS",
		exceptionStacktrace: "0   My App   0x104112600   +0x1d0f0\n1   UIKitCore   0x1a2b3c4d0   +0x44",
		statusMessage: "EXC_BAD_ACCESS (SIGSEGV)",
	},
	{
		exceptionType: "",
		exceptionStacktrace: "",
		statusMessage:
			"[Error] Unknown identifier `ServiceVersion` in scope SELECT ServiceVersion FROM traces",
	},
	{
		exceptionType: "PaymentError",
		exceptionStacktrace: "    at charge (/app/src/pay.ts:1:1)",
		statusMessage: "card declined",
		customFingerprint: "checkout-payment-declined",
	},
	// What v5 reads differently: minified names, path values, an event's message and
	// Go's one-line frames.
	{
		exceptionType: "TypeError",
		exceptionStacktrace:
			"TypeError: x\n    at Kt.render (https://app.dev/assets/index.js:1:100)\n    at e3 (https://app.dev/assets/index.js:1:9)\n    at a.b.c (https://app.dev/assets/vendor.js:2:7)",
		statusMessage: "t is not a function",
	},
	{
		exceptionType: "TypeError",
		exceptionStacktrace:
			"Bx</o<@https://app.dev/assets/nav.js:7:67883\ne.render@https://app.dev/assets/nav.js:9:12",
		statusMessage: "e.props is undefined",
	},
	{
		exceptionType: "StatusCodeError",
		exceptionStacktrace: "",
		statusMessage:
			"StatusCode error (503 GET https://api.dev/v3/applications/com.acme.app/offers/7d-trial/tokens/PZN8GVZLF8/v1beta1/app.min.js)",
	},
	{
		exceptionType: "Error",
		exceptionStacktrace: "    at deliver (/app/src/notify.ts:1:1)",
		statusMessage: "delivery rejected: telegram credentials unavailable",
		messageFromEvent: true,
	},
	{
		exceptionType: "*errors.errorString",
		exceptionStacktrace:
			"github.com/acme/api/mysql.(*Store).Insert (store.go:3541)\nmain.run (cron.go:206)",
		statusMessage: "context deadline exceeded",
	},
] as const

/** Failures only their span names. They have no previous hash, so only the current digest reads them. */
const SPAN_KEYED = [
	{
		exceptionType: "",
		exceptionStacktrace: "",
		statusMessage: "",
		span: { kind: "Server", name: "POST /queue/run" },
	},
	{
		exceptionType: "500",
		exceptionStacktrace: "",
		statusMessage: "",
		span: { kind: "Server", name: "GET /orders/42" },
	},
] as const

/**
 * Every fingerprint version and the digest of the corpus's hash inputs under it.
 * Versions only increase, so inputs that move cannot be recorded without a bump.
 * v4's entry was computed by the v4 code itself over `CORPUS`, before the bump to v5,
 * with an event's message left unread as v4 left it; v3's predates the rows added with v5.
 */
const HISTORY: ReadonlyArray<{ readonly version: number; readonly digest: string }> = [
	{ version: 3, digest: "2b1083177f1c21fe168908eb4db9f228ebfcbaa6a4c03412d4ce83441d6a3173" },
	{ version: 4, digest: "076d5ae21f4eff906611e3144f1e1f8f8b306ddf5c890607719d8ed213474d05" },
	{ version: 5, digest: "7a19ef45f01a172ccdc861cc8195ac05c09158023545bb93142ffb12c41b2df0" },
]

type CorpusEvent = (typeof CORPUS)[number] | (typeof SPAN_KEYED)[number]
const digestOf = (
	events: ReadonlyArray<CorpusEvent>,
	inputs: (event: CorpusEvent) => ReadonlyArray<string>,
) =>
	createHash("sha256")
		.update(JSON.stringify(Arr.map(events, inputs)))
		.digest("hex")
const digest = digestOf([...CORPUS, ...SPAN_KEYED], (event) => computeFingerprintInputs(event).hashInputs)

describe("FINGERPRINT_VERSION", () => {
	it("is bumped whenever the hash inputs move", () => {
		const latest = HISTORY[HISTORY.length - 1]
		expect(
			{ version: FINGERPRINT_VERSION, digest },
			"The fingerprint hash inputs changed. Bump FINGERPRINT_VERSION (a bump re-keys issues, it does not lose them), then append the new version and the digest shown below to HISTORY.",
		).toEqual(latest)
		const versions = Arr.map(HISTORY, (entry) => entry.version)
		expect(versions).toEqual([...versions].sort((a, b) => a - b))
		expect(new Set(versions).size).toBe(versions.length)
	})

	it("hashes what the previous version hashed, so a bump can re-key its issues", () => {
		// A bump must also teach `previousHashInputs` (and the views' `_prevHash`) the
		// rule it replaced; otherwise lineage names hashes no issue owns.
		const previous = Option.getOrUndefined(
			Arr.findFirst(HISTORY, (entry) => entry.version === FINGERPRINT_VERSION - 1),
		)
		expect(
			digestOf(CORPUS, (event) => computeFingerprintInputs(event).previousHashInputs),
			"previousHashInputs no longer reproduces the previous version's hash inputs.",
		).toBe(previous?.digest)
	})
})
