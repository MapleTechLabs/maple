import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { computeFingerprintInputs, MAX_FINGERPRINT_FRAMES, MSG_SIGNATURE_CHARS } from "./fingerprint"

// Grouping is two promises: the same bug under different runtime values is ONE
// issue, and two bugs are TWO. Each property renders one structure under two
// independent draws of everything volatile and compares what reaches the hash.

const fingerprint = (exceptionType: string, exceptionStacktrace: string, statusMessage: string) => {
	const { fpFrames, msgSignature } = computeFingerprintInputs({
		exceptionType,
		exceptionStacktrace,
		statusMessage,
	})
	return { fpFrames, msgSignature }
}

const chars = (alphabet: string, minLength: number, maxLength: number) =>
	fc.string({ unit: fc.constantFrom(...Array.from(alphabet)), minLength, maxLength })

const LOWER = "abcdefghijklmnopqrstuvwxyz"
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const DIGITS = "0123456789"
const ALNUM = LOWER + UPPER + DIGITS
const HEX = "0123456789abcdef"

/** A name that identifies a bug. No hex letters, so no id pass can mistake it for a value. */
const name = chars("ghijklmnopqrstuvwxyz", 3, 10)
const int = (min: number, max: number) => fc.integer({ min, max })

/** Everything a frame line carries that changes between deploys, hosts, machines and runs. */
const FrameChurn = fc.record({
	line: int(1, 99_999),
	col: int(1, 999),
	host: fc.tuple(chars(LOWER + DIGITS + "-", 1, 20), fc.constantFrom(".dev", ".app", ".pages.dev")),
	bundle: chars(ALNUM + "_-", 8, 8),
	version: fc.tuple(int(0, 30), int(0, 30), int(0, 300)),
	address: chars(HEX, 9, 12),
	offset: chars(HEX, 3, 6),
	/** Where dependencies are installed: per machine, image and hoisting layout. */
	installRoot: fc.constantFrom(
		"/app",
		"/app/apps/api",
		"file:///var/task",
		"../..",
		"/home/runner/work/x/x",
	),
	gemRoot: fc.constantFrom("/usr/local/bundle", "/app/vendor/bundle", "/home/deploy/.gem"),
	pyRoot: fc.constantFrom("/usr/local/lib", "/app/.venv/lib", "/opt/venv/lib"),
	pyMinor: int(8, 14),
	goPath: fc.constantFrom("/root/go", "/home/runner/go", "/go"),
	bunRoot: fc.constantFrom("/$bunfs/root/", "B:/~BUN/root/"),
	/** A JVM numbers generated classes in the order one process happens to create them. */
	runOrder: int(1, 99_999),
	proxySuffix: chars(ALNUM, 8, 8),
})
type FrameChurn = typeof FrameChurn extends fc.Arbitrary<infer A> ? A : never

const PYTHON_RUNTIMES = ["python", "pip", "pystd"] as const
const RUNTIMES = [
	"v8",
	"bundle",
	"store",
	"hoisted",
	"bunfs",
	"ruby",
	"gem",
	"firefox",
	"jsc",
	"go",
	"gomod",
	"java",
	"jvmLambda",
	"jvmProxy",
	"jvmAccessor",
	"hibernate",
	"apple",
] as const
const site = (runtimes: ReadonlyArray<Runtime>) =>
	fc.record({ runtime: fc.constantFrom(...runtimes), fn: name, file: name })
type Runtime = (typeof RUNTIMES)[number] | (typeof PYTHON_RUNTIMES)[number]
type Site = { readonly runtime: Runtime; readonly fn: string; readonly file: string }

