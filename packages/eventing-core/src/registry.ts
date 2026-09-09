import { makeCloudEvent } from "./event"
import { Result, Schema } from "effect"
import type {
	JsonValue,
	MapleCloudEvent,
	NormalizedSignal,
	ProjectedEventData,
	SignalProjectionSpec,
} from "./model"
import { timestampToEpochNanos, compileSignalPredicate, validateSignalProjectionSpec } from "./predicate"
import { SignalProjectionSpecSchema } from "./model"
import { SignalSourceRegistry, validatePredicateAgainstSource } from "./source"

// BOUNDARY: projector codecs intentionally own decoding of untrusted configuration and output values.
export interface SignalProjector<TConfig = unknown, TData extends JsonValue = JsonValue> {
	readonly id: string
	readonly version: number
	readonly sourceKinds: readonly string[]
	readonly outputType: string
	readonly dataSchema: string
	readonly decodeConfig: (value: unknown) => TConfig
	readonly decodeOutput: (value: unknown) => TData
	readonly project: (signal: NormalizedSignal, config: TConfig) => ProjectedEventData<TData>
}

interface ErasedSignalProjector {
	readonly id: string
	readonly version: number
	readonly sourceKinds: readonly string[]
	readonly outputType: string
	readonly dataSchema: string
	readonly decodeOutput: (value: unknown) => JsonValue
	readonly prepare: (value: unknown) => (signal: NormalizedSignal) => ProjectedEventData
}
export class ProjectionInvalid extends Schema.TaggedError<ProjectionInvalid>()(
	"@maple/eventing-core/ProjectionInvalid",
	{
		message: Schema.String,
		projectionId: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}
const ProjectorMetadataSchema = Schema.Struct({
	id: Schema.NonEmptyString.check(Schema.isTrimmed()),
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	sourceKinds: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	outputType: Schema.NonEmptyString.check(Schema.isTrimmed()),
	dataSchema: Schema.NonEmptyString.check(Schema.isTrimmed()),
})

export class ProjectorRegistry {
	readonly #projectors = new Map<string, ErasedSignalProjector>()

	register<TConfig, TData extends JsonValue>(
		projector: SignalProjector<TConfig, TData>,
	): Result.Result<this, ProjectionInvalid> {
		const self = this
		return Result.gen(function* () {
			yield* Schema.decodeUnknownResult(ProjectorMetadataSchema)(projector).pipe(
				Result.mapError((cause) => new ProjectionInvalid({ message: cause.message, cause })),
			)
			const key = ProjectorRegistry.key(projector.id, projector.version)
			if (self.#projectors.has(key))
				return yield* Result.fail(
					new ProjectionInvalid({ message: `duplicate projector registration: ${key}` }),
				)
			self.#projectors.set(key, {
				id: projector.id,
				version: projector.version,
				sourceKinds: projector.sourceKinds,
				outputType: projector.outputType,
				dataSchema: projector.dataSchema,
				decodeOutput: projector.decodeOutput,
				prepare: (value) => {
					const config = projector.decodeConfig(value)
					return (signal) => projector.project(signal, config)
				},
			})
			return self
		})
	}

	get(id: string, version: number): ErasedSignalProjector | undefined {
		return this.#projectors.get(ProjectorRegistry.key(id, version))
	}

	static key(id: string, version: number): string {
		return `${id}@${version}`
	}
}

interface CompiledProjection {
	readonly spec: SignalProjectionSpec
	readonly evaluate: ReturnType<typeof compileSignalPredicate>
	readonly projector: ErasedSignalProjector
	readonly project: (signal: NormalizedSignal) => ProjectedEventData
	readonly activeFromNanos: bigint
}

export interface ProjectionFailure {
	readonly projectionId: string
	readonly projectionRevision: number
	readonly occurrenceId: string | null
	readonly message: string
}

export interface ProjectionBatchResult {
	readonly events: readonly MapleCloudEvent[]
	readonly failures: readonly ProjectionFailure[]
	readonly typeMismatchFields: readonly string[]
}

/** Immutable compiled snapshot. Hosts atomically replace the whole instance. */
export class CompiledProjectionRegistry {
	readonly #bySourceKind: ReadonlyMap<string, readonly CompiledProjection[]>

	private constructor(bySourceKind: ReadonlyMap<string, readonly CompiledProjection[]>) {
		this.#bySourceKind = bySourceKind
	}

