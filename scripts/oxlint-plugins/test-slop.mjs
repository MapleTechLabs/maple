/**
 * Local oxlint JS plugin for test cases that cannot catch a bug. Scoped to test files in
 * `.oxlintrc.json`. Each rule is a shape the 2026-10 test audit found deleting was free:
 * the case either mirrored the source, asserted nothing about the result, or grepped code.
 * `no-exact-name-list` and `no-sql-text-pin` come from the same audit's CI history: exact command
 * lists and SQL projection pins failed ~130 times with no real catch outside SQL predicates.
 */

const TEST_CALLEES = new Set(["it", "test"])
const TEST_MODIFIERS = new Set([
	"effect",
	"live",
	"scoped",
	"scopedLive",
	"only",
	"skip",
	"fails",
	"concurrent",
	"prop",
])

/** `it(...)`, `it.effect(...)`, `it.each(rows)(...)`, `test.skip(...)`. */
const isTestCall = (node) => {
	let callee = node.callee
	if (callee.type === "CallExpression") callee = callee.callee
	if (callee.type === "Identifier") return TEST_CALLEES.has(callee.name)
	if (callee.type !== "MemberExpression" || callee.computed) return false
	if (callee.object.type !== "Identifier" || !TEST_CALLEES.has(callee.object.name)) return false
	return TEST_MODIFIERS.has(callee.property.name) || callee.property.name === "each"
}

const testCallback = (node) => {
	const last = node.arguments.at(-1)
	if (last?.type === "ArrowFunctionExpression" || last?.type === "FunctionExpression") return last
	return undefined
}

const EXPECT_ROOTS = new Set(["expect"])

/** `expect(x).not.toBe(y)` → `{ subject: x, matcher: "toBe", negated: true, args: [y] }`. */
const readExpect = (node, roots = EXPECT_ROOTS) => {
	if (node.callee.type !== "MemberExpression" || node.callee.computed) return undefined
	const matcher = node.callee.property.name
	let negated = false
	let object = node.callee.object
	while (object.type === "MemberExpression" && !object.computed) {
		const name = object.property.name
		if (name === "not") negated = true
		else if (name !== "resolves" && name !== "rejects" && name !== "soft") return undefined
		object = object.object
	}
	if (object.type !== "CallExpression") return undefined
	const root = object.callee
	const isExpect =
		(root.type === "Identifier" && roots.has(root.name)) ||
		(root.type === "MemberExpression" && root.object.type === "Identifier" && roots.has(root.object.name))
	if (!isExpect) return undefined
	return { subject: object.arguments[0], matcher, negated, args: node.arguments }
}

/** `assert.strictEqual(a, b)` or a bare `strictEqual(a, b)` from `node:assert`. */
const readAssert = (node, nodeAssertNames) => {
	const callee = node.callee
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.object.name === "assert"
	) {
		return { name: callee.property.name, args: node.arguments }
	}
	if (callee.type === "Identifier" && nodeAssertNames.has(callee.name)) {
		return { name: nodeAssertNames.get(callee.name), args: node.arguments }
	}
	if (callee.type === "Identifier" && callee.name === "assert") return { name: "ok", args: node.arguments }
	return undefined
}

const isLiteralValue = (node) => {
	if (!node) return false
	switch (node.type) {
		case "Literal":
			return true
		case "TemplateLiteral":
			return node.expressions.length === 0
		case "UnaryExpression":
			return node.operator === "-" && node.argument.type === "Literal"
		case "ArrayExpression":
			return node.elements.every((element) => element !== null && isLiteralValue(element))
		case "ObjectExpression":
			return node.properties.every(
				(property) => property.type === "Property" && isLiteralValue(property.value),
			)
		default:
			return false
	}
}

const memberRoot = (node) => {
	let current = node
	while (current.type === "MemberExpression") current = current.object
	return current
}

const SCREAMING_CASE = /^[A-Z][A-Z0-9_]*$/

const NODE_ASSERT_MODULES = new Set(["assert", "node:assert", "assert/strict", "node:assert/strict"])

/** Imported names, plus a local → original map of `node:assert` named imports. */
const trackImports = (imported, nodeAssertNames) => (node) => {
	const fromNodeAssert = NODE_ASSERT_MODULES.has(node.source.value)
	for (const specifier of node.specifiers) {
		imported.add(specifier.local.name)
		if (fromNodeAssert && specifier.type === "ImportSpecifier") {
			nodeAssertNames.set(specifier.local.name, specifier.imported.name ?? specifier.imported.value)
		}
	}
}

