import { describe, expect, it } from "vitest"
import {
	chPattern,
	computeFingerprintInputs,
	EFFECT_SPAN_FRAME_MARKER,
	ERROR_MSG_REDACTIONS,
	FINGERPRINT_HASH_SALT,
	FRAME_LINE_PATTERN,
	FRAME_REDACTIONS,
	JSON_VALUE_REDACTIONS,
	MAX_FINGERPRINT_FRAMES,
	MSG_SCAN_CHARS,
	MSG_SIGNATURE_CHARS,
	NAMESPACED_TYPE_MAX_FRAMES,
	SCHEMA_PATH_LINE_PATTERN,
	SPAN_NAME_FRAME_PATTERN,
} from "./fingerprint"
import { ERROR_EVENTS_MV_SQL } from "./materializations"

describe("error fingerprint normalization", () => {
	it("extracts and normalizes top 3 Node.js frames", () => {
		const stack = [
			"TypeError: Cannot read properties of undefined (reading 'id')",
			"    at getUser (/app/src/users.ts:42:18)",
			"    at handler (/app/src/routes/user.ts:17:21)",
			"    at process (/app/src/server.ts:88:12)",
			"    at Server._events (internal/server.js:512:9)",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "TypeError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		expect(result.topFrame).toBe("    at getUser (/app/src/users.ts)")
		expect(result.fpFrames.split("\n")).toHaveLength(3)
		expect(result.fpFrames).toContain("getUser")
		expect(result.fpFrames).toContain("handler")
		expect(result.fpFrames).toContain("process")
		expect(result.msgSignature).toBe("")
	})

	it("skips Python 'Traceback' header and picks the File lines", () => {
		const stack = [
			"Traceback (most recent call last):",
			'  File "/app/main.py", line 42, in get_user',
			"    user = db.query(user_id)",
			'  File "/app/db.py", line 101, in query',
			"    raise ValueError(f'bad id {user_id}')",
			"ValueError: bad id 12345",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "ValueError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		// Header line is skipped; Python prints the raise site last, so it is read first.
		expect(result.topFrame).toBe('  File "/app/db.py", , in query')
		expect(result.fpFrames).toContain("/app/main.py")
		// Line numbers are stripped; identifiers remain.
		expect(result.topFrame).not.toMatch(/line 42/)
	})

	it("strips Java line numbers and keeps frame identifiers", () => {
		const stack = [
			'java.lang.NullPointerException: Cannot invoke "String.length()"',
			"\tat com.example.UserService.getUser(UserService.java:45)",
			"\tat com.example.UserController.handle(UserController.java:23)",
			"\tat com.example.Main.main(Main.java:12)",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "java.lang.NullPointerException",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		expect(result.topFrame).toContain("UserService.getUser")
		expect(result.topFrame).toContain("UserService.java)")
		expect(result.topFrame).not.toMatch(/:45/)
		expect(result.fpFrames.split("\n")).toHaveLength(3)
	})

	it("ignores language-specific header lines that have no :NUMBER", () => {
		const stack = [
			"RuntimeError: something went wrong 0xdeadbeef",
			"\tat main.go:10 +0x1234",
			"\tat runtime.go:50 +0x5678",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "RuntimeError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		// Header ("RuntimeError: ...") contains no :NUMBER and is skipped.
		expect(result.topFrame).toContain("main.go")
		expect(result.topFrame).not.toContain("RuntimeError")
		// Hex pointers are stripped.
		expect(result.fpFrames).not.toMatch(/0x[0-9a-fA-F]+/)
	})

	it("produces stable fpFrames under line-number churn", () => {
		const stackA = "    at f (/a.ts:10:5)\n    at g (/b.ts:20:5)"
		const stackB = "    at f (/a.ts:99:1)\n    at g (/b.ts:200:9)"

		const a = computeFingerprintInputs({
			exceptionType: "Error",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "Error",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		expect(a.fpFrames).toBe(b.fpFrames)
	})

	it("produces stable fpFrames under trace/span id churn in the frame line", () => {
		// The real defect behind 634 duplicate @maple/cli/IngestRejected issues: the
		// first stack line carried a trace id, and only `:<line>` was redacted.
		const stackA =
			"    at ingest (/app/cli.ts:10:5) traceId=4bf92f3577b34da6a3ce929d0e0e4736 req=1048576\n    at g (/b.ts:20:5)"
		const stackB =
			"    at ingest (/app/cli.ts:10:5) traceId=00f067aa0ba902b7a1b2c3d4e5f60718 req=2097152\n    at g (/b.ts:20:5)"

		const a = computeFingerprintInputs({
			exceptionType: "IngestRejected",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "IngestRejected",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		expect(a.fpFrames).toBe(b.fpFrames)
		expect(a.topFrame).toBe(b.topFrame)
		expect(a.fpFrames).not.toMatch(/[0-9a-fA-F]{8,}/)
	})

	it("distinguishes different call sites even when the top frame is shared", () => {
		const shared = "    at JSON.parse (/node_modules/json/index.js:5:10)"
		const stackA = `${shared}\n    at loadConfig (/app/config.ts:42:5)`
		const stackB = `${shared}\n    at loadUser (/app/user.ts:99:3)`

		const a = computeFingerprintInputs({
			exceptionType: "SyntaxError",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "SyntaxError",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		// Top frame is the same shared library site, but deeper frames differ,
		// so fpFrames (which feeds the hash) must differ.
		expect(a.topFrame).toBe(b.topFrame)
		expect(a.fpFrames).not.toBe(b.fpFrames)
	})

	describe("frame shape matching", () => {
		// Every case here is a real production stack that the old
		// "contains :NUMBER" rule accepted as a frame, putting variable text into
		// the hash. Together they accounted for ~66k of 68.5k fingerprints.

		it("does not treat Drizzle's params line as a frame", () => {
			// The params line carries the actual row values — uuid, org id, customer
			// email, branch names, timestamps — so one bug became one issue per row:
			// 15,051 fingerprints for 13 real call sites.
			const stack = [
				'@maple/api/lib/DatabaseError: Failed query: insert into "planetscale_events"',
				"params: e6261d5f-bee7-4f98-a313-42cb91f5f5bc,org_3AuiNC,deploy_request.opened,36,david@superwall.com,2026-08-05T00:30:19.311Z",
				"    at toDatabaseError (worker.js:1542:13655)",
				"    at worker.js:14:7233",
			].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/api/lib/DatabaseError",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toContain("toDatabaseError")
			expect(result.fpFrames).not.toContain("params:")
			expect(result.fpFrames).not.toContain("@superwall.com")
		})

		it("does not treat a multi-line SQL body as frames", () => {
			// `from (values ($2::text, ...))` matched the Ruby `from ` alternative
			// until it was required to carry a `path:line`.
			const stack = [
				"@maple/api/lib/DatabaseError: Failed query: update x",
				"\t\t\t\tfrom (values ($2::text, $3::timestamptz, $4::integer)) as v(id, seen, cnt)",
				"    at toDatabaseError (worker.js:1542:13655)",
			].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/api/lib/DatabaseError",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toContain("toDatabaseError")
			expect(result.fpFrames).not.toContain("values")
		})

		it("does not treat the `Type: message` header as a frame", () => {
			// `Code: 62` and `position 1628` made the header look frame-shaped, so
			// the embedded query text entered the hash: 19,667 fingerprints for 23
			// real call sites.
			const header =
				'@maple/cli/IngestRejected: chDB insert (traces): Code: 62. Syntax error: failed at position 1628 (\'{"start_time":"2026-08-15 14:32:11"}\')'
			const stack = [header, "    at <anonymous> (/$bunfs/root/maple:61585:39)"].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/cli/IngestRejected",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toBe("    at <anonymous> (maple)")
			expect(result.fpFrames).not.toContain("position")
			expect(result.fpFrames).not.toContain("start_time")
		})

		it("groups the same bug across preview hosts and redeploys", () => {
			// Vite rewrites the 8-char content hash on every build, and preview
			// deploys serve from their own host; on the old rule each combination
			// was a separate issue for the same bug.
			const a = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace:
					"    at catch (https://app.maple.dev/assets/atom-client-eWeX5omb.js:1:2)",
				statusMessage: "",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace:
					"    at catch (https://app-pr-246.maple.dev/assets/atom-client-DpaqQq9R.js:9:9)",
				statusMessage: "",
			})

			expect(a.fpFrames).toBe(b.fpFrames)
			expect(a.fpFrames).toContain("/assets/atom-client.js")
		})

		it("accepts a Firefox/Safari `func@url:line:col` frame", () => {
			const result = computeFingerprintInputs({
				exceptionType: "TypeError",
				exceptionStacktrace: "getUser@https://app.maple.dev/assets/index-s17g7I3p.js:42:18",
				statusMessage: "",
			})

			expect(result.topFrame).toBe("getUser@/assets/index.js")
		})

		it("falls back to the signature when a stack has no frame-shaped lines", () => {
			const result = computeFingerprintInputs({
				exceptionType: "SomeError",
				exceptionStacktrace: "SomeError: everything is on fire at 12:30",
				statusMessage: "everything is on fire at 12:30",
			})

			expect(result.fpFrames).toBe("")
			expect(result.msgSignature).toBe("everything is on fire at #:#")
		})
	})

	describe("message signature", () => {
		it("redacts IDs and numbers from StatusMessage when no stack is present", () => {
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "failed to load user 12345 from tenant abcdef1234",
			})

			expect(result.fpFrames).toBe("")
			expect(result.msgSignature).toBe("failed to load user # from tenant #")
		})

		it("groups two status-only errors with the same shape but different IDs", () => {
			const a = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "db timeout on query 42",
			})
			const b = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "db timeout on query 9999",
			})

			expect(a.msgSignature).toBe(b.msgSignature)
		})

		it("still computes the signature when only an exception type is present (no frames)", () => {
			// Previously the signature was gated on exceptionType === "", which let
			// generic types like "HttpServerError" or "Error" monopolize one bucket
			// per service. With frames absent, the normalized message must
			// differentiate occurrences regardless of whether a type was set.
			const result = computeFingerprintInputs({
				exceptionType: "TimeoutError",
				exceptionStacktrace: "",
				statusMessage: "db timeout 12345",
			})

			expect(result.msgSignature).toBe("db timeout #")
		})

		it("splits a generic ExceptionType bucket by normalized StatusMessage", () => {
			const a = computeFingerprintInputs({
				exceptionType: "HttpServerError",
				exceptionStacktrace: "",
				statusMessage: "RouteNotFound (GET /robots.txt)",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpServerError",
				exceptionStacktrace: "",
				statusMessage: "RequestParseError (POST /api/query): body too large",
			})

			expect(a.msgSignature).not.toBe(b.msgSignature)
			expect(b.msgSignature).toContain("/api/query")
		})

		it("folds every unmatched path into one route-not-found issue per method", () => {
			// Scanners probe hundreds of paths; each used to mint its own issue.
			const signature = (statusMessage: string) =>
				computeFingerprintInputs({
					exceptionType: "HttpServerError",
					exceptionStacktrace: "",
					statusMessage,
				}).msgSignature
			for (const [a, b] of [
				[
					"RouteNotFound (GET /.env)",
					"RouteNotFound (GET /wp-content/plugins/x/connector.php?lang=en)",
				],
				["Cannot GET /.git/index", "Cannot GET /admin/phpmyadmin/"],
				["Route GET:/.env not found", "Route GET:/backup.sql not found"],
				['No route found for "GET https://x.dev/.env"', 'No route found for "GET /a (b)"'],
			]) {
				expect(signature(a)).toBe(signature(b))
			}
			expect(signature("RouteNotFound (GET /.env)")).not.toBe(signature("RouteNotFound (POST /.env)"))
			// The fold ends at the path: a cause on the next line still separates two bugs.
			for (const prefix of [
				"Cannot GET /missing",
				"RouteNotFound (GET /missing)",
				"Route GET:/missing not found",
			]) {
				expect(signature(`${prefix}\nDatabaseTimeout`)).not.toBe(
					signature(`${prefix}\nPermissionDenied`),
				)
			}
			expect(signature('No route found for "GET /a\nDatabaseTimeout"')).not.toBe(
				signature('No route found for "GET /a\nPermissionDenied"'),
			)
		})

		it("splits a malformed-ExceptionType bucket (JSON-prefix leak) by message", () => {
			// Regression guard: if upstream instrumentation ever leaks a truncated
			// JSON prefix like `{ "type"` into exception.type, distinct underlying
			// errors must still produce distinct signatures.
			const a = computeFingerprintInputs({
				exceptionType: '{ "type"',
				exceptionStacktrace: "",
				statusMessage: "StripeCardError: card_declined for customer cus_abc",
			})
			const b = computeFingerprintInputs({
				exceptionType: '{ "type"',
				exceptionStacktrace: "",
				statusMessage: "StripeInvalidRequestError: No such price: price_xyz",
			})

			expect(a.msgSignature).not.toBe(b.msgSignature)
		})

		it("computes the signature even when frames are present", () => {
			// The signature is folded in ALWAYS. A bundled runtime minifies every
			// module into one file, so two different bugs in the same Worker share
			// their top three frames; without the signature they collapse into one
			// issue (25 distinct DatabaseError bugs did exactly that in production).
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "    at f (/a.ts:10:5)",
				statusMessage: "status only 123",
			})

			expect(result.msgSignature).toBe("status only #")
		})

		it("collapses a query string, which is pure value", () => {
			const sig = (url: string) =>
				computeFingerprintInputs({
					exceptionType: "TransportError",
					exceptionStacktrace: "",
					statusMessage: `Transport error (GET ${url})`,
				}).msgSignature

			expect(sig("/api/traces?org=acme&cursor=deadbeefcafe")).toBe(
				sig("/api/traces?org=wayne&cursor=0f8fad5bd9cb"),
			)
			// The route itself still separates two different endpoints failing.
			expect(sig("/api/traces?org=acme")).not.toBe(sig("/api/spans?org=acme"))
		})

		it("collapses a quoted path but keeps a quoted identifier", () => {
			const sig = (message: string) =>
				computeFingerprintInputs({
					exceptionType: "StoreError",
					exceptionStacktrace: "",
					statusMessage: message,
				}).msgSignature

			// A path in quotes is a value: two developers' stores are one bug.
			expect(sig("cannot open '/Users/ada/.maple/store/local.db'")).toBe(
				sig("cannot open '/Users/grace/.maple/store/local.db'"),
			)
			// A quoted schema identifier is bounded, and naming it is the signal.
			expect(sig("column 'occurrence_count' missing")).not.toBe(
				sig("column 'fingerprint_hash' missing"),
			)
		})

		it("collapses a long opaque token in quotes", () => {
			const sig = (token: string) =>
				computeFingerprintInputs({
					exceptionType: "AuthError",
					exceptionStacktrace: "",
					statusMessage: `rejected key '${token}'`,
				}).msgSignature

			expect(sig("mk_live_QZmxNbPvWyKdTgHsRjLcVuAeXo")).toBe(sig("mk_live_JpFwTnBkYdSaHgMzXeRvCuLqOi"))
		})

		it("does not let an apostrophe in prose swallow the rest of the message", () => {
			const result = computeFingerprintInputs({
				exceptionType: "DatabaseError",
				exceptionStacktrace: "",
				statusMessage: `Table 'orders' doesn't exist in schema '/tenants/acme/public'`,
			})

			// The trailing quoted path is redacted; the prose and the bounded
			// identifier either side of it survive intact.
			expect(result.msgSignature).toContain("Table 'orders' doesn")
			expect(result.msgSignature).toContain("'#'")
			expect(result.msgSignature).not.toContain("acme")
		})

		it("separates two bugs that share identical minified frames", () => {
			const frames = "    at toDatabaseError (worker.js:1542:13655)\n    at worker.js:14:7233"
			const a = computeFingerprintInputs({
				exceptionType: "DatabaseError",
				exceptionStacktrace: frames,
				statusMessage: 'Failed query: insert into "planetscale_events"',
			})
			const b = computeFingerprintInputs({
				exceptionType: "DatabaseError",
				exceptionStacktrace: frames,
				statusMessage: 'Failed query: insert into "anomaly_detector_states"',
			})

			expect(a.fpFrames).toBe(b.fpFrames)
			expect(a.msgSignature).not.toBe(b.msgSignature)
		})

		it("truncates long StatusMessage to 120 characters after redaction", () => {
			const long = "x".repeat(500)
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: long,
			})

			expect(result.msgSignature.length).toBeLessThanOrEqual(120)
		})

		it("keeps the route but drops the origin, so preview hosts share one issue", () => {
			const a = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace: "",
				statusMessage: "Transport error (POST https://app.maple.dev/api/query-engine/overview)",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace: "",
				statusMessage:
					"Transport error (POST https://app-pr-246.maple.dev/api/query-engine/overview)",
			})

			expect(a.msgSignature).toBe(b.msgSignature)
			expect(a.msgSignature).toContain("/api/query-engine/overview")
		})

		it("collapses a home-directory path to PATH, so two users' stores are one bug", () => {
			const a = computeFingerprintInputs({
				exceptionType: "IngestRejected",
				exceptionStacktrace: "",
				statusMessage: "Cannot open file /Users/riordan/.maple/data/store: No space left on device",
			})
			const b = computeFingerprintInputs({
				exceptionType: "IngestRejected",
				exceptionStacktrace: "",
				statusMessage:
					"Cannot open file /Users/juanbermudez/.maple/data/store: No space left on device",
			})

			expect(a.msgSignature).toBe(b.msgSignature)
			expect(a.msgSignature).toBe("Cannot open file PATH: No space left on device")
		})

		it("redacts an email address out of the signature", () => {
			// Drizzle's `params:` line put customer emails into the fingerprint and
			// into error_issues.top_frame. Frame shape matching keeps that line out
			// of the hash; this keeps an address out of the signature too.
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "insert failed for david@superwall.com",
			})

			expect(result.msgSignature).not.toContain("@superwall.com")
			expect(result.msgSignature).toBe("insert failed for EMAIL")
		})
	})

	describe("JSON-object signature (key-name-agnostic)", () => {
		const sig = (statusMessage: string) =>
			computeFingerprintInputs({ exceptionType: "", exceptionStacktrace: "", statusMessage })
				.msgSignature

		it("builds a sorted key=value signature over all top-level keys", () => {
			expect(
				sig(
					'{"type":"https://e/rate-limit","title":"Rate limited","detail":"retry in 5s","status":429}',
				),
			).toBe('detail="retry in #s"|status=#|title="Rate limited"|type="/rate-limit"')
		})

		it("is insensitive to key order", () => {
			expect(sig('{"title":"X","code":"E1"}')).toBe(sig('{"code":"E1","title":"X"}'))
		})

		it("is robust to volatile numeric/hex ids in values", () => {
			expect(sig('{"detail":"retry user 12345 in 5s"}')).toBe(sig('{"detail":"retry user 99 in 5s"}'))
			expect(sig('{"id":"a1b2c3d4e5f6"}')).toBe(sig('{"id":"ffffffffffff"}'))
		})

		it("splits on differing static field wording (intended)", () => {
			expect(sig('{"detail":"disk full"}')).not.toBe(sig('{"detail":"out of memory"}'))
		})

		it("forms a signature from whatever keys exist (no common key required)", () => {
			expect(sig('{"foo":"bar"}')).toBe('foo="bar"')
		})

		it("falls back to plain redaction for arrays (not an object)", () => {
			expect(sig("[1,2,3]")).toBe("[#,#,#]")
		})

		it("uses the JSON signature even when frames are present", () => {
			expect(
				computeFingerprintInputs({
					exceptionType: "",
					exceptionStacktrace: "    at f (/a.ts:10:5)",
					statusMessage: '{"title":"Rate limited"}',
				}).msgSignature,
			).toBe('title="Rate limited"')
		})
	})

	describe("value-aware label", () => {
		const label = (statusMessage: string, exceptionType = "") =>
			computeFingerprintInputs({ exceptionType, exceptionStacktrace: "", statusMessage }).label

		it("prefers the exception type when present", () => {
			expect(label('{"title":"Rate limited"}', "TimeoutError")).toBe("TimeoutError")
		})

		it("reads problem+json title", () => {
			expect(label('{"type":"https://e/rate-limit","title":"Rate limited"}')).toBe("Rate limited")
		})

		it("falls back to _tag, then last path-segment of type, then 'JSON error'", () => {
			expect(label('{"_tag":"NetworkError"}')).toBe("NetworkError")
			expect(label('{"type":"https://api/errors/not_found"}')).toBe("not_found")
			expect(label('{"foo":"bar"}')).toBe("JSON error")
			expect(label("[1,2,3]")).toBe("JSON error")
		})

		it("labels Effect ParseError by first field", () => {
			expect(label("{ readonly userId: string }")).toBe("Schema parse error: userId")
			expect(label("Expected string\n└─ at index 0")).toBe("Schema parse error")
		})

		it("cuts legacy messages at the first delimiter (in order)", () => {
			expect(label("TypeError: undefined is not a function")).toBe("TypeError")
			expect(label("RouteNotFound (GET /robots.txt)")).toBe("RouteNotFound")
			expect(label("")).toBe("Unknown Error")
		})
	})
})

