/**
 * The wire between maple-ai and the sandbox Worker's execution sandbox (`Executor`).
 *
 * One executor per security audit run: prepare installs the commit and its dependencies once,
 * then each agent command runs inside the executor's isolation (no network, its own uid, a bounded
 * scratch, resource limits). Everything crosses a service binding as JSON, so it is data only.
 */
import { Schema } from "effect"
import { SandboxCheckout } from "./sandbox"

export const EXECUTOR_PREPARE_PATH = "/internal/executor/prepare"
export const EXECUTOR_RUN_PATH = "/internal/executor/run"
export const EXECUTOR_DESTROY_PATH = "/internal/executor/destroy"

/** What every target-controlled command is held to; the agents' prompt quotes {@link executorLimitsText}. */
export const EXECUTOR_LIMITS = {
	memoryBytes: 1024 * 1024 * 1024,
	processes: 256,
	fileSizeBytes: 64 * 1024 * 1024,
	openFiles: 1024,
	scratchBytes: 512 * 1024 * 1024,
	defaultTimeoutMs: 60_000,
	maxTimeoutMs: 300_000,
	/** Per output stream; the rest is counted, not returned. */
	outputBytes: 32 * 1024,
	promotedFileBytes: 256 * 1024,
	promotedTotalBytes: 1024 * 1024,
	promotedFiles: 16,
} as const

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`

export const executorLimitsText = (): string =>
	[
		"no network (loopback only)",
		`${mib(EXECUTOR_LIMITS.memoryBytes)} memory`,
		`${EXECUTOR_LIMITS.processes} processes`,
		`${mib(EXECUTOR_LIMITS.fileSizeBytes)} per written file`,
		`${mib(EXECUTOR_LIMITS.scratchBytes)} scratch`,
		`${EXECUTOR_LIMITS.maxTimeoutMs / 1000}s wall clock per command`,
		"the checkout and its installed dependencies are read-only; only your scratch is writable",
		`up to ${EXECUTOR_LIMITS.promotedFiles} promoted scratch files per command, ${EXECUTOR_LIMITS.promotedFileBytes / 1024} KiB each, ${EXECUTOR_LIMITS.promotedTotalBytes / 1024} KiB in total`,
	].join("; ")

const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Message = Bounded(4 * 1024)

/** One executor per run; the key is the run id. */
export const ExecutorKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u))

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/u

/** The skill's canonical agent id: lowercase so ids cannot collide by case, never a device name. */
export const ExecutorAgentId = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
	Schema.makeFilter((value: string) => !WINDOWS_DEVICE_NAMES.test(value), {
		title: "executorAgentId",
		expected: "an agent id that is not a Windows device name",
	}),
)

/**
 * A scratch-relative file to promote. Rejects what step 1 of the skill's promotion procedure
 * rejects (absolute, empty, `.` or `..` components); symlinked components are refused in the
 * container, where the walk is made without following links.
 */
export const ExecutorScratchPath = Schema.String.check(
	Schema.isMaxLength(512),
	Schema.makeFilter(
		(value: string) =>
			!value.startsWith("/") &&
			// eslint-disable-next-line no-control-regex
			!/[\u0000-\u001f]/u.test(value) &&
			value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
		{ title: "executorScratchPath", expected: "a scratch-relative path with no empty, `.` or `..` part" },
	),
)

export class ExecutorPromotion extends Schema.Class<ExecutorPromotion>("ExecutorPromotion")({
	path: ExecutorScratchPath,
	maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EXECUTOR_LIMITS.promotedFileBytes })),
}) {}

export class ExecutorPrepareRequest extends Schema.Class<ExecutorPrepareRequest>("ExecutorPrepareRequest")({
	executorKey: ExecutorKey,
	/** The token reaches only the registry gateway, never the container. */
	checkout: SandboxCheckout,
}) {}

export const ExecutorWorkingDirectory = Schema.Literals(["checkout", "scratch"])
export type ExecutorWorkingDirectory = typeof ExecutorWorkingDirectory.Type

export class ExecutorRunRequest extends Schema.Class<ExecutorRunRequest>("ExecutorRunRequest")({
	executorKey: ExecutorKey,
	agentId: ExecutorAgentId,
	/** A bash program, run as the agent's own unprivileged uid. */
	command: Bounded(16 * 1024).check(
		Schema.makeFilter((value: string) => !value.includes("\u0000"), {
			title: "executorCommand",
			expected: "a command with no NUL byte",
		}),
	),
	cwd: ExecutorWorkingDirectory,
	timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: EXECUTOR_LIMITS.maxTimeoutMs })),
	promote: Schema.Array(ExecutorPromotion).check(Schema.isMaxLength(EXECUTOR_LIMITS.promotedFiles)),
}) {}

export class ExecutorDestroyRequest extends Schema.Class<ExecutorDestroyRequest>("ExecutorDestroyRequest")({
	executorKey: ExecutorKey,
}) {}

/** The executor could not be reached or could not run the request. */
export class ExecutorUnavailable extends Schema.TaggedClass<ExecutorUnavailable>()("ExecutorUnavailable", {
	message: Message,
}) {}

/** One lockfile's install during prepare. */
export class ExecutorInstall extends Schema.Class<ExecutorInstall>("ExecutorInstall")({
	/** Checkout-relative directory holding the lockfile; `.` is the root. */
	dir: Schema.String,
	manager: Schema.Literals(["npm", "pnpm", "bun", "yarn"]),
	outcome: Schema.Literals(["installed", "failed", "skipped"]),
	detail: Message,
}) {}

export class ExecutorPrepared extends Schema.TaggedClass<ExecutorPrepared>()("ExecutorPrepared", {
	installs: Schema.Array(ExecutorInstall),
}) {}

/** Prepare is running in the background; ask again shortly. Not a failure. */
export class ExecutorPreparing extends Schema.TaggedClass<ExecutorPreparing>()("ExecutorPreparing", {
	message: Message,
}) {}

export class ExecutorPrepareFailed extends Schema.TaggedClass<ExecutorPrepareFailed>()(
	"ExecutorPrepareFailed",
	{ message: Message },
) {}

export const ExecutorPrepareResponse = Schema.Union([
	ExecutorPrepared,
	ExecutorPreparing,
	ExecutorPrepareFailed,
	ExecutorUnavailable,
])
export type ExecutorPrepareResponse = typeof ExecutorPrepareResponse.Type

export class ExecutorArtifact extends Schema.Class<ExecutorArtifact>("ExecutorArtifact")({
	path: Schema.String,
	bytes: Schema.Finite,
	sha256: Schema.String,
	/** The first few KiB as UTF-8, so the agent can cite what it promoted. */
	preview: Bounded(8 * 1024),
}) {}

export class ExecutorRejectedArtifact extends Schema.Class<ExecutorRejectedArtifact>(
	"ExecutorRejectedArtifact",
)({
	path: Schema.String,
	reason: Message,
}) {}

export class ExecutorRunExited extends Schema.TaggedClass<ExecutorRunExited>()("ExecutorRunExited", {
	exitCode: Schema.Finite,
	timedOut: Schema.Boolean,
	stdout: Schema.String,
	stderr: Schema.String,
	stdoutBytes: Schema.Finite,
	stderrBytes: Schema.Finite,
	wallTimeMs: Schema.Finite,
	promoted: Schema.Array(ExecutorArtifact),
	rejected: Schema.Array(ExecutorRejectedArtifact),
}) {}

/** The executor holds no prepared checkout (never prepared, or its container stopped); prepare again. */
export class ExecutorNotPrepared extends Schema.TaggedClass<ExecutorNotPrepared>()("ExecutorNotPrepared", {
	message: Message,
}) {}

export const ExecutorRunResponse = Schema.Union([ExecutorRunExited, ExecutorNotPrepared, ExecutorUnavailable])
export type ExecutorRunResponse = typeof ExecutorRunResponse.Type

export class ExecutorDestroyed extends Schema.TaggedClass<ExecutorDestroyed>()("ExecutorDestroyed", {}) {}

export const ExecutorDestroyResponse = Schema.Union([ExecutorDestroyed, ExecutorUnavailable])
export type ExecutorDestroyResponse = typeof ExecutorDestroyResponse.Type