// --- no-constant-pin -------------------------------------------------------------------------

const CONSTANT_PIN_MESSAGE =
	"Do not assert an imported constant against a literal. The test restates the source and fails on every intended change. Test the behavior the constant drives, or delete the case."

const PIN_MATCHERS = new Set([
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toContain",
	"toMatchObject",
	"toContainEqual",
])
const PIN_ASSERTS = new Set([
	"strictEqual",
	"deepStrictEqual",
	"equal",
	"deepEqual",
	"include",
	"sameMembers",
	"sameDeepMembers",
])

const isImportedConstant = (node, imported) => {
	if (!node || (node.type !== "Identifier" && node.type !== "MemberExpression")) return false
	const root = memberRoot(node)
	return root.type === "Identifier" && imported.has(root.name) && SCREAMING_CASE.test(root.name)
}

const noConstantPin = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow asserting an imported SCREAMING_CASE constant against a literal." },
		messages: { noConstantPin: CONSTANT_PIN_MESSAGE },
	},
	create(context) {
		const imported = new Set()
		const nodeAssertNames = new Map()
		return {
			ImportDeclaration: trackImports(imported, nodeAssertNames),
			CallExpression(node) {
				const expectation = readExpect(node)
				if (expectation) {
					if (expectation.negated || !PIN_MATCHERS.has(expectation.matcher)) return
					if (
						isImportedConstant(expectation.subject, imported) &&
						isLiteralValue(expectation.args[0])
					) {
						context.report({ node, messageId: "noConstantPin" })
					}
					return
				}
				const assertion = readAssert(node, nodeAssertNames)
				if (!assertion || !PIN_ASSERTS.has(assertion.name)) return
				if (isImportedConstant(assertion.args[0], imported) && isLiteralValue(assertion.args[1])) {
					context.report({ node, messageId: "noConstantPin" })
				}
			},
		}
	},
}

// --- no-weak-only-assertions -----------------------------------------------------------------

const WEAK_ONLY_MESSAGE =
	"Every assertion in this test only checks that something exists or did not throw. Assert the value the code produced, or delete the case."

const PRESENCE_MATCHERS = new Set(["toBeDefined"])
const TRUTHY_MATCHERS = new Set(["toBeTruthy"])
const WEAK_NEGATED_MATCHERS = new Set(["toThrow", "toThrowError", "toBeUndefined"])
const PRESENCE_ASSERTS = new Set([
	"isDefined",
	"exists",
	"isNotNull",
	"isNotUndefined",
	"doesNotThrow",
	"isFunction",
])
const TRUTHY_ASSERTS = new Set(["ok", "isOk"])

/** `expect(() => decode(Schema, body)).not.toThrow()` is a contract check, not a smoke test. */
const VALIDATES = /decode|encode|validate|parse|assert/i
const throwsOnInvalid = (fn) => {
	let found = false
	walk(fn, (child) => {
		if (child.type !== "CallExpression") return
		const name = calleeName(child.callee)
		if (typeof name === "string" && VALIDATES.test(name)) found = true
	})
	return found
}

/** `ok(x)` only checks presence; `ok(isFailure(x))` or `ok(a === b)` checks a computed fact. */
const isBareValue = (node) =>
	node?.type === "Identifier" || node?.type === "MemberExpression" || node?.type === "ChainExpression"

/** A Testing Library query throws when the element is missing, so asserting on it is real. */
const isThrowingQuery = (node) => {
	let current = node
	if (current?.type === "AwaitExpression") current = current.argument
	if (current?.type !== "CallExpression") return false
	const callee = current.callee
	const name = callee.type === "MemberExpression" ? callee.property.name : callee.name
	return typeof name === "string" && /^(get|find)(All)?By/.test(name)
}

const isTypeofFunction = (expectation) =>
	expectation.subject?.type === "UnaryExpression" &&
	expectation.subject.operator === "typeof" &&
	expectation.matcher === "toBe"