describe("SQL parity", () => {
	// These tests exercise the TypeScript mirror, but production hashes come from
	// the `error_events_mv` SQL. That only proves anything if the SQL is built
	// from the same constants — it used to carry hand-copied duplicates, which
	// nothing could see drift. Assert the rendered SQL really does contain them.
	const sql = ERROR_EVENTS_MV_SQL

	it("renders the frame matcher and every redaction from the shared constants", () => {
		expect(sql).toContain(`match(line, ${chPattern(FRAME_LINE_PATTERN)})`)
		expect(sql).toContain(`position(line, ${chPattern(EFFECT_SPAN_FRAME_MARKER)}) = 0`)
		expect(sql).toContain(`NOT match(line, ${chPattern(SCHEMA_PATH_LINE_PATTERN)})`)
		expect(sql).toContain(`NOT match(line, ${chPattern(SPAN_NAME_FRAME_PATTERN)})`)
		// The frame limit reads _msgSig, so the signature must be defined first.
		expect(sql.indexOf("AS _msgSig")).toBeLessThan(sql.indexOf("AS _rawFrames"))
		for (const [pattern, replacement] of [
			...FRAME_REDACTIONS,
			...JSON_VALUE_REDACTIONS,
			...ERROR_MSG_REDACTIONS,
		]) {
			const chReplacement = replacement.replace(/\$([1-9])/g, "\\$1")
			expect(sql).toContain(`${chPattern(pattern)}, ${chPattern(chReplacement)}`)
		}
	})

	it("hashes the version salt, so a FINGERPRINT_VERSION bump rotates every issue", () => {
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the salt is semantic: it rotates every issue
		expect(sql).toContain(`_msgSig, ${chPattern(FINGERPRINT_HASH_SALT)}) AS FingerprintHash`)
	})

	it("truncates by character in both implementations, not by byte", () => {
		// ClickHouse `substring` counts bytes while JS `slice` counts UTF-16 units,
		// so a non-ASCII message would truncate at a different point on each side.
		expect(sql).toContain(`substringUTF8(_msgText, 1, ${MSG_SCAN_CHARS})`)
		expect(sql).toContain(`1, ${MSG_SIGNATURE_CHARS}`)
		expect(sql).not.toMatch(/substring\((StatusMessage|_msgText)/)
	})

	it("keeps the frame limit in step", () => {
		expect(sql).toContain(
			`1, if(position(_exType, '/') > 0 AND _msgSig != '', ${NAMESPACED_TYPE_MAX_FRAMES}, ${MAX_FINGERPRINT_FRAMES})\n          ) AS _rawFrames`,
		)
	})

	it("emits patterns ClickHouse's RE2 can compile", () => {
		// RE2 rejects backreferences and lookaround; JS accepts both, so a pattern
		// written here can typecheck, pass every test above, and still fail at
		// deploy time against the warehouse.
		for (const [pattern] of [...FRAME_REDACTIONS, ...JSON_VALUE_REDACTIONS, ...ERROR_MSG_REDACTIONS]) {
			expect(pattern).not.toMatch(/\(\?[=!<]/)
			expect(pattern).not.toMatch(/\\[1-9]/)
		}
		expect(FRAME_LINE_PATTERN).not.toMatch(/\(\?[=!<]/)
	})

	it("uses no replacement syntax beyond a group reference both engines share", () => {
		// `$1` (JS) and `\1` (ClickHouse) are the one form rendered across; `$&`,
		// `$<name>` or a literal backslash would mean different things on each side.
		for (const [pattern, replacement] of [
			...FRAME_REDACTIONS,
			...JSON_VALUE_REDACTIONS,
			...ERROR_MSG_REDACTIONS,
		]) {
			const groups = [...replacement.matchAll(/\$([1-9])/g)].map((m) => Number(m[1]))
			expect(replacement.replace(/\$[1-9]/g, "")).not.toMatch(/[$\\]/)
			const capturing = new RegExp(`${pattern}|`).exec("")?.length ?? 1
			for (const group of groups) expect(group).toBeLessThan(capturing)
		}
	})
})

describe("Apple crash frames", () => {
	// The shape `maple-swift`'s CrashReport.stacktrace renders: frame index, binary
	// name, hex address, hex offset. Unsymbolicated — MetricKit has no symbols.
	const appleStack = (frames: ReadonlyArray<[string, string, string]>) =>
		frames
			.map(([binary, address, offset], i) => `${i}   ${binary}   0x${address}   +0x${offset}`)
			.join("\n")

	it("matches Apple frames and strips address and offset", () => {
		const result = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: appleStack([
				["MyApp", "104112600", "1d0f0"],
				["MyApp", "1041125a0", "a112"],
				["UIKitCore", "1a2b3c4d0", "44"],
				["libdyld.dylib", "700000000", "1000"],
			]),
			statusMessage: "EXC_BAD_ACCESS (SIGSEGV)",
		})

		expect(result.topFrame).toBe("0   MyApp      +")
		expect(result.fpFrames.split("\n")).toHaveLength(MAX_FINGERPRINT_FRAMES)
		expect(result.fpFrames).toContain("UIKitCore")
		expect(result.fpFrames).not.toContain("libdyld")
	})

	it("groups the same crash site across rebuilds", () => {
		// An offset moves with any code change above it. If it survived redaction every
		// release would re-split every iOS issue.
		const before = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: appleStack([["MyApp", "104112600", "1d0f0"]]),
			statusMessage: "",
		})
		const after = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: appleStack([["MyApp", "104999999", "2f4a1"]]),
			statusMessage: "",
		})
		expect(after.fpFrames).toBe(before.fpFrames)
	})

	it("separates crash sites that differ by binary", () => {
		const inApp = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: appleStack([["MyApp", "104112600", "1d0f0"]]),
			statusMessage: "",
		})
		const inUIKit = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: appleStack([["UIKitCore", "1a2b3c4d0", "1d0f0"]]),
			statusMessage: "",
		})
		expect(inUIKit.fpFrames).not.toBe(inApp.fpFrames)
	})

	it("matches a binary name containing spaces", () => {
		// A Mach-O image name is the target's PRODUCT_NAME, and "My App" is an
		// ordinary thing to call an app. Requiring one space-free token silently
		// excluded those apps from frame matching and left them collapsed on the
		// message hash — the exact failure this alternative exists to fix.
		const result = computeFingerprintInputs({
			exceptionType: "EXC_BAD_ACCESS",
			exceptionStacktrace: [
				"0   My App   0x104112600   +0x1d0f0",
				"1   My App   0x1041125a0   +0xa112",
			].join("\n"),
			statusMessage: "",
		})
		expect(result.fpFrames.split("\n")).toHaveLength(2)
		expect(result.topFrame).toContain("My App")
		expect(result.msgSignature).toBe("")
	})

	it("does not swallow other runtimes' lines", () => {
		// The alternative is anchored on a leading frame index, so a message that merely
		// mentions an address must not be read as a frame.
		const result = computeFingerprintInputs({
			exceptionType: "Error",
			exceptionStacktrace: "Error: mapping failed at 0x1f into region",
			statusMessage: "",
		})
		expect(result.fpFrames).toBe("")
	})

	it("does not match other runtimes' address-bearing frames", () => {
		// The alternative is anchored on a leading frame index with no punctuation
		// after it, which is what keeps these out.
		for (const line of [
			" 1: 0xb09bc0 node::Abort() [node]",
			"1: 0xb09bc0 node::Abort() [node]",
			"    #00 pc 0000000000045e7c  /system/lib/libc.so",
			"   0: rust_begin_unwind",
		]) {
			const result = computeFingerprintInputs({
				exceptionType: "Error",
				exceptionStacktrace: line,
				statusMessage: "",
			})
			expect(result.fpFrames, line).toBe("")
		}
	})
})