const renderFrame = ({ runtime, fn, file }: Site, index: number, c: FrameChurn): string => {
	const host = c.host.join("")
	const version = c.version.join(".")
	const frames = {
		v8: `    at ${fn} (/app/src/${file}.ts:${c.line}:${c.col})`,
		bundle: `    at ${fn} (https://${host}/assets/${file}-${c.bundle}.js:${c.line}:${c.col})`,
		store: `    at ${fn} (/app/node_modules/.pnpm/${file}@${version}/node_modules/${file}/index.js:${c.line}:${c.col})`,
		hoisted: `    at ${fn} (${c.installRoot}/node_modules/${file}/dist/index.js:${c.line}:${c.col})`,
		bunfs: `    at ${fn} (${c.bunRoot}${file}:${c.line}:${c.col})`,
		python: `  File "/app/${file}.py", line ${c.line}, in ${fn}`,
		pip: `  File "${c.pyRoot}/python3.${c.pyMinor}/site-packages/${file}/core.py", line ${c.line}, in ${fn}`,
		pystd: `  File "/usr/local/lib/python3.${c.pyMinor}/${file}/__init__.py", line ${c.line}, in ${fn}`,
		ruby: `    from /app/${file}.rb:${c.line}:in '${fn}'`,
		gem: `\tfrom ${c.gemRoot}/ruby/${version}/gems/${file}-${version}/lib/${file}.rb:${c.line}:in '${fn}'`,
		firefox: `${fn}@https://${host}/assets/${file}-${c.bundle}.js:${c.line}:${c.col}`,
		jsc: `   @/app/src/${file}.js:${c.line}:${c.col}`,
		go: `    /app/${file}.go:${c.line} +0x${c.offset}`,
		gomod: `\t${c.goPath}/pkg/mod/github.com/acme/${file}@v${version}/${fn}.go:${c.line} +0x${c.offset}`,
		java: `\tat com.acme.${file}.${fn}(${file}.java:${c.line})`,
		jvmLambda: `\tat com.acme.${file}$$Lambda$${c.runOrder}/0x${c.address}.${fn}(Unknown Source)`,
		jvmProxy: `\tat jdk.proxy${c.runOrder % 9}/jdk.proxy${c.runOrder % 9}.$Proxy${c.runOrder}.${fn}(Unknown Source)`,
		jvmAccessor: `\tat jdk.internal.reflect.GeneratedMethodAccessor${c.runOrder}.${fn}(Unknown Source)`,
		hibernate: `\tat com.acme.${file}$HibernateProxy$${c.proxySuffix}.${fn}(Unknown Source)`,
		apple: `${index}   ${fn}   0x${c.address}   +0x${c.offset}`,
	} satisfies Record<Runtime, string>
	return frames[runtime]
}

const churnFor = <A>(arb: fc.Arbitrary<A>, length: number) =>
	fc.array(arb, { minLength: length, maxLength: length })

/** Sites run from the throw site outward; Python prints them the other way round. */
const renderStack = (sites: ReadonlyArray<Site>, churn: ReadonlyArray<FrameChurn>) => {
	const frames = sites.map((site, i) => renderFrame(site, i, churn[i] ?? churn[0]!))
	return PYTHON_RUNTIMES.some((runtime) => runtime === sites[0]?.runtime)
		? ["Traceback (most recent call last):", ...frames.reverse(), "Error: boom"].join("\n")
		: ["Error: boom", ...frames].join("\n")
}

/** One call path in one language, rendered under two independent churns. */
const Stack = fc
	.oneof(
		fc.array(site(RUNTIMES), { minLength: 1, maxLength: 6 }),
		fc.array(site(PYTHON_RUNTIMES), { minLength: 1, maxLength: 6 }),
	)
	.chain((sites) =>
		fc.record({
			sites: fc.constant(sites),
			a: churnFor(FrameChurn, sites.length),
			b: churnFor(FrameChurn, sites.length),
		}),
	)

/** Values that change per occurrence, each rendered the way real error text carries it. */
const VOLATILE = [
	"int",
	"uuid",
	"traceId",
	"email",
	"home",
	"prefixedId",
	"ulid",
	"quoted",
	"query",
	"origin",
	"ansi",
	"opaque",
	"timestamp",
	"handle",
	"routeNotFound",
	"upstream5xx",
] as const
type Volatile = (typeof VOLATILE)[number]

