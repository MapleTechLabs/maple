import { Result, Schema } from "effect"
import { FieldRefSchema, FieldNamespaceSchema } from "./model"
import type { FieldNamespace, FieldRef, NormalizedSignal, SignalPredicate, SignalScalarType } from "./model"
import { fieldKey } from "./model"
import type { ValidationIssue } from "./predicate"

export type SignalLeafOperator = "exists" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"
export type ReplayCapability = "exact" | "coerced" | "unavailable"

interface SignalFieldCatalogEntryBase {
	readonly operators: readonly SignalLeafOperator[]
	readonly sensitivity: "public" | "sensitive"
	readonly replay: ReplayCapability
}

export type SignalFieldCatalogEntry = SignalFieldCatalogEntryBase &
	(
		| { readonly field: FieldRef; readonly types?: never }
		| {
				readonly field: Pick<FieldRef, "namespace" | "key">
				readonly types: readonly SignalScalarType[]
		  }
	)

export interface OpenFieldNamespacePolicy {
	readonly namespace: FieldNamespace
	readonly types: readonly SignalScalarType[]
	readonly operators: readonly SignalLeafOperator[]
	readonly sensitivity: "public" | "sensitive"
	readonly replay: ReplayCapability
}

export interface SignalSourceDefinition {
	readonly sourceKind: string
	readonly fields: readonly SignalFieldCatalogEntry[]
	readonly openFields?: readonly OpenFieldNamespacePolicy[]
}

export interface SignalSourceAdapter<TRaw, TContext = unknown> {
	readonly definition: SignalSourceDefinition
	readonly normalize: (raw: TRaw, context: TContext) => readonly NormalizedSignal[]
}

interface RegisteredSignalSource {
	readonly definition: SignalSourceDefinition
	readonly fields: ReadonlyMap<string, SignalFieldCatalogEntry>
	readonly openFields: ReadonlyMap<FieldNamespace, OpenFieldNamespacePolicy>
}

const catalogEntryTypes = (entry: SignalFieldCatalogEntry): readonly SignalScalarType[] => {
	if (entry.types !== undefined) return entry.types
	return [entry.field.type]
}

const Operators = Schema.Array(
	Schema.Literals(["exists", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]),
).check(Schema.isMinLength(1))
const ScalarTypes = Schema.Array(FieldRefSchema.fields.type).check(Schema.isMinLength(1))
const PolicyFields = {
	operators: Operators,
	sensitivity: Schema.Literals(["public", "sensitive"]),
	replay: Schema.Literals(["exact", "coerced", "unavailable"]),
}
const SourceDefinitionSchema = Schema.Struct({
	sourceKind: Schema.NonEmptyString.check(Schema.isTrimmed()),
	fields: Schema.Array(
		Schema.Union([
			Schema.Struct({ ...PolicyFields, field: FieldRefSchema }),
			Schema.Struct({
				...PolicyFields,
				field: Schema.Struct({ namespace: FieldNamespaceSchema, key: FieldRefSchema.fields.key }),
				types: ScalarTypes,
			}),
		]),
	),
	openFields: Schema.optionalKey(
		Schema.Array(Schema.Struct({ ...PolicyFields, namespace: FieldNamespaceSchema, types: ScalarTypes })),
	),
})
export class SignalSourceInvalid extends Schema.TaggedError<SignalSourceInvalid>()(
	"@maple/eventing-core/SignalSourceInvalid",
	{ message: Schema.String, sourceKind: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class SignalSourceRegistry {
	readonly #sources = new Map<string, RegisteredSignalSource>()

	register(definition: SignalSourceDefinition): Result.Result<this, SignalSourceInvalid> {
		const self = this
		return Result.gen(function* () {
			yield* Schema.decodeUnknownResult(SourceDefinitionSchema)(definition).pipe(
				Result.mapError(
					(cause) =>
						new SignalSourceInvalid({
							sourceKind: definition.sourceKind,
							message: cause.message,
							cause,
						}),
				),
			)
			if (self.#sources.has(definition.sourceKind))
				return yield* Result.fail(
					new SignalSourceInvalid({
						sourceKind: definition.sourceKind,
						message: `duplicate source registration: ${definition.sourceKind}`,
					}),
				)

			const fields = new Map<string, SignalFieldCatalogEntry>()
			for (const entry of definition.fields) {
				const key = fieldKey(entry.field)
				if (fields.has(key))
					return yield* Result.fail(
						new SignalSourceInvalid({
							sourceKind: definition.sourceKind,
							message: `duplicate field catalog entry: ${definition.sourceKind}:${key}`,
						}),
					)
				fields.set(key, entry)
			}

			const openFields = new Map<FieldNamespace, OpenFieldNamespacePolicy>()
			for (const policy of definition.openFields ?? []) {
				if (openFields.has(policy.namespace))
					return yield* Result.fail(
						new SignalSourceInvalid({
							sourceKind: definition.sourceKind,
							message: `duplicate open field policy: ${definition.sourceKind}:${policy.namespace}`,
						}),
					)
				openFields.set(policy.namespace, policy)
			}

			self.#sources.set(definition.sourceKind, { definition, fields, openFields })
			return self
		})
	}

	get(sourceKind: string): RegisteredSignalSource | undefined {
		return this.#sources.get(sourceKind)
	}
}

const leafFields = (
	predicate: SignalPredicate,
): ReadonlyArray<{
	readonly field: FieldRef
	readonly operator: SignalLeafOperator
	readonly path: string
}> => {
	const fields: Array<{ field: FieldRef; operator: SignalLeafOperator; path: string }> = []
	const visit = (node: SignalPredicate, path: string): void => {
		switch (node.op) {
			case "all":
			case "any":
				for (const [i, clause] of node.clauses.entries()) visit(clause, `${path}.clauses[${i}]`)
				break
			case "not":
				visit(node.clause, `${path}.clause`)
				break
			default:
				fields.push({ field: node.field, operator: node.op, path })
		}
	}
	visit(predicate, "selector")
	return fields
}

export const validatePredicateAgainstSource = (
	predicate: SignalPredicate,
	source: RegisteredSignalSource,
): readonly ValidationIssue[] => {
	const issues: ValidationIssue[] = []
	for (const leaf of leafFields(predicate)) {
		const catalogEntry = source.fields.get(fieldKey(leaf.field))
		if (catalogEntry) {
			const catalogTypes = catalogEntryTypes(catalogEntry)
			if (!catalogTypes.includes(leaf.field.type))
				issues.push({
					path: `${leaf.path}.field.type`,
					message: `catalog field ${fieldKey(leaf.field)} allows ${catalogTypes.join(", ")}`,
				})
			if (!catalogEntry.operators.includes(leaf.operator))
				issues.push({
					path: `${leaf.path}.op`,
					message: `${leaf.operator} is not allowed for catalog field ${fieldKey(leaf.field)}`,
				})
			continue
		}

		const open = source.openFields.get(leaf.field.namespace)
		if (!open) {
			issues.push({
				path: `${leaf.path}.field`,
				message: `unknown field ${fieldKey(leaf.field)} for source ${source.definition.sourceKind}`,
			})
			continue
		}
		if (!open.types.includes(leaf.field.type))
			issues.push({
				path: `${leaf.path}.field.type`,
				message: `${leaf.field.type} is not allowed for open ${leaf.field.namespace} fields`,
			})
		if (!open.operators.includes(leaf.operator))
			issues.push({
				path: `${leaf.path}.op`,
				message: `${leaf.operator} is not allowed for open ${leaf.field.namespace} fields`,
			})
	}
	return issues
}
