/**
 * The repository sandbox's command-execution port: a request, a versioned event stream, and its
 * typed failures. Taken over from `@yielded/agent/sandbox`, which retired it in 0.1.0-beta.189.
 */
import { Context, Duration, Schema, type Stream } from "effect"

const BoundedName = Schema.NonEmptyString.check(Schema.isMaxLength(256))
const BoundedPath = Schema.NonEmptyString.check(Schema.isMaxLength(4 * 1024))
const BoundedArgument = Schema.String.check(Schema.isMaxLength(32 * 1024))
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_ARTIFACT_RULES = 64
const BoundedOutputText = Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_BYTES))

export const SANDBOX_DIAGNOSTIC_MAX_LENGTH = 8 * 1024
const BoundedDiagnostic = Schema.String.check(Schema.isMaxLength(SANDBOX_DIAGNOSTIC_MAX_LENGTH))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const PositiveNumber = Schema.Finite.check(Schema.isGreaterThan(0))
const MaxOutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES))
const BoundedArguments = Schema.Array(BoundedArgument).check(Schema.isMaxLength(256))
const BoundedEnvironmentNames = Schema.Array(BoundedName).check(Schema.isMaxLength(128))

const FinitePositiveDuration = Schema.Duration.pipe(
	Schema.refine(
		(duration): duration is Duration.Duration =>
			Duration.isFinite(duration) && Duration.isPositive(duration),
		{ expected: "a finite positive duration" },
	),
)

const FiniteNonNegativeDuration = Schema.Duration.pipe(
	Schema.refine(
		(duration): duration is Duration.Duration =>
			Duration.isFinite(duration) && !Duration.isNegative(duration),
		{ expected: "a finite non-negative duration" },
	),
)

/** A requested runtime image or executable environment. */
export class SandboxRuntime extends Schema.Class<SandboxRuntime>("SandboxRuntime")({
	kind: Schema.Literals(["container", "microvm", "wasm", "unisolated-process"]),
	identity: BoundedName,
}) {}

/** The implementation that executed a request, and its isolation posture. */
export class SandboxImplementation extends Schema.Class<SandboxImplementation>("SandboxImplementation")({
	isolation: Schema.Literals(["isolated", "unisolated"]),
	identity: BoundedName,
}) {}

/** A host path made available to the requested runtime. */
export class SandboxMount extends Schema.Class<SandboxMount>("SandboxMount")({
	source: BoundedPath,
	target: BoundedPath,
	access: Schema.Literals(["read-only", "read-write"]),
}) {}

/** Denies all workload network access. */
export class NetworkDisabled extends Schema.TaggedClass<NetworkDisabled>()("NetworkDisabled", {}) {}

/** Permits connections only to the named destinations and ports. */
export class NetworkAllowlist extends Schema.TaggedClass<NetworkAllowlist>()("NetworkAllowlist", {
	domains: Schema.Array(BoundedName).check(Schema.isMaxLength(256)),
	ports: Schema.Array(PositiveInt.check(Schema.isLessThanOrEqualTo(65_535))).check(Schema.isMaxLength(256)),
}) {}

export const SandboxNetworkPolicy = Schema.Union([NetworkDisabled, NetworkAllowlist])
export type SandboxNetworkPolicy = typeof SandboxNetworkPolicy.Type

/** Names of ambient variables that may be copied into the workload environment. */
export class SandboxEnvironment extends Schema.Class<SandboxEnvironment>("SandboxEnvironment")({
	allow: BoundedEnvironmentNames,
}) {}

/** Limits an implementation must either enforce or reject. */
export class SandboxLimits extends Schema.Class<SandboxLimits>("SandboxLimits")({
	cpuCores: Schema.optionalKey(PositiveNumber.check(Schema.isLessThanOrEqualTo(1_024))),
	memoryBytes: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(1024 * 1024 * 1024 * 1024))),
	maxOutputBytes: MaxOutputBytes,
	maxWallTime: FinitePositiveDuration,
}) {}

/** A secret reference; raw secret values are never part of a request. */
export class SandboxSecretHandle extends Schema.Class<SandboxSecretHandle>("SandboxSecretHandle")({
	id: BoundedName,
	purpose: Schema.NonEmptyString.check(Schema.isMaxLength(2 * 1024)),
}) {}

/** A rule for copying selected output out of the runtime. */
export class SandboxArtifactRule extends Schema.Class<SandboxArtifactRule>("SandboxArtifactRule")({
	path: BoundedPath,
	maxBytes: MaxOutputBytes,
}) {}

/** An artifact the implementation released after applying its rules. */
export class SandboxArtifact extends Schema.Class<SandboxArtifact>("SandboxArtifact")({
	path: BoundedPath,
	bytes: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
	digest: BoundedName,
	mediaType: Schema.optionalKey(BoundedName),
}) {}