const ValueChurn = fc.record({
	n: int(0, 2_000_000_000),
	uuid: fc.uuid(),
	traceId: chars(HEX, 32, 32),
	user: chars(LOWER + DIGITS + ".", 1, 12),
	key: chars(LOWER, 2, 8),
	idTail: fc.tuple(chars(UPPER + DIGITS, 1, 1), chars(ALNUM, 11, 19)),
	ulid: chars("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26, 26),
	token: chars(ALNUM, 25, 40),
	value: chars(ALNUM, 1, 20),
	host: chars(LOWER + DIGITS + "-.", 1, 24),
	// A random key mixes both cases and a digit; the prefix guarantees all three.
	opaque: fc.tuple(chars(UPPER, 1, 1), chars(LOWER, 1, 1), chars(DIGITS, 1, 1), chars(ALNUM + "_", 17, 37)),
	date: fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
	path: chars(ALNUM + "._~%-/", 0, 40),
})
type ValueChurn = typeof ValueChurn extends fc.Arbitrary<infer A> ? A : never

const renderVolatile = (kind: Volatile, word: string, c: ValueChurn): string => {
	const values = {
		int: String(c.n),
		uuid: c.uuid,
		traceId: c.traceId,
		email: `${c.user}@${word}.com`,
		home: `/Users/${c.user}/.maple/${word}`,
		prefixedId: `${c.key}_${c.idTail.join("")}`,
		ulid: c.ulid,
		quoted: `'${c.token}'`,
		query: `/api/${word}?${c.key}=${c.value}`,
		origin: `https://${c.host}/api/${word}`,
		ansi: `\x1b[${c.n % 100}m${word}\x1b[0m`,
		opaque: `rejected ${c.opaque.join("")}`,
		timestamp: c.date.toISOString(),
		handle: `/v1/users/@${word}${c.n % 1000}`,
		routeNotFound: `RouteNotFound (GET /${c.path})`,
		// One outage answers 502, 520 and 530 in turn: every 5xx but 500 is one class.
		upstream5xx: `StatusCode error (${501 + (c.n % 99)} GET /api/${word})`,
	} satisfies Record<Volatile, string>
	return values[kind]
}

const Part = fc.oneof(
	{ arbitrary: fc.record({ kind: fc.constant("word" as const), word: name }), weight: 2 },
	{ arbitrary: fc.record({ kind: fc.constantFrom(...VOLATILE), word: name }), weight: 3 },
)
type Part = typeof Part extends fc.Arbitrary<infer A> ? A : never

const renderMessage = (parts: ReadonlyArray<Part>, churn: ReadonlyArray<ValueChurn>) =>
	parts
		.map((part, i) =>
			part.kind === "word" ? part.word : renderVolatile(part.kind, part.word, churn[i]!),
		)
		.join(" ")

/** A message of names and values. Kept under MSG_SCAN_CHARS, which cuts before redaction. */
const Message = fc.array(Part, { maxLength: 12 }).chain((parts) =>
	fc.record({
		parts: fc.constant(parts),
		a: churnFor(ValueChurn, parts.length),
		b: churnFor(ValueChurn, parts.length),
	}),
)

const ExceptionType = fc.oneof(
	fc.constantFrom("", "Error", "TypeError", "HttpServerError"),
	name.map((n) => `@acme/http/errors/${n}`),
)

describe("one bug is one issue", () => {
	it("ignores everything volatile in the stack and the message", () => {
		fc.assert(
			fc.property(ExceptionType, Stack, Message, (type, stack, message) => {
				expect(
					fingerprint(
						type,
						renderStack(stack.sites, stack.a),
						renderMessage(message.parts, message.a),
					),
				).toEqual(
					fingerprint(
						type,
						renderStack(stack.sites, stack.b),
						renderMessage(message.parts, message.b),
					),
				)
			}),
			{ numRuns: 300 },
		)
	})

	/** The JSON branch's own values: everything it promises to redact inside a string or number. */
	const JSON_VOLATILE = ["int", "uuid", "traceId", "email", "origin", "timestamp"] as const
	const JsonMessage = fc
		.uniqueArray(fc.record({ key: name, kind: fc.constantFrom(...JSON_VOLATILE), word: name }), {
			minLength: 1,
			maxLength: 6,
			selector: (entry) => entry.key,
		})
		.chain((entries) =>
			fc.record({
				entries: fc.constant(entries),
				a: churnFor(ValueChurn, entries.length),
				b: churnFor(ValueChurn, entries.length),
			}),
		)
	const renderJson = (
		entries: ReadonlyArray<{ key: string; kind: (typeof JSON_VOLATILE)[number]; word: string }>,
		churn: ReadonlyArray<ValueChurn>,
	) =>
		JSON.stringify(
			Object.fromEntries(
				entries.map(({ key, kind, word }, i) => [
					key,
					kind === "int" ? churn[i]!.n : renderVolatile(kind, word, churn[i]!),
				]),
			),
		)

	it("ignores everything volatile in a JSON-object message", () => {
		fc.assert(
			fc.property(JsonMessage, ({ entries, a, b }) => {
				expect(fingerprint("", "", renderJson(entries, a)).msgSignature).toBe(
					fingerprint("", "", renderJson(entries, b)).msgSignature,
				)
			}),
		)
	})

	/** Lines a stack carries that are not frames: their text must never enter the hash. */
	const NoiseLine = fc.oneof(
		fc
			.record({ user: name, domain: name, n: int(0, 99_999) })
			.map(({ user, domain, n }) => JSON.stringify({ user: `${user}@${domain}.io`, attempt: n })),
		fc
			.record({ n: int(0, 99_999), word: name })
			.map(({ n, word }) => `params: ${n}, ${word}, 2026-10-01 12:00:${n % 60}`),
		fc
			.record({ n: int(0, 999), word: name })
			.map(({ n, word }) => `Code: ${n}. DB::Exception: ${word} at position ${n}`),
		fc.record({ n: int(0, 99), word: name }).map(({ n, word }) => `  at [${n}]["${word}"]`),
		fc.constantFrom("    at http.client POST", "    at POST", "Traceback (most recent call last):"),
	)

	it("never reads a non-frame line as a frame", () => {
		fc.assert(
			fc.property(Stack, fc.array(fc.tuple(NoiseLine, fc.nat()), { maxLength: 5 }), (stack, noise) => {
				const lines = renderStack(stack.sites, stack.a).split("\n")
				const noisy = noise.reduce(
					(acc, [line, at]) => [
						...acc.slice(0, at % (acc.length + 1)),
						line,
						...acc.slice(at % (acc.length + 1)),
					],
					lines,
				)
				expect(fingerprint("Error", noisy.join("\n"), "boom").fpFrames).toBe(
					fingerprint("Error", lines.join("\n"), "boom").fpFrames,
				)
			}),
		)
	})
})

describe("two bugs are two issues", () => {
	it("separates two throw sites with the same callers", () => {
		fc.assert(
			fc.property(Stack, name, name, (stack, fnA, fnB) => {
				fc.pre(fnA !== fnB)
				const [top, ...callers] = stack.sites
				const render = (fn: string) => renderStack([{ ...top!, fn, file: fn }, ...callers], stack.a)
				expect(fingerprint("Error", render(fnA), "").fpFrames).not.toBe(
					fingerprint("Error", render(fnB), "").fpFrames,
				)
			}),
		)
	})

	/**
	 * Schema and code names, including long versioned ones the opaque-token pass must
	 * leave alone. PascalCase with a digit is that pass's documented residual, so it
	 * stays digit-free here.
	 */
	const identifier = fc.oneof(
		name,
		fc
			.tuple(fc.array(name, { minLength: 2, maxLength: 4 }), fc.option(int(1, 9), { nil: undefined }))
			.chain(([words, version]) =>
				fc.constantFrom(
					`${words.join("_")}${version === undefined ? "" : `_v${version}`}`,
					`${words.join("-")}${version === undefined ? "" : `-${version}`}`,
					words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""),
				),
			),
	)

	it("separates two messages that name different things", () => {
		fc.assert(
			fc.property(identifier, identifier, Message, (a, b, message) => {
				fc.pre(a !== b)
				const rest = renderMessage(message.parts, message.a)
				expect(fingerprint("", "", `${a} failed ${rest}`).msgSignature).not.toBe(
					fingerprint("", "", `${b} failed ${rest}`).msgSignature,
				)
			}),
		)
	})
})