describe("fingerprint v3", () => {
	const key = (exceptionType: string, exceptionStacktrace: string, statusMessage: string) => {
		const inputs = computeFingerprintInputs({ exceptionType, exceptionStacktrace, statusMessage })
		return `${inputs.fpFrames}\u0000${inputs.msgSignature}`
	}
	const stack = (...frames: ReadonlyArray<string>) => ["Error: boom", ...frames].join("\n")

	describe("frames", () => {
		it("keeps only the throw site for a namespaced type, so its callers are one issue", () => {
			const throwSite = "    at toUpstreamError (/app/src/upstream.ts:40:11)"
			const a = stack(
				throwSite,
				"    at listTraces (/app/src/traces.ts:12:3)",
				"    at handler (/app/src/http.ts:9:1)",
			)
			const b = stack(
				throwSite,
				"    at serviceMap (/app/src/map.ts:88:7)",
				"    at handler (/app/src/http.ts:9:1)",
			)
			const type = "@maple/http/errors/UpstreamUnavailable"

			expect(key(type, a, "upstream 503")).toBe(key(type, b, "upstream 503"))
			expect(
				computeFingerprintInputs({
					exceptionType: type,
					exceptionStacktrace: a,
					statusMessage: "upstream 503",
				}).fpFrames,
			).toBe("    at toUpstreamError (/app/src/upstream.ts)")
		})

		it("keeps all 3 frames for a namespaced type with no message, since frames are all that is left", () => {
			const throwSite = "    at fail (/app/src/fail.ts:4:1)"
			const a = stack(throwSite, "    at listTraces (/app/src/traces.ts:12:3)")
			const b = stack(throwSite, "    at serviceMap (/app/src/map.ts:88:7)")
			const type = "@maple/discord/RateLimited"

			expect(key(type, a, "")).not.toBe(key(type, b, ""))
		})

		it("ignores a schema error's key path as a frame", () => {
			const withPath = stack('  at [2]["params"]', "    at decode (/app/src/schema.ts:9:4)")

			expect(key("ParseError", withPath, "")).toBe(
				key("ParseError", stack("    at decode (/app/src/schema.ts:9:4)"), ""),
			)
		})

		it("strips file:///bundle/, repeated bundle hashes and Astro asset hashes", () => {
			const top = (line: string) =>
				computeFingerprintInputs({
					exceptionType: "Error",
					exceptionStacktrace: stack(line),
					statusMessage: "",
				}).topFrame

			expect(top("    at a (file:///bundle/worker.js:1:2)")).toBe("    at a (worker.js)")
			expect(top("    at a (https://x.dev/assets/index-AbCd1234-EfGh5678.js:1:2)")).toBe(
				"    at a (/assets/index.js)",
			)
			expect(top("    at a (https://x.dev/_astro/Layout.AbCd1234.js:1:2)")).toBe(
				"    at a (/_astro/Layout.js)",
			)
		})

		it("keeps generic TypeErrors thrown at different callers apart", () => {
			const a = stack("    at Array.map (<anonymous>)", "    at renderRows (/app/src/table.ts:10:2)")
			const b = stack("    at Array.map (<anonymous>)", "    at renderChart (/app/src/chart.ts:31:9)")
			const message = "Cannot read properties of undefined (reading 'id')"

			expect(key("TypeError", a, message)).not.toBe(key("TypeError", b, message))
		})

		it("drops Effect span frames, so span depth does not split one call path", () => {
			const plain = stack("    at query (/app/src/db.ts:5:1)", "    at load (/app/src/load.ts:7:2)")
			const withSpans = stack(
				"    at query (/app/src/db.ts:5:1)",
				"    at db.query (definition) (/app/src/db.ts:3:20)",
				"    at load (/app/src/load.ts:7:2)",
			)

			expect(key("DatabaseError", withSpans, "")).toBe(key("DatabaseError", plain, ""))
		})

		it("redacts the package version in a store path", () => {
			const at = (version: string) =>
				stack(
					`    at fail (/app/node_modules/.bun/effect@${version}/node_modules/effect/dist/Effect.js:1:1)`,
				)

			expect(key("Error", at("4.0.3"), "")).toBe(key("Error", at("4.0.4-beta.1"), ""))
			expect(
				computeFingerprintInputs({
					exceptionType: "Error",
					exceptionStacktrace: at("4.0.3"),
					statusMessage: "",
				}).topFrame,
			).toBe("    at fail (node_modules/effect/dist/Effect.js)")
		})

		it("drops location-less span frames, so an Effect span rename keeps the issue", () => {
			const httpClientError = (spanFrame: string) =>
				[
					"HttpClientError: Transport error (POST https://app.maple.dev/_api/internal/query-engine/infra-presence)",
					"    at catch (https://app.maple.dev/assets/atom-client-C8D2PDUe.js:1:16420)",
					"    at https://app.maple.dev/assets/Effect-lYjf0hDm.js:13:6044",
					spanFrame,
					"    at infraPresence (https://app.maple.dev/assets/warehouse-query-atoms-C2u8hHOl.js:1:6826)",
				].join("\n")
			const message =
				"Transport error (POST https://app.maple.dev/_api/internal/query-engine/infra-presence)"
			const before = httpClientError("    at http.client POST")

			expect(key("HttpClientError", before, message)).toBe(
				key("HttpClientError", httpClientError("    at POST"), message),
			)
			expect(
				computeFingerprintInputs({
					exceptionType: "HttpClientError",
					exceptionStacktrace: before,
					statusMessage: message,
				}).fpFrames,
			).toContain("at infraPresence")
		})

		it("still counts a Node frame with a location but no parens", () => {
			const a = stack("    at file:///app/a.js:1:2")
			const b = stack("    at file:///app/b.js:1:2")

			expect(key("Error", a, "")).not.toBe(key("Error", b, ""))
		})

		it("redacts the index in `(index N)`", () => {
			const at = (index: number) => stack(`    at Promise.all (index ${index})`)

			expect(key("Error", at(3), "")).toBe(key("Error", at(17), ""))
		})

		it("reads a Python traceback from the raise site, not the shared framework layers", () => {
			const traceback = (raiseSite: string) =>
				[
					"Traceback (most recent call last):",
					'  File "/app/.venv/lib/python3.12/site-packages/opentelemetry/instrumentation/asgi/__init__.py", line 631, in __call__',
					'  File "/app/.venv/lib/python3.12/site-packages/starlette/middleware/errors.py", line 165, in __call__',
					'  File "/app/.venv/lib/python3.12/site-packages/starlette/routing.py", line 74, in app',
					raiseSite,
					"ValueError: invalid input",
				].join("\n")

			expect(
				key("ValueError", traceback('  File "/app/orders.py", line 12, in create'), "invalid input"),
			).not.toBe(
				key("ValueError", traceback('  File "/app/users.py", line 40, in update'), "invalid input"),
			)
		})

		it("keeps a dependency frame across install roots, hoisting and version bumps", () => {
			const at = (frame: string) => key("Error", stack(frame), "")

			expect(at("    at decode (/app/node_modules/effect/dist/Schema.js:1:2)")).toBe(
				at("    at decode (file:///var/task/apps/api/node_modules/effect/dist/Schema.js:9:3)"),
			)
			expect(
				at("\tfrom /usr/local/bundle/ruby/3.3.0/gems/rack-3.1.7/lib/rack/lint.rb:5:in 'call'"),
			).toBe(at("\tfrom /app/vendor/bundle/ruby/3.4.0/gems/rack-3.2.1/lib/rack/lint.rb:8:in 'call'"))
			expect(at("\t/root/go/pkg/mod/github.com/jackc/pgx/v5@v5.5.0/conn.go:12 +0x1d")).toBe(
				at("\t/home/runner/go/pkg/mod/github.com/jackc/pgx/v5@v5.7.1/conn.go:40 +0x2a"),
			)
			expect(at('  File "/usr/local/lib/python3.11/asyncio/runners.py", line 4, in run')).toBe(
				at('  File "/usr/local/lib/python3.12/asyncio/runners.py", line 9, in run'),
			)
			expect(at("    at decode (/app/node_modules/effect/dist/Schema.js:1:2)")).not.toBe(
				at("    at decode (/app/node_modules/effect/dist/Effect.js:1:2)"),
			)
		})

		it("ignores the numbers a JVM assigns to generated classes in creation order", () => {
			const at = (n: number) =>
				key(
					"java.lang.IllegalStateException",
					stack(
						`\tat com.acme.Orders$$Lambda$${n}/0x0000000800c0b440.apply(Unknown Source)`,
						`\tat jdk.internal.reflect.GeneratedMethodAccessor${n}.invoke(Unknown Source)`,
						`\tat jdk.proxy${n % 7}/jdk.proxy${n % 7}.$Proxy${n}.save(Unknown Source)`,
					),
					"",
				)

			expect(at(123)).toBe(at(4512))
		})

		it("counts an anonymous or indented `@path:line:col` frame", () => {
			const a = stack("   @/app/src/orders.js:4:2", "   @/app/src/http.js:9:1")
			const b = stack("   @/app/src/users.js:4:2", "   @/app/src/http.js:9:1")

			expect(key("TypeError", a, "")).not.toBe(key("TypeError", b, ""))
		})
	})

	describe("message signature", () => {
		const signature = (statusMessage: string) =>
			computeFingerprintInputs({ exceptionType: "", exceptionStacktrace: "", statusMessage })
				.msgSignature

		it("cuts only the query a ClickHouse error echoes, keeping the identifier that names the bug", () => {
			const echo = (query: string) =>
				signature(
					`Code: 47. DB::Exception: Unknown expression identifier \`ServiceVersion\` in scope ${query}`,
				)

			expect(echo("SELECT ServiceVersion FROM traces")).toBe(
				"Code: #. DB::Exception: Unknown expression identifier `ServiceVersion`",
			)
			expect(echo("SELECT * FROM (SELECT ServiceVersion FROM logs)")).toBe(
				echo("SELECT ServiceVersion FROM traces"),
			)
			expect(
				signature(
					"DB::Exception: Illegal type String of argument of function plus: While processing plus(a, 1)",
				),
			).toBe("DB::Exception: Illegal type String of argument of function plus:")
		})

		it("keeps different missing identifiers apart", () => {
			expect(signature("[Error] Unknown identifier `TraceIdd` in scope SELECT 1")).not.toBe(
				signature("[Error] Unknown identifier `Severity` in scope SELECT 1"),
			)
		})

		it("cuts the echoed query from the `[Error]` envelope", () => {
			expect(
				signature("[Error] Unknown identifier `TraceIdd` in scope SELECT TraceIdd FROM traces"),
			).toBe("[Error] Unknown identifier `TraceIdd`")
		})

		it("strips terminal colour codes", () => {
			expect(signature("\x1b[31mconnection refused\x1b[0m")).toBe("connection refused")
		})

		it("ends a filesystem root at a separator, so `/data.x` is a path and `/datasets` is not", () => {
			expect(signature("cannot open /data.quarantine-x1/store")).toBe(
				signature("cannot open /data/store"),
			)
			expect(signature("read /datasets/x failed")).toBe("read /datasets/x failed")
		})

		it("replaces `~/` paths and adjacent paths, but not a `~` before a number", () => {
			expect(signature("open ~/.maple/data failed")).toBe("open PATH failed")
			expect(signature("copy /tmp/a /var/b")).toBe("copy PATH PATH")
			expect(signature("retry in ~5 min")).toBe("retry in ~# min")
		})

		it("keeps a snake_case name with no digit or capital", () => {
			expect(signature("unknown key top_operations")).toBe("unknown key top_operations")
		})

		it("keeps a 4xx and 500 exact and folds every other 5xx into one class", () => {
			const returned = (status: number) => signature(`upstream returned ${status}`)

			expect(new Set([returned(401), returned(404), returned(500)]).size).toBe(3)
			expect(returned(502)).toBe("upstream returned 5xx")
			expect(returned(520)).toBe(returned(502))
			expect(returned(524)).toBe(returned(502))
			expect(signature("status: 429 too many")).toBe("status: 429 too many")
			expect(signature("HTTP 503 from gateway")).toBe("HTTP 5xx from gateway")
		})

		it("keeps the status of an HttpClient response error and of `statusCode: N`", () => {
			const response = (status: number) =>
				signature(`StatusCode error (${status} GET https://api.acme.dev/users)`)

			expect(response(404)).toBe("StatusCode error (404 GET /users)")
			expect(response(429)).not.toBe(response(404))
			expect(response(530)).toBe("StatusCode error (5xx GET /users)")
			expect(response(502)).toBe(response(530))
			expect(signature("statusCode: 401")).not.toBe(signature("statusCode: 503"))
			expect(signature("status=404")).toBe("status=404")
		})

		it("replaces filesystem-rooted paths with PATH", () => {
			expect(signature("ENOENT: no such file or directory, open '/tmp/maple-a81f/wal.log'")).toBe(
				"ENOENT: no such file or directory, open 'PATH'",
			)
			expect(signature("socket /var/run/maple/abc.sock closed")).toBe(
				signature("socket /var/run/maple/xyz.sock closed"),
			)
		})

		it("keeps route paths, including ones that contain a filesystem root name", () => {
			expect(signature("Transport error (POST /api/data/export)")).toBe(
				"Transport error (POST /api/data/export)",
			)
			expect(signature("Transport error (POST /api/query-engine/service-overview)")).not.toBe(
				signature("Transport error (POST /api/query-engine/service-map)"),
			)
		})

		it("keeps different quoted table names apart", () => {
			expect(signature("Table 'checkout_events' doesn't exist")).not.toBe(
				signature("Table 'planetscale_events' doesn't exist"),
			)
		})

		it("replaces prefixed ids and ULIDs with ID", () => {
			expect(signature("no billing customer for org_2NnAbCdEfGhIjKlM")).toBe(
				"no billing customer for ID",
			)
			expect(signature("subscription cus_QwErTyUiOpAsDf lapsed")).toBe(
				signature("subscription cus_ZxCvBnMlKjHgFd lapsed"),
			)
			expect(signature("run 01HZY3K4W7Q9N2B6C8D0E5F1GA failed")).toBe("run ID failed")
		})

		it("redacts UUIDs, dashes included, inside a JSON value", () => {
			const json = (id: string) => JSON.stringify({ error: "not_found", id })

			expect(signature(json("550e8400-e29b-41d4-a716-446655440000"))).toBe(
				signature(json("9b2f1c3e-0d4a-4f6b-8c7e-1a2b3c4d5e6f")),
			)
			expect(signature(json("550e8400-e29b-41d4-a716-446655440000"))).toBe('error="not_found"|id="#"')
		})

		it("strips URL origins and emails from a JSON value", () => {
			const json = (url: string, user: string) => JSON.stringify({ error: "fetch_failed", url, user })

			expect(signature(json("https://a.acme.dev/favicon.ico", "ann@acme.dev"))).toBe(
				'error="fetch_failed"|url="/favicon.ico"|user="EMAIL"',
			)
			expect(signature(json("https://b.other.io/favicon.ico", "bo@other.io"))).toBe(
				signature(json("https://a.acme.dev/favicon.ico", "ann@acme.dev")),
			)
		})
	})
})
