import { PrReviewFinding, type PullRequestFile } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import { parsePatch } from "./diff"
import { privacyFindings, privacyHitAt, withoutReviewerOverlap } from "./privacy"
import { Array as Arr, String as Str } from "effect"

const file = (
	path: string,
	added: ReadonlyArray<string>,
	context: ReadonlyArray<string> = [],
): PullRequestFile => ({
	path,
	previousPath: null,
	status: "modified",
	additions: added.length,
	deletions: 0,
	patch: Arr.join(
		[
			`@@ -10,${context.length} +10,${context.length + added.length} @@`,
			...Arr.map(context, (line) => ` ${line}`),
			...Arr.map(added, (line) => `+${line}`),
		],
		"\n",
	),
})

/** The hit on the last added line of a snippet, read with the lines above it. */
const hitOf = (...snippet: ReadonlyArray<string>) => {
	const lines = parsePatch(
		`@@ -1,0 +1,${snippet.length} @@\n${Arr.join(
			Arr.map(snippet, (line) => `+${line}`),
			"\n",
		)}`,
	)
	return privacyHitAt(lines, lines.length - 1)
}

describe("privacyHitAt", () => {
	const exposes: ReadonlyArray<readonly [string, ReadonlyArray<string>, string, string]> = [
		["semconv email attribute", ['span.setAttribute("user.email", user.email)'], "contact", "user.email"],
		["password in a log", ['logger.info("login attempt", { username, password })'], "secret", "password"],
		["camelCase api key", ["Effect.logInfo(`calling vendor with ${apiKey}`)"], "secret", "apiKey"],
		["auth header", ["console.log(req.headers.authorization)"], "secret", "req.headers.authorization"],
		["bracket header", ['console.log(req.headers["x-api-key"])'], "secret", 'req.headers["x-api-key"]'],
		["whole request body", ["console.error('bad payload', req.body)"], "payload", "req.body"],
		[
			"entry of a multi-line attribute object",
			[
				"yield* Effect.annotateCurrentSpan({",
				'\t"user.id": user.id,',
				"\tphone: customer.phoneNumber,",
			],
			"contact",
			"phone",
		],
		[
			"Go attribute helper",
			['span.SetAttributes(attribute.String("user.email", u.Email))'],
			"contact",
			"user.email",
		],
		["Python f-string", ['logger.info(f"charging {card_number}")'], "payment", "card_number"],
		["Rust tracing field", ['info!(ssn = %patient.ssn, "loaded record")'], "government_id", "ssn"],
		[
			"span event",
			['span.addEvent("signup", { "enduser.email": input.email })'],
			"contact",
			"enduser.email",
		],
		["client ip", ['span.setAttribute("client_ip", req.ip)'], "network", "client_ip"],
		[
			"literal JWT",
			['logger.debug("using eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")'],
			"secret",
			"a JSON web token",
		],
		[
			"literal card number",
			['console.log("test charge 4242 4242 4242 4242")'],
			"payment",
			"a card number",
		],
		["a stringified body", ["console.log(JSON.stringify(req.body))"], "payload", "req.body"],
		[
			"a leak beside a derived entry",
			["Effect.annotateCurrentSpan({ email: user.email, count: 3 })"],
			"contact",
			"email",
		],
		["a leak beside a constant", ['logger.warn("bad", { password, reason: "x" })'], "secret", "password"],
		[
			"a leak beside a length",
			['span.setAttributes({ "user.password": pw, "n": items.length })'],
			"secret",
			"user.password",
		],
		["Rust instrument fields", ["#[instrument(fields(email = %user.email))]"], "contact", "email"],
		["Go log call", ['log.Info("user", "email", u.Email)'], "contact", "email"],
		[
			"an interpolation beside a derived one",
			["logger.info(`sent to ${user.email} (${items.length} items)`)"],
			"contact",
			"user.email",
		],
		["Go key-value logging", ['slog.Info("login", "password", pw, "ok", true)'], "secret", "password"],
		["a key alone on its line", ["span.setAttribute(", '\t"user.email",'], "contact", "user.email"],
		[
			"a leak beside a non-person key",
			['span.setAttributes({ "user.email": user.email, "service.name": svc })'],
			"contact",
			"user.email",
		],
		["worst kind wins", ["logger.info({ email: user.email, token: session.token })"], "secret", "token"],
		["a token's value", ['span.setAttribute("auth.token.value", token)'], "secret", "auth.token.value"],
		[
			"an email address",
			["logger.info({ email_address: input.email_address })"],
			"contact",
			"email_address",
		],
		// The rightmost sensitive word names the value, whatever comes before it.
		[
			"a token inside a response",
			["logger.info(tokenResponse.access_token)"],
			"secret",
			"tokenResponse.access_token",
		],
		[
			"a password among credentials",
			["logger.info(credentials.password)"],
			"secret",
			"credentials.password",
		],
		["a token under a secret", ["logger.info(secret.token)"], "secret", "secret.token"],
		[
			"a social security number",
			["logger.info({ socialSecurityNumber })"],
			"government_id",
			"socialSecurityNumber",
		],
		["a credit card number", ["logger.info({ creditCardNumber })"], "payment", "creditCardNumber"],
		[
			"a street address line",
			["logger.info({ shipping_address_line1: order.shipping_address_line1 })"],
			"contact",
			"shipping_address_line1",
		],
		["an address zip", ["logger.info({ home_address_zip })"], "contact", "home_address_zip"],
		// A short prefix exempts only its own entry, and only when it is the whole value.
		[
			"a password joined to a bracketed short id",
			["logger.info({ password: password + (requestId.slice(0, 8)) })"],
			"secret",
			"password",
		],
		[
			"a password joined to a short id",
			["logger.info({ password: password + requestId.slice(0, 8) })"],
			"secret",
			"password",
		],
		[
			"a password beside a short trace id",
			["logger.info({ password, traceId: traceId.slice(0, 8) })"],
			"secret",
			"password",
		],
		[
			"an email beside a short request id",
			['Effect.annotateCurrentSpan({ "user.email": user.email, "request.id": requestId.slice(0, 8) })'],
			"contact",
			"user.email",
		],
	]
	for (const [name, snippet, kind, subject] of exposes) {
		it(`flags ${name}`, () => {
			const hit = hitOf(...snippet)
			assert.strictEqual(hit?.kind, kind)
			assert.strictEqual(hit === undefined ? undefined : Str.replaceAll("`", "")(hit.subject), subject)
		})
	}

	const quiet: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
		["token usage counts", ['span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens)']],
		["a word inside a log message", ['Effect.logInfo("[Auth] password reset email sent")']],
		["a sensitive word as a value", ['span.setAttribute("auth.method", "token")']],
		["metadata about a secret", ["logger.info({ tokenCount, hasToken, emailVerified, cookieName })"]],
		["hashed value", ['span.setAttribute("user.email_hash", sha256(user.email))']],
		["redacted wrapper", ["logger.info({ apiKey: Redacted.make(apiKey) })"]],
		["ids", ['Effect.annotateCurrentSpan({ "user.id": user.id, "session.id": session.id })']],
		["no telemetry call", ["const email = user.email.trim()"]],
		["callee named like data", ["logger.info(sendEmail.name)", "Effect.logInfo(formatEmail(user))"]],
		["a comment", ['// span.setAttribute("user.email", user.email)']],
		["a closed call above", ["logger.info({ ok })", "const masked = { email: user.email }"]],
		["the card-shaped repeated digit", ['logger.info("id 0000000000000000")']],
		["a constant beside spaced braces", ['span.setAttributes({ "user.email": "anonymous" })']],
		["a boolean beside spaced braces", ['logger.info("x", { password: false })']],
		["a Luhn-valid snowflake id", ['logger.info("guild", { guildId: "1066140228467032074" })']],
		["semconv peer address", ['span.setAttribute("server.address", host)']],
		[
			"a presence check",
			[
				"hasSecret: Option.isSome(config.ELECTRIC_SECRET),",
				"span?.setAttribute(Telemetry.Key.authHasToken, token != nil)",
			],
		],
		[
			"a comparison",
			['"planetscale.token.looks_jwt": tokenResponse.access_token.split(".").length === 3,'],
		],
		["a constant value", ['yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "hit" })']],
		[
			"one indexed header",
			['span.setAttribute("vcs.webhook.event", input.headers["x-github-event"] ?? "unknown")'],
		],
		[
			"a value derived by a function",
			['yield* Effect.annotateCurrentSpan("db.query.fingerprint", fingerprintSql(statement.body))'],
		],
		["a repository's full name", ['span.setAttribute("vcs.repository.full_name", checkout.fullName)']],
		["a span name", ['Effect.withSpan("AuthService.withAccessToken", { attributes: { orgId } })']],
		// Prod false positives, 2026-11: a word after the sensitive one names something about it.
		["a token's network metadata", ['span.setAttribute("auth.api_key_network.asn", asn)']],
		["a token's issuer claim", ['span.setAttribute("auth.token.iss", claims.iss)']],
		["a token's purpose", ['Effect.annotateCurrentSpan({ "sealed_token.purpose": purpose })']],
		["a token's issue time", ['logger.info({ "agentToken.issued_at": issuedAt })']],
		["a token's revision", ["Effect.annotateCurrentSpan({ refreshTokenRevision })"]],
		["an enum named after credentials", ["logger.info({ action: widgetCredentialAction })"]],
		["a class named after secrets", ["Effect.logInfo(SecretResealSweep.name)"]],
		["a short token prefix", ['span.setAttribute("auth.token", token.slice(0, 12))']],
		["a short prefix as a call's argument", ["logger.info(token.slice(0, 12))"]],
		["a short prefix in a template", ["logger.info(`using ${apiKey.slice(0, 6)}`)"]],
	]
	for (const [name, snippet] of quiet) {
		it(`stays quiet on ${name}`, () => {
			assert.isUndefined(hitOf(...snippet))
		})
	}
})