/** One command execution. Command and arguments stay separate. */
export class SandboxRequest extends Schema.Class<SandboxRequest>("SandboxRequest")({
	runtime: SandboxRuntime,
	command: BoundedPath,
	args: BoundedArguments,
	cwd: BoundedPath,
	environment: SandboxEnvironment,
	mounts: Schema.Array(SandboxMount).check(Schema.isMaxLength(64)),
	network: SandboxNetworkPolicy,
	limits: SandboxLimits,
	secretHandles: Schema.Array(SandboxSecretHandle).check(Schema.isMaxLength(64)),
	artifactRules: Schema.Array(SandboxArtifactRule).check(Schema.isMaxLength(MAX_ARTIFACT_RULES)),
}) {}

/** What one execution used, as far as the implementation could observe. */
export class SandboxResourceUse extends Schema.Class<SandboxResourceUse>("SandboxResourceUse")({
	wallTime: FiniteNonNegativeDuration,
	stdoutBytes: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
	stderrBytes: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
	cpuMillis: Schema.optionalKey(Schema.Natural),
	memoryBytes: Schema.optionalKey(Schema.Natural),
}) {}

const SandboxEventBase = {
	eventVersion: Schema.Literal(1),
	implementation: SandboxImplementation,
}

export class SandboxStarted extends Schema.TaggedClass<SandboxStarted>()("SandboxStarted", {
	...SandboxEventBase,
	runtime: SandboxRuntime,
}) {}

/** A bounded stdout or stderr fragment. */
export class SandboxOutput extends Schema.TaggedClass<SandboxOutput>()("SandboxOutput", {
	...SandboxEventBase,
	stream: Schema.Literals(["stdout", "stderr"]),
	text: BoundedOutputText,
	bytes: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
}) {}

export class SandboxExited extends Schema.TaggedClass<SandboxExited>()("SandboxExited", {
	...SandboxEventBase,
	exitCode: Schema.Int,
	resourceUse: SandboxResourceUse,
	artifacts: Schema.Array(SandboxArtifact).check(Schema.isMaxLength(MAX_ARTIFACT_RULES)),
}) {}

export const SandboxEvent = Schema.Union([SandboxStarted, SandboxOutput, SandboxExited])
export type SandboxEvent = typeof SandboxEvent.Type

/** The command never started. */
export class SandboxSpawnError extends Schema.TaggedError<SandboxSpawnError>()(
	"@maple/backend/sandbox/SandboxSpawnError",
	{
		implementation: SandboxImplementation,
		command: BoundedPath,
		message: BoundedDiagnostic,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** The process started and ended unsuccessfully. */
export class SandboxExitError extends Schema.TaggedError<SandboxExitError>()(
	"@maple/backend/sandbox/SandboxExitError",
	{
		implementation: SandboxImplementation,
		exitCode: Schema.Int,
		message: BoundedDiagnostic,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export class SandboxTimeoutError extends Schema.TaggedError<SandboxTimeoutError>()(
	"@maple/backend/sandbox/SandboxTimeoutError",
	{
		implementation: SandboxImplementation,
		maxWallTime: FinitePositiveDuration,
	},
) {}

export class SandboxOutputLimitError extends Schema.TaggedError<SandboxOutputLimitError>()(
	"@maple/backend/sandbox/SandboxOutputLimitError",
	{
		implementation: SandboxImplementation,
		stream: Schema.Literals(["stdout", "stderr"]),
		limit: PositiveInt,
		observed: PositiveInt,
	},
) {}

/** The implementation cannot honestly enforce a requested feature. */
export class SandboxUnsupportedRequestError extends Schema.TaggedError<SandboxUnsupportedRequestError>()(
	"@maple/backend/sandbox/SandboxUnsupportedRequestError",
	{
		implementation: SandboxImplementation,
		feature: Schema.Literals([
			"runtime",
			"mounts",
			"network",
			"cpu-limit",
			"memory-limit",
			"secret-handles",
			"artifacts",
		]),
		message: BoundedDiagnostic,
	},
) {}

export const SandboxError = Schema.Union([
	SandboxSpawnError,
	SandboxExitError,
	SandboxTimeoutError,
	SandboxOutputLimitError,
	SandboxUnsupportedRequestError,
])
export type SandboxError = typeof SandboxError.Type

/** Scoped command execution. Every event names the implementation and its isolation posture. */
export class Sandbox extends Context.Service<
	Sandbox,
	{
		readonly execute: (request: SandboxRequest) => Stream.Stream<SandboxEvent, SandboxError>
	}
>()("@maple/backend/sandbox/Sandbox") {}
