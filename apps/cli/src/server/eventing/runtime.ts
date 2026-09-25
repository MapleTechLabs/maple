// BOUNDARY: activation candidates and decoded OTLP bodies arrive unparsed; this runtime decodes them.
import { Context, Duration, Effect, Exit, Layer, Result, Schema, SynchronizedRef } from "effect"
import { createHash } from "node:crypto"
import {
	canonicalJson,
	CompiledProjectionRegistry,
	isJsonValue,
	ProjectorRegistry,
	SignalSourceRegistry,
	assertSignalProjectionInputBudget,
	SignalProjectionSpecSchema,
	type MapleCloudEvent,
	type JsonValue,
	type NormalizedSignal,
	type ProjectionFailure,
	type ProjectionInvalid,
	type SignalProjectionSpec,
	type SignalSourceInvalid,
} from "@maple/eventing-core"
import type { OtlpFieldError } from "../otlp/encode"
import {
	type DeliveryGap,
	type EventConsumer,
	type EventConsumerAcknowledgement,
	type EventConsumerClaim,
	type EventConsumerFailure,
	type EventConsumerStart,
	type EventingControlSnapshotValidation,
	type EventingControlStoreError,
	type EventingOutboxPage,
	LocalEventingControlStore,
	type OutboxAdministrationInvalid,
	type OutboxCapacity,
	type StageEventsResult,
} from "./control-store"
import { normalizeOtlpLogsWithDiagnostics, OTLP_LOG_SOURCE, type OtlpRecoveryIdentity } from "./otlp"
import { observeEventing } from "./telemetry"

const TENANT_ID = "local"

/** A batch carries two different records under one source identity; retrying it cannot succeed. */
export class SourceOccurrenceCollision extends Schema.TaggedError<SourceOccurrenceCollision>()(
	"@maple/cli/eventing/SourceOccurrenceCollision",
	{ message: Schema.String, occurrenceId: Schema.NullOr(Schema.String) },
) {}

/** A staged occurrence can no longer be recovered safely; the batch is refused until an operator abandons it. */
export class StagedOccurrenceUnrecoverable extends Schema.TaggedError<StagedOccurrenceUnrecoverable>()(
	"@maple/cli/eventing/StagedOccurrenceUnrecoverable",
	{ message: Schema.String, occurrenceId: Schema.String },
) {}

/** A normalized occurrence carried non-finite JSON, so it has no stable fingerprint. */
export class SourceOccurrenceInvalid extends Schema.TaggedError<SourceOccurrenceInvalid>()(
	"@maple/cli/eventing/SourceOccurrenceInvalid",
	{ message: Schema.String },
) {}