describe("privacyHitAt on hostile input", () => {
	it("returns quickly on a long run of whitespace", () => {
		assert.isUndefined(hitOf(`logger.info({ ok:true${Str.repeat(10_000)(" ")}x })`))
		assert.isUndefined(hitOf(`logger.info({ k: "v"${Str.repeat(10_000)(" ")}x })`))
	})

	it("skips generated lines, however many", () => {
		const minified = `+${Str.repeat(2_000)('k:"v",')}`
		const patch = `@@ -1,0 +1,300 @@\n${Arr.join(
			Array.from({ length: 300 }, () => minified),
			"\n",
		)}`
		assert.lengthOf(privacyFindings([{ ...file("src/bundle.js", []), patch }]), 0)
	})

	it("does not read a call opened in an earlier hunk", () => {
		const patch = Arr.join(
			[
				"@@ -1,1 +1,1 @@",
				' logger.info("start", {',
				"@@ -399,0 +400,1 @@",
				"+const email = user.email",
			],
			"\n",
		)
		assert.lengthOf(privacyFindings([{ ...file("src/a.ts", []), patch }]), 0)
	})
})

describe("privacyFindings", () => {
	it("files one finding per file and kind, counting the other lines", () => {
		const findings = privacyFindings([
			file("apps/api/src/auth.ts", [
				'span.setAttribute("user.email", user.email)',
				"logger.info({ email: input.email })",
				'logger.warn("bad login", { password })',
			]),
		])
		assert.deepStrictEqual(
			Arr.map(findings, (finding) => [
				finding.line,
				finding.severity,
				finding.checkId,
				finding.category,
				finding.title,
			]),
			[
				[10, "warn", "PII-01", "security", "Personal data `user.email` written to a span attribute"],
				[12, "warn", "PII-01", "security", "Credential `password` written to a log"],
			],
		)
		assert.match(findings[0]?.body ?? "", /Also on line 11\./)
	})

	// A name is a guess; a value recognized by its shape is not.
	it("files a name-only hit as a warning and a recognized value as critical", () => {
		const severities = (added: ReadonlyArray<string>) =>
			Arr.map(privacyFindings([file("src/a.ts", added)]), (finding) => finding.severity)
		assert.deepStrictEqual(severities(['logger.info("x", { password })']), ["warn"])
		assert.deepStrictEqual(
			severities([
				'logger.info("x", { password })',
				'logger.debug("using eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")',
			]),
			["critical"],
		)
	})

	it("skips tests, fixtures and docs", () => {
		const leak = ['span.setAttribute("user.email", user.email)']
		assert.lengthOf(
			privacyFindings([
				file("apps/api/src/auth.test.ts", leak),
				file("apps/api/src/__fixtures__/auth.ts", leak),
				file("docs/tracing.md", leak),
			]),
			0,
		)
	})

	it("anchors on the new-side line after context", () => {
		const [finding] = privacyFindings([
			file(
				"src/checkout.ts",
				['console.log("charging", order.cardNumber)'],
				["const a = 1", "const b = 2"],
			),
		])
		assert.strictEqual(finding?.line, 12)
	})
})

describe("withoutReviewerOverlap", () => {
	const scanned = privacyFindings([file("src/a.ts", ['logger.info("x", { password })'])])
	const reviewer = (path: string, line: number, checkId?: string) =>
		new PrReviewFinding({
			path,
			line,
			category: "security",
			...(checkId === undefined ? undefined : { checkId }),
			severity: "critical",
			title: "t",
			body: "b",
		})

	it("drops a scan finding the reviewer filed with a privacy check id on the same line", () => {
		assert.lengthOf(withoutReviewerOverlap(scanned, [reviewer("src/a.ts", 10, "PII-01")]), 0)
	})

	it("keeps it when the reviewer's finding is on another line, file or issue", () => {
		assert.lengthOf(withoutReviewerOverlap(scanned, [reviewer("src/a.ts", 11, "PII-01")]), 1)
		assert.lengthOf(withoutReviewerOverlap(scanned, [reviewer("src/b.ts", 10, "PII-01")]), 1)
		assert.lengthOf(withoutReviewerOverlap(scanned, [reviewer("src/a.ts", 10)]), 1)
	})
})
