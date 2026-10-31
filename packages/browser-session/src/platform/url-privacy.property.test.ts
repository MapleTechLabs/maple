import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { addUrlSanitizer, redactUrl, resetUrlSanitizersForTests, scrubUrl } from "./url-privacy"

afterEach(() => resetUrlSanitizersForTests())

const CREDENTIAL_PARAMS = [
	"token",
	"access_token",
	"code",
	"password",
	"api_key",
	"sig",
	"X-Amz-Signature",
	"oobCode",
	// Matched by their normalized suffix rather than by an exact name.
	"accessToken",
	"authToken",
	"auth_token",
	"user_token",
	"__clerk_db_jwt",
	"clientSecret",
	"x-api-key",
	"newPassword",
]

/** Long and random enough that finding it in the output means it leaked. */
const secret = fc.stringMatching(/^[A-Za-z0-9]{12,40}$/)

/** Upper/lower-cased letter by letter: parameter names match case-insensitively. */
const anyCase = (name: string) =>
	fc
		.array(fc.boolean(), { minLength: name.length, maxLength: name.length })
		.map((upper) => [...name].map((ch, i) => (upper[i] ? ch.toUpperCase() : ch.toLowerCase())).join(""))

const credentialName = fc.constantFrom(...CREDENTIAL_PARAMS).chain(anyCase)

const harmlessName = fc.constantFrom(
	"tab",
	"page",
	"q",
	"sort",
	"utm_source",
	"ref",
	"lang",
	"tokenizer_mode",
	"secretary",
	"keyboard",
)
const harmlessValue = fc.stringMatching(/^[a-z0-9-]{0,12}$/)
const harmlessQuery = fc
	.array(fc.tuple(harmlessName, harmlessValue), { maxLength: 4 })
	.map((pairs) => pairs.map(([name, value]) => `${name}=${value}`).join("&"))

const base = fc.constantFrom(
	"https://app.test/reset",
	"http://localhost:3000/a/b",
	"/relative/path",
	"path/only",
	"//cdn.test/x",
)

/** Where in a URL a credential can ride. */
const placement = fc.constantFrom("query", "fragment", "hash-route", "slashless-hash-route")

const urlWithCredential = fc
	.record({ base, name: credentialName, value: secret, other: harmlessQuery, placement })
	.map(({ base, name, value, other, placement }) => {
		const pair = other ? `${other}&${name}=${value}` : `${name}=${value}`
		const url =
			placement === "query"
				? `${base}?${pair}`
				: placement === "fragment"
					? `${base}#${pair}`
					: placement === "hash-route"
						? `${base}#/route?${pair}`
						: `${base}#route?${pair}`
		return { url, value }
	})

/** A URL `new URL` rejects: a space in the host. */
const unparsableUrlWithCredential = fc
	.record({
		name: credentialName,
		value: secret,
		other: harmlessQuery,
		separator: fc.constantFrom("?", "#", ";"),
	})
	.map(({ name, value, other, separator }) => {
		const pair = other ? `${other}&${name}=${value}` : `${name}=${value}`
		return { url: `https://exa mple.test/a${separator}${pair}`, value }
	})

const userinfoUrl = fc
	.record({
		user: secret,
		password: secret,
		start: fc.constantFrom("https://", "http://", "//"),
		host: fc.constantFrom("app.test", "exa mple.test"),
		rest: fc.constantFrom("", "/x", "/x?page=2", "/#/route"),
	})
	.map(({ user, password, start, host, rest }) => ({
		url: `${start}${user}:${password}@${host}${rest}`,
		user,
		password,
	}))

describe("redactUrl", () => {
	it("never lets a credential parameter's value through, wherever it rides", () => {
		fc.assert(
			fc.property(urlWithCredential, ({ url, value }) => {
				expect(redactUrl(url)).not.toContain(value)
			}),
		)
	})

	it("redacts a credential name however it is percent-encoded", () => {
		fc.assert(
			fc.property(fc.constantFrom(...CREDENTIAL_PARAMS), secret, (name, value) => {
				const encoded = [...name].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")
				expect(redactUrl(`https://app.test/?${encoded}=${value}`)).not.toContain(value)
			}),
		)
	})

	it("redacts credentials in a URL the parser rejects", () => {
		fc.assert(
			fc.property(unparsableUrlWithCredential, ({ url, value }) => {
				expect(redactUrl(url)).not.toContain(value)
			}),
		)
	})

	it("drops the username and password from userinfo, parsable or not", () => {
		fc.assert(
			fc.property(userinfoUrl, ({ url, user, password }) => {
				const out = redactUrl(url)
				expect(out).not.toContain(user)
				expect(out).not.toContain(password)
			}),
		)
	})

	it("keeps a slashless hash route's path while redacting its query", () => {
		expect(redactUrl("https://app.test/#reset?token=abc123&page=2")).toBe(
			"https://app.test/#reset?token=REDACTED&page=2",
		)
	})

	it("leaves a URL with no credential parameter exactly as it was", () => {
		fc.assert(
			fc.property(base, harmlessQuery, fc.boolean(), (start, query, inFragment) => {
				const url = query ? `${start}${inFragment ? "#" : "?"}${query}` : start
				expect(redactUrl(url)).toBe(url)
			}),
		)
	})

	it("is idempotent", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					urlWithCredential.map(({ url }) => url),
					unparsableUrlWithCredential.map(({ url }) => url),
					userinfoUrl.map(({ url }) => url),
					fc.webUrl({ withQueryParameters: true, withFragments: true }),
				),
				(url) => {
					const once = redactUrl(url)
					expect(redactUrl(once)).toBe(once)
				},
			),
		)
	})

	it("returns any input without a query, fragment, userinfo or matrix part unchanged, and never throws", () => {
		fc.assert(
			fc.property(fc.oneof(fc.string({ unit: "grapheme" }), fc.string({ unit: "binary" })), (url) => {
				const out = redactUrl(url)
				if (!/[?#@;]/.test(url)) expect(out).toBe(url)
				else expect(redactUrl(out)).toBe(out)
			}),
		)
	})
})

describe("scrubUrl", () => {
	it("keeps the default redaction whatever a host sanitizer does", () => {
		fc.assert(
			fc.property(
				urlWithCredential,
				fc.anything(),
				fc.boolean(),
				({ url, value }, returned, throws) => {
					resetUrlSanitizersForTests()
					addUrlSanitizer(() => {
						if (throws) throw new Error("broken sanitizer")
						return returned as string
					})
					const out = scrubUrl(url)
					expect(typeof out).toBe("string")
					// A sanitizer may rewrite the URL entirely, but it only ever sees the redacted one.
					if (typeof returned !== "string") expect(out).not.toContain(value)
				},
			),
		)
	})
})