/** `true` strong, `false` weak, `undefined` not an assertion. */
const classifyAssertion = (node, nodeAssertNames) => {
	const expectation = readExpect(node)
	if (expectation) {
		if (isThrowingQuery(expectation.subject)) return true
		if (isTypeofFunction(expectation)) return false
		if (expectation.negated && expectation.matcher.startsWith("toThrow"))
			return throwsOnInvalid(expectation.subject)
		if (expectation.negated) return !WEAK_NEGATED_MATCHERS.has(expectation.matcher)
		if (expectation.matcher === "toHaveProperty") return expectation.args.length > 1
		if (TRUTHY_MATCHERS.has(expectation.matcher)) return !isBareValue(expectation.subject)
		return !PRESENCE_MATCHERS.has(expectation.matcher)
	}
	const assertion = readAssert(node, nodeAssertNames)
	if (assertion) {
		if (isThrowingQuery(assertion.args[0])) return true
		if (assertion.name === "doesNotThrow") return throwsOnInvalid(assertion.args[0])
		if (TRUTHY_ASSERTS.has(assertion.name)) return !isBareValue(assertion.args[0])
		return !PRESENCE_ASSERTS.has(assertion.name)
	}
	const callee = node.callee
	const name = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : callee.name
	// Helpers like `expectRow(...)` or `assertDecodes(...)` hide their assertions; trust them.
	if (typeof name === "string" && /^(expect|assert|check|verify)[A-Z_]/.test(name)) return true
	return undefined
}

const noWeakOnlyAssertions = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow tests whose only assertions are existence or does-not-throw checks." },
		messages: { noWeakOnlyAssertions: WEAK_ONLY_MESSAGE },
	},
	create(context) {
		const nodeAssertNames = new Map()
		const frames = []
		return {
			ImportDeclaration: trackImports(new Set(), nodeAssertNames),
			CallExpression(node) {
				if (isTestCall(node) && testCallback(node)) {
					frames.push({ node, strong: 0, weak: 0 })
					return
				}
				const frame = frames.at(-1)
				if (!frame) return
				const verdict = classifyAssertion(node, nodeAssertNames)
				if (verdict === true) frame.strong++
				else if (verdict === false) frame.weak++
			},
			"CallExpression:exit"(node) {
				const frame = frames.at(-1)
				if (frame?.node !== node) return
				frames.pop()
				// A type-level test's real assertion is the `@ts-expect-error` the compiler checks.
				const typeLevel = context.sourceCode
					.getCommentsInside(node)
					.some((comment) => comment.value.includes("@ts-expect-error"))
				if (frame.weak > 0 && frame.strong === 0 && !typeLevel)
					context.report({ node, messageId: "noWeakOnlyAssertions" })
			},
		}
	},
}

// --- no-source-text-assertions ---------------------------------------------------------------

const SOURCE_TEXT_MESSAGE =
	"Do not read source files in a test to assert on their text. That is a lint rule written as a test: it breaks on formatting and passes on equivalent spellings. Use an oxlint rule (`no-restricted-imports`, or a rule in scripts/oxlint-plugins/) instead."

const READ_CALLS = new Set(["readFileSync", "readFile", "readdirSync", "readdir", "globSync", "glob", "file"])
const FS_OBJECTS = new Set(["fs", "fsp", "promises", "Bun"])
const EXEC_CALLS = new Set(["execFileSync", "execSync", "spawnSync"])
const SOURCE_EXTENSION = /\.(m?[jt]sx?|rs|mdx?|astro|css)$/
const FIXTURE_EXTENSION = /\.(json|sql|txt|csv|ndjson|bin|gz)$/

const calleeName = (callee) => {
	if (callee.type === "Identifier") return callee.name
	if (callee.type === "MemberExpression" && !callee.computed) return callee.property.name
	return undefined
}

/** `readFileSync(...)`, `fs.readFileSync(...)`, `Bun.file(...)`, `import.meta.glob(...)`; not `service.readFile(...)`. */
const isFsRead = (callee) => {
	if (callee.type === "Identifier") return READ_CALLS.has(callee.name) && callee.name !== "file"
	if (callee.type !== "MemberExpression" || callee.computed || !READ_CALLS.has(callee.property.name))
		return false
	if (callee.object.type === "MetaProperty") return true
	return callee.object.type === "Identifier" && FS_OBJECTS.has(callee.object.name)
}

const walk = (node, visit) => {
	if (!node || typeof node !== "object") return
	visit(node)
	for (const key of Object.keys(node)) {
		if (key === "parent") continue
		const child = node[key]
		if (Array.isArray(child)) for (const item of child) walk(item, visit)
		else if (child && typeof child === "object" && typeof child.type === "string") walk(child, visit)
	}
}