export class ProjectionActivationInvalid extends Schema.TaggedError<ProjectionActivationInvalid>()(
	"@maple/cli/eventing/ProjectionActivationInvalid",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Another activation committed between prepare and commit; the request can be retried. */
export class ProjectionActivationConflict extends Schema.TaggedError<ProjectionActivationConflict>()(
	"@maple/cli/eventing/ProjectionActivationConflict",
	{ message: Schema.String },
) {}

/** Everything an OTLP evaluation can fail with; serve.ts maps each to a status. */
export type LocalProjectionEvaluationError =
	| OtlpFieldError
	| SourceOccurrenceCollision
	| StagedOccurrenceUnrecoverable
	| SourceOccurrenceInvalid
	| ProjectionInvalid
	| EventingControlStoreError

export interface LocalProjectionEvaluation {
	readonly events: readonly MapleCloudEvent[]
	readonly eventSourceFingerprints: ReadonlyMap<string, string>
	readonly recoveredEventIds: readonly string[]
	readonly failures: readonly ProjectionFailure[]
	readonly typeMismatchFields: readonly string[]
}

export interface LocalProjectionActivation {
	readonly spec: SignalProjectionSpec
	readonly next: readonly SignalProjectionSpec[]
	readonly compiled: CompiledProjectionRegistry
	readonly generation: number
}

export interface LocalEventingHealth extends EventingControlSnapshotValidation {
	readonly activeProjections: number
	readonly deliveryGap: DeliveryGap
	readonly outboxCapacity: OutboxCapacity
}

export interface LocalEventingRuntimeApi {
	readonly hasActiveSource: (sourceKind: string) => Effect.Effect<boolean>
	/** Validation and full registry compilation, run while ingest admission stays open. */
	readonly prepareActivation: (
		candidate: unknown,
	) => Effect.Effect<LocalProjectionActivation, ProjectionActivationInvalid | EventingControlStoreError>
	readonly commitActivation: (
		activation: LocalProjectionActivation,
	) => Effect.Effect<void, ProjectionActivationConflict | EventingControlStoreError>
	readonly activate: (
		candidate: unknown,
	) => Effect.Effect<
		void,
		ProjectionActivationInvalid | ProjectionActivationConflict | EventingControlStoreError
	>
	readonly listActive: Effect.Effect<readonly SignalProjectionSpec[], EventingControlStoreError>
	readonly evaluateOtlp: (
		signal: "traces" | "logs" | "metrics",
		decoded: unknown,
		isRetiredUtcDay?: (rangeDate: string) => boolean,
	) => Effect.Effect<LocalProjectionEvaluation, LocalProjectionEvaluationError>
	readonly persistFailures: (
		failures: readonly ProjectionFailure[],
	) => Effect.Effect<void, EventingControlStoreError>
	readonly stage: (
		events: readonly MapleCloudEvent[],
		sourceFingerprints?: ReadonlyMap<string, string>,
	) => Effect.Effect<StageEventsResult, EventingControlStoreError>
	readonly markReady: (eventIds: readonly string[]) => Effect.Effect<void, EventingControlStoreError>
	readonly listReady: (
		limit?: number,
		after?: number,
	) => Effect.Effect<EventingOutboxPage, EventingControlStoreError>
	readonly listStaged: (
		limit?: number,
		after?: number,
	) => Effect.Effect<EventingOutboxPage, EventingControlStoreError>
	readonly listConsumers: Effect.Effect<readonly EventConsumer[], EventingControlStoreError>
	readonly registerConsumer: (
		consumerId: string,
		startAt: EventConsumerStart,
	) => Effect.Effect<EventConsumer, EventConsumerFailure>
	readonly disableConsumer: (consumerId: string) => Effect.Effect<EventConsumer, EventConsumerFailure>
	readonly claimReady: (
		consumerId: string,
		limit: number,
		leaseSeconds: number,
	) => Effect.Effect<EventConsumerClaim, EventConsumerFailure>
	readonly acknowledgeClaim: (
		consumerId: string,
		leaseToken: string,
		throughSequence: number,
	) => Effect.Effect<EventConsumerAcknowledgement, EventConsumerFailure>
	readonly acceptDeliveryGap: (
		consumerId: string,
		generation: number,
	) => Effect.Effect<DeliveryGap, EventConsumerFailure>
	readonly abandonEvents: (
		eventIds: readonly string[],
	) => Effect.Effect<
		{ readonly abandoned: number; readonly gap: DeliveryGap },
		OutboxAdministrationInvalid | EventingControlStoreError
	>
	readonly health: Effect.Effect<LocalEventingHealth, EventingControlStoreError>
}

/** The projector implementations the registry compiles against; tests register examples here. */
export const LocalEventingProjectors = Context.Reference<ProjectorRegistry>(
	"@maple/cli/eventing/LocalEventingProjectors",
	{ defaultValue: () => new ProjectorRegistry() },
)

const emptyEvaluation = (): LocalProjectionEvaluation => ({
	events: [],
	eventSourceFingerprints: new Map(),
	recoveredEventIds: [],
	failures: [],
	typeMismatchFields: [],
})

export const sourceOccurrenceFingerprint = (
	signal: NormalizedSignal,
): Result.Result<string, SourceOccurrenceInvalid> => {
	if (!isJsonValue(signal.data))
		return Result.fail(
			new SourceOccurrenceInvalid({ message: "normalized source occurrence must contain finite JSON" }),
		)
	const content: JsonValue = {
		sourceKind: signal.sourceKind,
		source: signal.source,
		tenantId: signal.tenantId,
		occurrenceId: signal.occurrenceId,
		identityQuality: signal.identityQuality,
		occurredAt: signal.occurredAt,
		observedAt: signal.observedAt,
		subject: signal.subject,
		fields: [...signal.fields.entries()]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, value]) => ({ key, value })),
		data: signal.data,
	}
	return Result.succeed(`sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`)
}