	static compile(
		specs: readonly SignalProjectionSpec[],
		sources: SignalSourceRegistry,
		projectors: ProjectorRegistry,
	): Result.Result<CompiledProjectionRegistry, ProjectionInvalid> {
		return Result.gen(function* () {
			const bySourceKind = new Map<string, CompiledProjection[]>()
			const revisions = new Set<string>()

			for (const candidate of specs) {
				const spec = yield* Schema.decodeUnknownResult(SignalProjectionSpecSchema)(candidate).pipe(
					Result.mapError((cause) => new ProjectionInvalid({ message: cause.message, cause })),
				)
				const source = sources.get(spec.sourceKind)
				if (!source)
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: `projection ${spec.id}@${spec.revision} references an unregistered source ${spec.sourceKind}`,
						}),
					)
				const issues = [
					...validateSignalProjectionSpec(spec),
					...validatePredicateAgainstSource(spec.selector, source),
				]
				if (issues.length > 0)
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: `invalid projection ${spec.id}@${spec.revision}: ${issues
								.map(({ path, message }) => `${path}: ${message}`)
								.join("; ")}`,
						}),
					)
				const revisionKey = `${spec.tenantId}:${spec.id}@${spec.revision}`
				if (revisions.has(revisionKey))
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: `duplicate projection revision: ${revisionKey}`,
						}),
					)
				revisions.add(revisionKey)
				if (!spec.enabled) continue

				const projector = projectors.get(spec.projector.id, spec.projector.version)
				if (!projector)
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: `projection ${spec.id}@${spec.revision} references an unregistered projector ${spec.projector.id}@${spec.projector.version}`,
						}),
					)
				if (!projector.sourceKinds.includes(spec.sourceKind))
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: `projector ${projector.id}@${projector.version} does not accept ${spec.sourceKind}`,
						}),
					)

				const activeFromNanos = timestampToEpochNanos(spec.activeFrom)
				if (activeFromNanos === null)
					return yield* Result.fail(
						new ProjectionInvalid({
							projectionId: spec.id,
							message: "invalid projection activeFrom timestamp",
						}),
					)
				const compiled: CompiledProjection = {
					spec,
					evaluate: compileSignalPredicate(spec.selector),
					projector,
					project: yield* Result.try({
						try: () => projector.prepare(spec.projector.config),
						catch: (cause) =>
							new ProjectionInvalid({
								message: "invalid projector config",
								projectionId: spec.id,
								cause,
							}),
					}),
					activeFromNanos,
				}
				const bucket = bySourceKind.get(spec.sourceKind)
				if (bucket) bucket.push(compiled)
				else bySourceKind.set(spec.sourceKind, [compiled])
			}

			return new CompiledProjectionRegistry(bySourceKind)
		})
	}

	evaluate(
		signal: NormalizedSignal,
		acceptedAt: string,
	): Result.Result<ProjectionBatchResult, ProjectionInvalid> {
		const self = this
		return Result.gen(function* () {
			const events: MapleCloudEvent[] = []
			const failures: ProjectionFailure[] = []
			const typeMismatchFields = new Set<string>()
			const acceptedAtNanos = timestampToEpochNanos(acceptedAt)
			if (acceptedAtNanos === null)
				return yield* Result.fail(
					new ProjectionInvalid({ message: "projection acceptance time must be a valid instant" }),
				)

			for (const projection of self.#bySourceKind.get(signal.sourceKind) ?? []) {
				if (projection.spec.tenantId !== signal.tenantId) continue
				if (acceptedAtNanos < projection.activeFromNanos) continue
				const evaluation = projection.evaluate(signal)
				for (const field of evaluation.typeMismatches)
					typeMismatchFields.add(`${field.namespace}:${field.key}`)
				if (!evaluation.matches) continue

				const outcome = Result.try(() => {
					const projected = projection.project(signal)
					return makeCloudEvent({
						signal,
						projection: projection.spec,
						projectorId: projection.projector.id,
						projectorVersion: projection.projector.version,
						outputType: projection.projector.outputType,
						dataSchema: projection.projector.dataSchema,
						subject: projected.subject,
						time: projected.time,
						data: projection.projector.decodeOutput(projected.data),
					})
				}).pipe(Result.flatMap((result) => result))
				if (Result.isSuccess(outcome)) events.push(outcome.success)
				else {
					const error = outcome.failure
					failures.push({
						projectionId: projection.spec.id,
						projectionRevision: projection.spec.revision,
						occurrenceId: signal.occurrenceId,
						message: Schema.is(Schema.Struct({ message: Schema.String }))(error)
							? error.message
							: String(error),
					})
				}
			}

			return { events, failures, typeMismatchFields: [...typeMismatchFields] }
		})
	}
}