describe("an HTTP status is part of the bug", () => {
	/** Each 4xx and 500 is its own failure; every other 5xx is one outage class. */
	const statusClass = (status: number) => (status < 500 || status === 500 ? String(status) : "5xx")
	const STATUS_FORMS = [
		(status: number, word: string) => `StatusCode error (${status} GET /api/${word})`,
		(status: number, word: string) => `StatusCode: Bad response (${status} POST /api/${word})`,
		(status: number) => `statusCode: ${status}`,
		(status: number) => `status=${status}`,
		(status: number) => `HTTP ${status}`,
		(status: number) => `Request failed with status code ${status}`,
	] as const

	it("separates two statuses of different classes and merges two of the same", () => {
		fc.assert(
			fc.property(
				int(100, 599),
				int(100, 599),
				fc.constantFrom(...STATUS_FORMS),
				name,
				Message,
				(a, b, form, word, message) => {
					const rest = renderMessage(message.parts, message.a)
					const sigA = fingerprint("", "", `${form(a, word)} ${rest}`).msgSignature
					const sigB = fingerprint("", "", `${form(b, word)} ${rest}`).msgSignature
					if (statusClass(a) === statusClass(b)) expect(sigA).toBe(sigB)
					else expect(sigA).not.toBe(sigB)
				},
			),
		)
	})
})