const sourceOccurrenceKey = (
	occurrence: Pick<NormalizedSignal, "tenantId" | "sourceKind" | "source" | "occurrenceId">,
): string | null =>
	occurrence.occurrenceId === null
		? null
		: canonicalJson([
				occurrence.tenantId,
				occurrence.sourceKind,
				occurrence.source,
				occurrence.occurrenceId,
			])

const recoveryIdentityKey = (identity: OtlpRecoveryIdentity): string =>
	canonicalJson([identity.tenantId, identity.sourceKind, identity.source, identity.occurrenceId])

interface RegistryState {
	readonly compiled: CompiledProjectionRegistry
	readonly activeSourceKinds: ReadonlySet<string>
	readonly generation: number
}

const activationInvalid = (cause: unknown): ProjectionActivationInvalid =>
	new ProjectionActivationInvalid({
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	})

export class LocalEventingRuntime extends Context.Service<LocalEventingRuntime, LocalEventingRuntimeApi>()(
	"@maple/cli/eventing/LocalEventingRuntime",
) {
	static readonly make: Effect.Effect<
		LocalEventingRuntimeApi,
		SignalSourceInvalid | ProjectionInvalid | EventingControlStoreError,
		LocalEventingControlStore
	> = Effect.gen(function* () {
		const store = yield* LocalEventingControlStore
		const projectors = yield* LocalEventingProjectors
		const sources = yield* Effect.fromResult(new SignalSourceRegistry().register(OTLP_LOG_SOURCE))
		const specs = yield* store.loadEnabledProjections(TENANT_ID)
		const compiled = yield* Effect.fromResult(
			CompiledProjectionRegistry.compile(specs, sources, projectors),
		)
		// Commits are serialized by the ref, so a stale activation always fails as a conflict.
		const registry = yield* SynchronizedRef.make<RegistryState>({
			compiled,
			activeSourceKinds: new Set(specs.map(({ sourceKind }) => sourceKind)),
			generation: 0,
		})

		const hasActiveSource = (sourceKind: string): Effect.Effect<boolean> =>
			Effect.map(SynchronizedRef.get(registry), ({ activeSourceKinds }) =>
				activeSourceKinds.has(sourceKind),
			)

		const listActive = store.loadEnabledProjections(TENANT_ID)

		const prepareActivation = Effect.fn("LocalEventing.prepareActivation")(function* (
			candidate: unknown,
		) {
			const spec = yield* Effect.try({
				try: () => {
					assertSignalProjectionInputBudget(candidate)
					return Schema.decodeUnknownSync(SignalProjectionSpecSchema)(candidate)
				},
				catch: activationInvalid,
			})
			if (spec.tenantId !== TENANT_ID)
				return yield* new ProjectionActivationInvalid({
					message: `Maple Local only accepts projections for tenant ${TENANT_ID}`,
				})
			const active = (yield* listActive).filter((candidate) => candidate.id !== spec.id)
			const next = spec.enabled ? [...active, spec] : active
			const nextCompiled = yield* Effect.fromResult(
				CompiledProjectionRegistry.compile(next, sources, projectors),
			).pipe(Effect.mapError(activationInvalid))
			const { generation } = yield* SynchronizedRef.get(registry)
			return { spec, next, compiled: nextCompiled, generation } satisfies LocalProjectionActivation
		})

		const commitActivation = Effect.fn("LocalEventing.commitActivation")(function* (
			activation: LocalProjectionActivation,
		) {
			yield* SynchronizedRef.modifyEffect(
				registry,
				(
					state,
				): Effect.Effect<
					readonly [void, RegistryState],
					ProjectionActivationConflict | EventingControlStoreError
				> =>
					activation.generation !== state.generation
						? Effect.fail(
								new ProjectionActivationConflict({
									message:
										"projection registry changed during activation; retry the request",
								}),
							)
						: Effect.as(store.saveProjection(activation.spec), [
								undefined,
								{
									compiled: activation.compiled,
									activeSourceKinds: new Set(
										activation.next.map(({ sourceKind }) => sourceKind),
									),
									generation: state.generation + 1,
								} satisfies RegistryState,
							]),
			)
		})

		const evaluateOtlp = Effect.fn("LocalEventing.evaluateOtlp")(function* (
			signal: "traces" | "logs" | "metrics",
			decoded: unknown,
			isRetiredUtcDay: (rangeDate: string) => boolean = () => false,
		) {
			const sourceKind =
				signal === "logs" ? "otel.log" : signal === "traces" ? "otel.span" : "otel.metric"
			if (
				!(yield* hasActiveSource(sourceKind)) &&
				!(yield* store.hasStagedSourceKind(TENANT_ID, sourceKind))
			)
				return emptyEvaluation()
			const acceptedAt = new Date().toISOString()
			const [elapsed, normalization] = yield* Effect.timed(
				Effect.exit(
					signal === "logs"
						? normalizeOtlpLogsWithDiagnostics(decoded, acceptedAt, TENANT_ID)
						: Effect.succeed({
								signals: [],
								unprojectedIdentities: [],
								ineligible: 0,
								failures: 0,
							}),
				),
			)
			if (Exit.isFailure(normalization)) {
				yield* observeEventing({
					operation: "normalization",
					outcome: "failure",
					durationMs: Duration.toMillis(elapsed),
					sourceKind,
				})
				return yield* Effect.failCause(normalization.cause)
			}
			const {
				signals: normalized,
				unprojectedIdentities,
				failures: normalizationFailures,
			} = normalization.value
			yield* observeEventing({
				operation: "normalization",
				outcome: "success",
				count: normalized.length,
				durationMs: Duration.toMillis(elapsed),
				sourceKind,
			})
			if (normalizationFailures > 0)
				yield* observeEventing({
					operation: "normalization",
					outcome: "failure",
					count: normalizationFailures,
					sourceKind,
				})
			const sourceFingerprints = new Map<string, string>()
			for (const occurrence of normalized) {
				const key = sourceOccurrenceKey(occurrence)
				if (key === null) continue
				const fingerprint = yield* Effect.fromResult(sourceOccurrenceFingerprint(occurrence))
				const prior = sourceFingerprints.get(key)
				if (prior !== undefined && prior !== fingerprint)
					return yield* new SourceOccurrenceCollision({
						message: `source occurrence collision within one ingest batch: ${occurrence.occurrenceId}`,
						occurrenceId: occurrence.occurrenceId,
					})
				sourceFingerprints.set(key, fingerprint)
			}
			for (const identity of unprojectedIdentities) {
				if (sourceFingerprints.has(recoveryIdentityKey(identity)))
					return yield* new SourceOccurrenceCollision({
						message: `source occurrence collision with an unprojectable record within one ingest batch: ${identity.occurrenceId}`,
						occurrenceId: identity.occurrenceId,
					})
				if (
					yield* store.hasStagedSourceOccurrence(
						identity.tenantId,
						identity.sourceKind,
						identity.source,
						identity.occurrenceId,
					)
				)
					return yield* new StagedOccurrenceUnrecoverable({
						message: `cannot safely recover staged source occurrence after projection normalization failed: ${identity.occurrenceId}`,
						occurrenceId: identity.occurrenceId,
					})
			}
			const { compiled: snapshot } = yield* SynchronizedRef.get(registry)
			const events: MapleCloudEvent[] = []
			const eventSourceFingerprints = new Map<string, string>()
			const recoveredEventIds: string[] = []
			const failures: ProjectionFailure[] = []
			const typeMismatchFields = new Set<string>()
			for (const occurrence of normalized) {
				const sourceFingerprint = yield* Effect.fromResult(sourceOccurrenceFingerprint(occurrence))
				if (occurrence.occurrenceId !== null) {
					const staged = yield* store.stagedEventIdsForOccurrence(
						occurrence.tenantId,
						occurrence.sourceKind,
						occurrence.source,
						occurrence.occurrenceId,
						sourceFingerprint,
					)
					if (staged.length > 0) {
						recoveredEventIds.push(...staged)
						continue
					}
				}
				if (isRetiredUtcDay(occurrence.occurredAt.slice(0, 10))) continue
				const result = yield* Effect.fromResult(snapshot.evaluate(occurrence, acceptedAt))
				yield* observeEventing({
					operation: "projection",
					outcome: "success",
					count: result.events.length,
					sourceKind,
				})
				yield* observeEventing({
					operation: "projection",
					outcome: "failure",
					count: result.failures.length,
					sourceKind,
				})
				events.push(...result.events)
				for (const event of result.events) {
					const priorFingerprint = eventSourceFingerprints.get(event.id)
					if (priorFingerprint !== undefined && priorFingerprint !== sourceFingerprint)
						return yield* new SourceOccurrenceCollision({
							message: `source occurrence collision within one ingest batch: ${event.id}`,
							occurrenceId: occurrence.occurrenceId,
						})
					eventSourceFingerprints.set(event.id, sourceFingerprint)
				}
				failures.push(...result.failures)
				for (const mismatch of result.typeMismatchFields) typeMismatchFields.add(mismatch)
			}
			if (typeMismatchFields.size > 0)
				yield* observeEventing({
					operation: "selector_type_mismatch",
					outcome: "observed",
					count: typeMismatchFields.size,
					sourceKind,
				})
			return {
				events,
				eventSourceFingerprints,
				recoveredEventIds,
				failures,
				typeMismatchFields: [...typeMismatchFields],
			} satisfies LocalProjectionEvaluation
		})

		return {
			hasActiveSource,
			prepareActivation,
			commitActivation,
			activate: (candidate) => Effect.flatMap(prepareActivation(candidate), commitActivation),
			listActive,
			evaluateOtlp,
			persistFailures: (failures) =>
				failures.length > 0 ? store.recordProjectionFailures(TENANT_ID, failures) : Effect.void,
			stage: (events, sourceFingerprints = new Map()) =>
				store.stageEvents(events, sourceFingerprints).pipe(Effect.withSpan("LocalEventing.stage")),
			markReady: (eventIds) =>
				store.markReady(eventIds).pipe(Effect.withSpan("LocalEventing.markReady")),
			listReady: store.listReady,
			listStaged: store.listStaged,
			listConsumers: store.listConsumers(TENANT_ID),
			registerConsumer: (consumerId, startAt) => store.registerConsumer(TENANT_ID, consumerId, startAt),
			disableConsumer: (consumerId) => store.disableConsumer(TENANT_ID, consumerId),
			claimReady: (consumerId, limit, leaseSeconds) =>
				store.claimReady(TENANT_ID, consumerId, limit, leaseSeconds),
			acknowledgeClaim: (consumerId, leaseToken, throughSequence) =>
				store.acknowledgeClaim(TENANT_ID, consumerId, leaseToken, throughSequence),
			acceptDeliveryGap: (consumerId, generation) =>
				store.acceptDeliveryGap(TENANT_ID, consumerId, generation),
			abandonEvents: (eventIds) => store.abandonEvents(TENANT_ID, eventIds),
			health: Effect.gen(function* () {
				return {
					activeProjections: (yield* listActive).length,
					deliveryGap: yield* store.deliveryGap(TENANT_ID),
					outboxCapacity: yield* store.outboxCapacity,
					...(yield* store.validate),
				}
			}),
		} satisfies LocalEventingRuntimeApi
	})

	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LocalEventingControlStore.layer))
}
