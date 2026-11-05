/**
 * Oxlint JS plugin for the syntax-level halves of the Effect conventions: oxlint has no
 * `no-restricted-syntax`, so banning a statement kind or a member takes a plugin rule.
 *
 * - `no-try-catch`: failures go through the typed error channel, not exceptions.
 * - `no-effect-die`: and not through defects either; each real defect argues for itself.
 * - `no-date-parse`: a zone-less timestamp is read in the host timezone.
 * - `no-record-string-any`: the worst `any`, kept at error while an `any` backlog burns down.
 * - `no-react-use-effect`: derive during render or act in handlers; one sanctioned mount hook.
 *
 * @see https://oxc.rs/docs/guide/usage/linter/js-plugins.html
 */

/** `<Object>.<property>` in any position, the call and the value form alike. */
const memberRule = ({ object, property, description, message, type = "problem" }) => ({
	meta: { type, docs: { description }, messages: { banned: message } },
	create(context) {
		return {
			MemberExpression(node) {
				if (node.computed) return
				if (node.object.type !== "Identifier" || node.object.name !== object) return
				if (node.property.type !== "Identifier" || node.property.name !== property) return
				context.report({ node, messageId: "banned" })
			},
		}
	},
})

const noTryCatch = {
	meta: {
		type: "problem",
		docs: { description: "Disallow `try`/`catch`/`finally` in favour of Effect's typed error channel." },
		messages: {
			noTryCatch:
				"Do not use `try`/`catch`. A thrown exception is invisible to the type system, so it escapes the typed error channel, and one `catch` block flattens every failure into a single branch. Use `Effect.try`/`Effect.tryPromise` for a throwing call, `Schema.fromJsonString` for JSON, `Schema.decodeUnknown{Effect,Option,Sync}` for decoding, `Effect.catch`/`catchTag`/`catchDefect` to handle a failure, and `Effect.ensuring`/`Effect.addFinalizer` for a `finally`.",
		},
	},
	create(context) {
		return {
			TryStatement(node) {
				context.report({ node, messageId: "noTryCatch" })
			},
		}
	},
}

const noEffectDie = memberRule({
	object: "Effect",
	property: "die",
	description: "Disallow `Effect.die`, which converts a typed failure into a defect.",
	message:
		"Do not `Effect.die`. Killing a typed failure discards the distinction tagged errors exist to preserve, and the caller loses the branch it could have handled. `Effect.mapError` into a failure the contract declares, or narrow the producer's channel so the impossible case is not in it. If it genuinely is a defect (boot-time config, a missing platform binding, a broken invariant), disable the rule on that line with the reason.",
})

const noDateParse = memberRule({
	object: "Date",
	property: "parse",
	description: "Disallow `Date.parse`, which reads zone-less timestamps in the host timezone.",
	message:
		"Do not use `Date.parse`. A timestamp without a zone (`2026-10-07 10:00:00`) is read in the HOST's timezone: right in production by luck, hours off on a developer machine, silently. Decode to a `DateTime.Utc` with `Schema.DateTimeUtcFromString` / `DateTime.make`, or use a helper that reads zone-less strings as UTC.",
})

/** `{ [key: string]: any }`: the index-signature spelling of `Record<string, any>`. */
const isStringToAnyIndexSignature = (node) =>
	node.members?.length === 1 &&
	node.members[0].type === "TSIndexSignature" &&
	node.members[0].parameters?.length === 1 &&
	node.members[0].parameters[0].typeAnnotation?.typeAnnotation?.type === "TSStringKeyword" &&
	node.members[0].typeAnnotation?.typeAnnotation?.type === "TSAnyKeyword"

const noRecordStringAny = {
	meta: {
		type: "problem",
		docs: { description: "Disallow `Record<string, any>` and its index-signature equivalent." },
		messages: {
			noRecordStringAny:
				"Do not use `Record<string, any>`: an open key set whose values are unchecked too. `Record<string, unknown>` at least forces a narrow before use; better, model it (an interface, a Schema.Struct) or use a typed `ReadonlyRecord`/`Map`.",
		},
	},
	create(context) {
		// `<T extends Record<string, any>>` is the builder-DSL idiom for "any object shape";
		// `unknown` does not work in a constraint. Parents visit first, so recording it here is enough.
		const constraints = new Set()
		const report = (node) => {
			if (constraints.has(node)) return
			context.report({ node, messageId: "noRecordStringAny" })
		}
		return {
			TSTypeParameter(node) {
				if (node.constraint) constraints.add(node.constraint)
			},
			TSTypeReference(node) {
				if (node.typeName?.type !== "Identifier" || node.typeName.name !== "Record") return
				const params = node.typeArguments?.params
				if (params?.length !== 2) return
				if (params[0].type !== "TSStringKeyword" || params[1].type !== "TSAnyKeyword") return
				report(node)
			},
			TSTypeLiteral(node) {
				if (isStringToAnyIndexSignature(node)) report(node)
			},
		}
	},
}

const importedName = (specifier) =>
	specifier.imported?.type === "Identifier" ? specifier.imported.name : specifier.imported?.value

const memberName = (member) => {
	if (!member.computed && member.property.type === "Identifier") return member.property.name
	if (member.computed && member.property.type === "Literal") return member.property.value
	return undefined
}

const DEFAULT_MOUNT_EFFECT_FILES = ["src/hooks/use-mount-effect.ts"]

const noReactUseEffect = {
	meta: {
		type: "suggestion",
		docs: { description: "Disallow direct React `useEffect` imports and calls." },
		messages: {
			noReactUseEffect:
				"Do not call React.useEffect directly. Derive values during render, act in event handlers, use a data-fetching library, or use useMountEffect for mount-scoped external synchronization.",
		},
		schema: [
			{
				type: "object",
				properties: { allowFiles: { type: "array", items: { type: "string" } } },
				additionalProperties: false,
			},
		],
	},
	create(context) {
		// The one module behind the sanctioned mount-only escape hatch. The exception lives with the
		// rule so runners that ignore root overrides agree. Paths are matched as suffixes.
		const allowFiles = context.options?.[0]?.allowFiles ?? DEFAULT_MOUNT_EFFECT_FILES
		const filename = context.filename?.replaceAll("\\", "/")
		if (filename && allowFiles.some((suffix) => filename === suffix || filename.endsWith(`/${suffix}`))) {
			return {}
		}
		const reactNamespaces = new Set()
		return {
			ImportDeclaration(node) {
				if (node.source.value !== "react" || node.importKind === "type") return
				for (const specifier of node.specifiers) {
					if (specifier.type === "ImportSpecifier") {
						if (specifier.importKind !== "type" && importedName(specifier) === "useEffect") {
							context.report({ node: specifier, messageId: "noReactUseEffect" })
						}
						continue
					}
					reactNamespaces.add(specifier.local.name)
				}
			},
			MemberExpression(node) {
				if (node.object.type !== "Identifier" || !reactNamespaces.has(node.object.name)) return
				if (memberName(node) !== "useEffect") return
				context.report({ node, messageId: "noReactUseEffect" })
			},
		}
	},
}

export default {
	meta: { name: "effect-strict" },
	rules: {
		"no-date-parse": noDateParse,
		"no-effect-die": noEffectDie,
		"no-react-use-effect": noReactUseEffect,
		"no-record-string-any": noRecordStringAny,
		"no-try-catch": noTryCatch,
	},
}
