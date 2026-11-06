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
] as const

/**
 * Every fingerprint version and the digest of the corpus's hash inputs under it.
 * Versions only increase, so inputs that move cannot be recorded without a bump.
 * v3's entry was computed by the v3 code itself, before the bump.
 */
const HISTORY: ReadonlyArray<{ readonly version: number; readonly digest: string }> = [
	{ version: 3, digest: "2b1083177f1c21fe168908eb4db9f228ebfcbaa6a4c03412d4ce83441d6a3173" },
	{ version: 4, digest: "63ea63b3ef048e9e2ab9fe320609b7f0ed529ad935112653147883ad4654585f" },
]

const digestOf = (inputs: (event: (typeof CORPUS)[number]) => ReadonlyArray<string>) =>
	createHash("sha256")
		.update(JSON.stringify(Arr.map(CORPUS, inputs)))
		.digest("hex")
const digest = digestOf((event) => computeFingerprintInputs(event).hashInputs)

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
			digestOf((event) => computeFingerprintInputs(event).previousHashInputs),
			"previousHashInputs no longer reproduces the previous version's hash inputs.",
		).toBe(previous?.digest)
	})
})
