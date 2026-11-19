/**
 * The audit-archive Worker: sole consumer of `audit-intake`. Each batch is written to the
 * write-once bucket, then forwarded to `audit-events` for api's warehouse write. Kept apart
 * from api so api holds no binding to the bucket and cannot consume entries before they are kept.
 */
import {
	AuditArchiveBucket,
	AuditEventsDlq,
	AuditEventsQueue,
	AuditIntakeQueue,
	MapleStack,
	mapleWorkerProps,
} from "@maple/infra/cloudflare"
import { selfObservabilityEnv } from "@maple/infra/env"
import { resolveWorkerEnv } from "@maple/infra/secret-guard"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Stream, Array as Arr } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import {
	AuditArchiveForwardError,
	AuditArchiveWriteError,
	type ArchivePorts,
	processArchiveBatch,
} from "./archive"

const AUDIT_ARCHIVE_CONSUMER = {
	batchSize: 25,
	maxConcurrency: 2,
	maxRetries: 5,
	maxWaitTime: "5 seconds",
} satisfies Cloudflare.Queues.MessagesProps

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const env = yield* resolveWorkerEnv("audit-archive", selfObservabilityEnv(stack.stage, stack.region))
	return {
		main: import.meta.url,
		...mapleWorkerProps("audit-archive", stack),
		env,
		workersDev: false,
	}
})

export default class AuditArchiveWorker extends Cloudflare.Worker<AuditArchiveWorker>()(
	"audit-archive",
	props,
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.WriteBucket(AuditArchiveBucket)
		const ingest = yield* Cloudflare.Queues.WriteQueue(AuditEventsQueue)
		const ports: ArchivePorts = {
			putObject: (key, body) =>
				dischargeRuntimeContext(
					bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } }),
				).pipe(
					Effect.mapError(
						(cause) =>
							new AuditArchiveWriteError({ message: "Audit archive put failed", key, cause }),
					),
					Effect.asVoid,
				),
			forward: (bodies) =>
				dischargeRuntimeContext(ingest.sendBatch(Arr.map(bodies, (body) => ({ body })))).pipe(
					Effect.mapError(
						(cause) => new AuditArchiveForwardError({ message: "Audit forward failed", cause }),
					),
				),
			newBatchId: Effect.sync(() => SecureRandom.uuidV4Unsafe()),
		}
		// The dead-letter setting is a plan-time value: the DLQ's props are empty in the isolate.
		const dlq = yield* AuditEventsDlq
		const queue = yield* AuditIntakeQueue
		yield* Cloudflare.Queues.consumeQueueMessages(
			queue,
			{ ...AUDIT_ARCHIVE_CONSUMER, deadLetterQueue: dlq.Props.name },
			(stream) =>
				Effect.flatMap(Stream.runCollect(stream), (messages) =>
					processArchiveBatch(messages, AUDIT_ARCHIVE_CONSUMER.maxRetries, ports),
				),
		)
		return {}
	}).pipe(
		Effect.provide([
			Cloudflare.R2.WriteBucketBinding,
			Cloudflare.Queues.WriteQueueBinding,
			Cloudflare.Queues.EventSourceLive,
			WorkerTelemetry({ serviceName: "audit-archive" }),
		]),
	),
) {}