describe("signature bounds", () => {
	// Mostly-ASCII text with astral characters, so a cut lands inside a surrogate pair.
	const anyText = fc.oneof(
		fc.string({ unit: "grapheme", maxLength: 1500, size: "large" }),
		fc.string({
			unit: fc.constantFrom("x", " ", "1", "'", "/", ":", "\n", "😀", "𝒳"),
			minLength: MSG_SIGNATURE_CHARS,
			maxLength: 1500,
		}),
	)

	it("keeps a well-formed, bounded signature and at most MAX_FINGERPRINT_FRAMES frames", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 20 }), anyText, anyText, (type, stack, message) => {
				const inputs = computeFingerprintInputs({
					exceptionType: type,
					exceptionStacktrace: stack,
					statusMessage: message,
				})
				const frames = inputs.fpFrames === "" ? [] : inputs.fpFrames.split("\n")
				expect(frames.length).toBeLessThanOrEqual(MAX_FINGERPRINT_FRAMES)
				expect(inputs.topFrame).toBe(frames[0] ?? "")
				expect(inputs.msgSignature).not.toMatch(/\p{Cs}/u)
				expect(inputs.label).not.toMatch(/\p{Cs}/u)
				if (!message.trimStart().startsWith("{"))
					expect(Array.from(inputs.msgSignature).length).toBeLessThanOrEqual(MSG_SIGNATURE_CHARS)
			}),
		)
	})

	// The last alternative is a status the 120-character cut separated from its method.
	it("keeps no digit but an HTTP status in a plain-text signature", () => {
		const STATUS =
			/(HTTP|[Ss]tatus_?[Cc]ode|[Ss]tatus|returned|code|failed|failed with)(:? ?|=)([1-4][0-9][0-9]|500|5xx)|([1-4][0-9][0-9]|500|5xx) (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) |[1-5][0-9x]{0,2}( [A-Z]*)?$/g
		fc.assert(
			fc.property(Message, fc.string({ maxLength: 40 }), (message, text) => {
				const statusMessage = `${text} ${renderMessage(message.parts, message.a)}`
				fc.pre(!statusMessage.trimStart().startsWith("{"))
				expect(fingerprint("", "", statusMessage).msgSignature.replace(STATUS, "")).not.toMatch(
					/[0-9]/,
				)
			}),
		)
	})
})