const scan = (nodes, anchored) => {
	const found = { strings: [], anchored: false }
	for (const node of nodes) {
		walk(node, (child) => {
			if (child.type === "Literal" && typeof child.value === "string") found.strings.push(child.value)
			if (child.type === "TemplateElement") found.strings.push(child.value.cooked ?? "")
			if (child.type === "MetaProperty") found.anchored = true
			if (child.type === "Identifier" && (child.name === "__dirname" || anchored.has(child.name)))
				found.anchored = true
		})
	}
	return found
}

const noSourceTextAssertions = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow tests that read the repo's own source files to grep them." },
		messages: { noSourceTextAssertions: SOURCE_TEXT_MESSAGE },
	},
	create(context) {
		// Names bound to a path derived from the test's own location (`new URL("..", import.meta.url)`).
		const anchored = new Set()
		return {
			VariableDeclarator(node) {
				// One level only: `join(ROOT, "out.json")` derived from an anchored root is usually a scratch dir.
				// A path that names a data file or a fixtures dir is test data, not source.
				if (node.id.type !== "Identifier" || !node.init) return
				const found = scan([node.init], new Set())
				if (found.strings.some((value) => FIXTURE_EXTENSION.test(value) || /fixtures/.test(value)))
					return
				if (found.anchored) anchored.add(node.id.name)
			},
			CallExpression(node) {
				if (isFsRead(node.callee)) {
					const found = scan(node.arguments, anchored)
					if (found.strings.some((value) => FIXTURE_EXTENSION.test(value))) return
					const listing =
						node.callee.type === "Identifier"
							? node.callee.name.startsWith("readdir")
							: node.callee.property.name.startsWith("readdir")
					if (
						(found.anchored && !listing) ||
						found.strings.some((value) => SOURCE_EXTENSION.test(value))
					) {
						context.report({ node, messageId: "noSourceTextAssertions" })
					}
					return
				}
				const name = calleeName(node.callee)
				if (name !== undefined && EXEC_CALLS.has(name)) {
					if (scan(node.arguments, anchored).strings.some((value) => /\bls-files\b/.test(value))) {
						context.report({ node, messageId: "noSourceTextAssertions" })
					}
				}
			},
		}
	},
}

// --- no-classname-assertions -----------------------------------------------------------------

const CLASSNAME_MESSAGE =
	"Do not assert on Tailwind classes. They pin styling, not behavior, and break on every restyle. Assert what the user can observe: role, name, text, state attributes (`aria-*`, `data-*`), or computed geometry."

/** Theme and mode hooks own the class on `<html>`; that class IS their contract. */
const isDocumentRoot = (node) =>
	node?.type === "MemberExpression" &&
	node.property.name === "documentElement" &&
	node.object.type === "Identifier" &&
	node.object.name === "document"

const isClassRead = (node) => {
	if (!node) return false
	let target = node
	while (target.type === "MemberExpression" || target.type === "CallExpression") {
		if (isDocumentRoot(target)) return false
		target = target.type === "CallExpression" ? target.callee : target.object
	}
	if (node.type === "MemberExpression" && !node.computed && node.property.name === "className") return true
	if (node.type === "CallExpression") {
		const name = calleeName(node.callee)
		if (name === "getAttribute" && node.arguments[0]?.value === "class") return true
		if (
			name === "contains" &&
			node.callee.object?.type === "MemberExpression" &&
			node.callee.object.property?.name === "classList"
		) {
			return true
		}
	}
	return false
}

const noClassnameAssertions = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow assertions on an element's class list." },
		messages: { noClassnameAssertions: CLASSNAME_MESSAGE },
	},
	create(context) {
		return {
			CallExpression(node) {
				const expectation = readExpect(node)
				if (!expectation) return
				if (expectation.matcher === "toHaveClass" || isClassRead(expectation.subject)) {
					context.report({ node, messageId: "noClassnameAssertions" })
				}
			},
		}
	},
}

// --- no-exact-name-list ----------------------------------------------------------------------

const EXACT_NAME_LIST_MESSAGE =
	"Do not pin the exact list of command or message names. It breaks whenever an unrelated command is added or reordered. Pin the one command that matters with `toContain`, or assert its effect."

/** A Foldkit command, message or tag name: `FetchClerkOrganization`, `ChangedTimeZonePreference`. */
const PASCAL_NAME = /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/

/** `"FetchX"` or `FetchX.name`, the two spellings scene tests use for a command name. */
const isNameElement = (node) => {
	if (node?.type === "Literal") return typeof node.value === "string" && PASCAL_NAME.test(node.value)
	return (
		node?.type === "MemberExpression" &&
		!node.computed &&
		node.property.name === "name" &&
		node.object.type === "Identifier" &&
		/^[A-Z]/.test(node.object.name)
	)
}

const nameKey = (node) => (node.type === "Literal" ? node.value : node.object.name)

/** Two or more distinct names. `[FetchX.name, FetchX.name]` pins a count ("sent twice"), not a list. */
const isNameList = (node) =>
	node?.type === "ArrayExpression" &&
	node.elements.length >= 2 &&
	node.elements.every(isNameElement) &&
	new Set(node.elements.map(nameKey)).size >= 2

/**
 * Only command lists: event streams and column lists of PascalCase names are real ordering contracts.
 * `names` stays: scene tests bind `const names = commands.map(...)`; row-name lists are not PascalCase.
 */
const COMMAND_SUBJECT = /command|\bnames\b/i

const LIST_MATCHERS = new Set(["toEqual", "toStrictEqual"])
const LIST_ASSERTS = new Set(["deepEqual", "deepStrictEqual"])
// Scene tests sometimes alias `expect` as `assert(x).toEqual(...)`.
const LIST_EXPECT_ROOTS = new Set(["expect", "assert"])

const noExactNameList = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow pinning an exact list of PascalCase command or message names." },
		messages: { noExactNameList: EXACT_NAME_LIST_MESSAGE },
	},
	create(context) {
		const nodeAssertNames = new Map()
		const isCommandList = (subject, expected) =>
			subject !== undefined &&
			COMMAND_SUBJECT.test(context.sourceCode.getText(subject)) &&
			isNameList(expected)
		return {
			ImportDeclaration: trackImports(new Set(), nodeAssertNames),
			CallExpression(node) {
				const expectation = readExpect(node, LIST_EXPECT_ROOTS)
				if (expectation) {
					if (
						!expectation.negated &&
						LIST_MATCHERS.has(expectation.matcher) &&
						isCommandList(expectation.subject, expectation.args[0])
					)
						context.report({ node, messageId: "noExactNameList" })
					return
				}
				const assertion = readAssert(node, nodeAssertNames)
				if (
					assertion &&
					LIST_ASSERTS.has(assertion.name) &&
					isCommandList(assertion.args[0], assertion.args[1])
				)
					context.report({ node, messageId: "noExactNameList" })
			},
		}
	},
}

// --- no-sql-text-pin -------------------------------------------------------------------------

const SQL_TEXT_PIN_MESSAGE =
	"Do not pin the shape of a compiled query (`TraceId AS traceId`, `FORMAT JSON`, `UNION ALL`). It breaks on every refactor and caught no bugs. Keep predicate and security pins (OrgId, WHERE, comparisons, IN, LIMIT, params, escaping) and negated checks; otherwise assert decoded rows, tenantScope or the bound parameters."

const SQL_SUBJECT = /sql|statement/i
// Exact names only: `searchQuery`, `docs` or `liveQuery` are rarely compiled query text.
const SQL_SUBJECT_NAMES = new Set(["query", "queryText", "doc", "gql", "graphql"])

/** `sql`, `receivedSql`, `compiled.sql`, `result.query`; not `document.*` or `queryClient`. */
const sqlSubjectName = (node) => {
	if (node?.type === "Identifier") return node.name
	if (node?.type !== "MemberExpression" || node.computed) return undefined
	const root = memberRoot(node)
	if (root.type === "Identifier" && root.name === "document") return undefined
	return node.property.name
}

const isSqlSubject = (node) => {
	const name = sqlSubjectName(node)
	return name !== undefined && (SQL_SUBJECT.test(name) || SQL_SUBJECT_NAMES.has(name))
}

/** Text a pin asserts on: the string, the template's static parts, or a regex source. */
const pinText = (node) => {
	if (node?.type === "Literal") {
		if (typeof node.value === "string") return node.value
		// Unescape so `/groupArray\(/` reads as the call it pins.
		if (node.regex) return node.regex.pattern.replace(/\\(.)/g, "$1")
		return undefined
	}
	if (node?.type === "TemplateLiteral")
		return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("${}")
	return undefined
}

// Predicates and security invariants: the only SQL pins that ever caught a real bug.
const PREDICATE_PINS = [
	/OrgId|orgFilter|\borg|tenant/i,
	/\b(PRE)?WHERE\b|\bHAVING\b/,
	// Real comparison operators only, so a lambda arrow `x -> x.4` does not exempt a pin.
	/\s(<=|>=|<>|!=|<|>)(\s|$)|!=|<=|>=|\s=(\s|$)|=\s*'/,
	/\bBETWEEN\b|\bIN\b|\bNOT\b|\b(I)?LIKE\b/,
	/ifNotFinite|isFinite|isNaN|SampleRate|Weighted/,
	/\bLIMIT\b|\bOFFSET\b/,
	/__PARAM_|\{[a-z]\w*:\w/,
	/\\'|\\\\|''|`/,
	// Time bounds and GraphQL filter arguments (`edgeResponseStatus_geq: 500`, `requestSource: "x"`).
	/\d{4}-\d{2}-\d{2}/,
	/_(geq|gt|leq|lt|neq|in|notin|like)\b|\bfilter\b|:\s*"[^"]*"/,
	/\b(mapContains|has|hasAny|hasAll|startsWith|endsWith|position\w*|match|multiSearch\w*|(not)?[eE]mpty|isNull|isNotNull)\(/,
	// A bare value (`'production'`, `api-gateway`, `http.method`) pins a filter value or table.
	/^'[^']*'$/,
	/^[a-z0-9][a-z0-9._-]*$/,
	// Table routing (`FROM service_overview_hourly`) picks the rollup tier, a semantic choice.
	/^FROM \w+$/,
	// A function call, grain, order or bucket width is the computation, not its shape.
	/\w\(/,
	/\b(GROUP|ORDER|PARTITION) BY\b|\bINTERVAL\b/,
]

// Cosmetic only: a bare `col AS alias`, output format, unions, a bare SELECT or JOIN keyword.
// Anything with a function call, grain, order or bucket width is exempt via PREDICATE_PINS.
const COSMETIC_PINS = [
	/\bAS\s+[`"]?\w+/,
	/\bFORMAT\b/,
	/\bUNION(\s+ALL)?\b/,
	/^\s*SELECT\s*$/,
	/^\s*((LEFT|RIGHT|INNER|CROSS|FULL)\s+)?JOIN\s*$/,
]

/** A template with no static words (`${token}`) is a catalog-driven coverage check, not a pin. */
const isProjectionPin = (text) =>
	/[A-Za-z]{2}/.test(text.replaceAll("${}", "")) &&
	COSMETIC_PINS.some((pattern) => pattern.test(text)) &&
	!PREDICATE_PINS.some((pattern) => pattern.test(text))

const SQL_MATCHERS = new Set(["toContain", "toMatch"])
const SQL_ASSERTS = new Set(["include", "match"])

const noSqlTextPin = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Disallow pinning projection or clause text of a compiled SQL or GraphQL query.",
		},
		messages: { noSqlTextPin: SQL_TEXT_PIN_MESSAGE },
	},
	create(context) {
		const report = (node, subject, pin) => {
			if (!isSqlSubject(subject)) return
			const text = pinText(pin)
			if (text !== undefined && isProjectionPin(text))
				context.report({ node, messageId: "noSqlTextPin" })
		}
		return {
			CallExpression(node) {
				const expectation = readExpect(node)
				if (expectation) {
					if (!expectation.negated && SQL_MATCHERS.has(expectation.matcher))
						report(node, expectation.subject, expectation.args[0])
					return
				}
				const callee = node.callee
				if (
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.object.type === "Identifier" &&
					callee.object.name === "assert" &&
					SQL_ASSERTS.has(callee.property.name)
				) {
					report(node, node.arguments[0], node.arguments[1])
				}
			},
		}
	},
}

export default {
	meta: { name: "test-slop" },
	rules: {
		"no-classname-assertions": noClassnameAssertions,
		"no-constant-pin": noConstantPin,
		"no-exact-name-list": noExactNameList,
		"no-source-text-assertions": noSourceTextAssertions,
		"no-sql-text-pin": noSqlTextPin,
		"no-weak-only-assertions": noWeakOnlyAssertions,
	},
}
