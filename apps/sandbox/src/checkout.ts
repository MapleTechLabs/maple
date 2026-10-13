/**
 * What the sandbox Durable Object asks its container to do.
 *
 * Kept apart from `worker.ts` so it can be unit-tested without a Worker runtime: everything here
 * is a function of {@link SandboxContainer}, which the Durable Object implements over
 * `ctx.container`.
 *
 * Two facts about that container drive most of the shape below. Commands run one fresh process
 * each, so nothing carries from one into the next. And a tool call should answer in seconds while
 * a cold `git clone` of a real repository takes far longer, so the clone runs in the background
 * and callers poll it.
 */
import {
	SANDBOX_COMMAND_ENV,
	SANDBOX_CHECKOUT_GRACE_MINUTES,
	SANDBOX_MAX_CHECKOUTS,
	SANDBOX_MIRROR_DIR,
	SANDBOX_MIRROR_LOCK,
	SANDBOX_RUN_AS_USER,
	SANDBOX_SEED_DIR,
	SANDBOX_SNAPSHOT_DIR,
	SANDBOX_TRAILER,
	SANDBOX_WORKSPACE_ROOT,
	SandboxCheckout,
	SandboxExecRequest,
	SandboxRunCheckoutFailed,
	SandboxRunCheckoutPending,
	SandboxRunExited,
	SandboxRunIsolationUnavailable,
	SandboxRunTimedOut,
	SandboxRunUnavailable,
	boundMessage,
	redactSecret,
	shellCommand,
	shellQuote,
	type SandboxExecResponse,
} from "@maple/domain/sandbox"
import { Cause, Effect, Option, Schema } from "effect"

export interface SandboxExecResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly duration: number
	/** The command outran its timeout and was killed, with everything it started. */
	readonly timedOut: boolean
}

export class SandboxCallError extends Schema.TaggedError<SandboxCallError>()(
	"@maple/sandbox/SandboxCallError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** What the sandbox Durable Object does with its container on this module's behalf. */
export interface SandboxContainer {
	/** Runs a shell command string to completion. */
	readonly exec: (
		command: string,
		options?: { readonly cwd?: string; readonly timeout?: number },
	) => Effect.Effect<SandboxExecResult, SandboxCallError>
	/**
	 * Starts a shell command detached and returns once it runs. `env` reaches that process alone:
	 * its arguments are readable by the agent's account through `/proc/<pid>/cmdline`, while a
	 * root process's environment is not.
	 */
	readonly spawn: (
		command: string,
		env: Readonly<Record<string, string>>,
	) => Effect.Effect<void, SandboxCallError>
	/** Restores the last mirror backup into the seed path (`mirror-backup.ts`). Best effort. */
	readonly restoreMirror?: Effect.Effect<void>
	/** Asks for a fresh mirror backup if the last is stale; returns before it is written. */
	readonly backupMirror?: Effect.Effect<void>
}

/** A commit's checkout directory. */
export const checkoutDir = (sha: string): string => `${SANDBOX_WORKSPACE_ROOT}/${sha}`

/** Where a commit's background clone records its pid, exit code and stderr. */
export const cloneStateDir = (sha: string): string => `/var/lib/maple-clones/${sha}`

/** The variable the clone reads its token from. */
export const CLONE_TOKEN_ENV = "MAPLE_CLONE_TOKEN"

/** `timeout`'s grace between TERM and KILL for a command that outran its deadline. */
const KILL_AFTER_SECONDS = 5

/**
 * A shell command string as an argv. With a timeout, coreutils `timeout` signals the whole
 * process group, so nothing the command started outlives it.
 */
export const commandArgv = (command: string, timeoutMs?: number): ReadonlyArray<string> =>
	timeoutMs === undefined
		? ["bash", "-c", command]
		: [
				"timeout",
				`--kill-after=${KILL_AFTER_SECONDS}`,
				String(Math.max(1, Math.ceil(timeoutMs / 1000))),
				"bash",
				"-c",
				command,
			]

/** 124 after TERM, 137 after KILL; the deadline check keeps a command's own 124 its own. */
export const isTimedOut = (exitCode: number, durationMs: number, timeoutMs?: number): boolean =>
	timeoutMs !== undefined && (exitCode === 124 || exitCode === 137) && durationMs >= timeoutMs

const utf8 = new TextEncoder()

/**
 * A shell program that runs `command` as the unprivileged account, bounds each
 * output stream where it is produced, and — when the request asked for it —
 * inside a fresh network namespace.
 *
 * The namespace is probed in the same program rather than beforehand, so a
 * container that cannot provide one refuses the command instead of running it
 * with egress. Nothing here may `exec`: commands run sessionlessly, but the
 * trailer has to be printed after the command returns.
 */
export const wrapCommand = (
	request: Pick<SandboxExecRequest, "command" | "args" | "maxOutputBytes">,
): string => {
	const environment = Object.entries(SANDBOX_COMMAND_ENV)
		.map(([name, value]) => `${name}=${shellQuote(value)}`)
		.join(" ")
	// `runuser` first, then `env -i`: the command starts from an empty environment
	// and receives only the names the contract's allowlist covers. The other order
	// looks equivalent and is not — `runuser` adds `USER` and `LOGNAME` after
	// `env -i` has run, so the command would see five names while `admit` promised
	// three, and `runuser` itself would have to be found on the command's PATH.
	const dropped = `runuser -u ${SANDBOX_RUN_AS_USER} -- env -i ${environment} ${shellCommand(request.command, request.args)}`
	const limit = String(Math.max(1, Math.floor(request.maxOutputBytes)))
	// Streams land in files, are cut to the bound, and the real exit status rides
	// the trailer — piping through `head` directly would report `head`'s status.
	// The command runs only if its own network namespace could be opened, so one
	// that asked for no egress never runs with some.
	return [
		`o=$(mktemp) && e=$(mktemp)`,
		`if unshare -n true 2>/dev/null; then ns=isolated; else ns=unavailable; fi`,
		`rc=0`,
		`if [ "$ns" = isolated ]; then { unshare -n ${dropped}; } >"$o" 2>"$e"; rc=$?; fi`,
		`ob=$(wc -c <"$o") && eb=$(wc -c <"$e")`,
		`head -c ${limit} "$o"`,
		`head -c ${limit} "$e" >&2`,
		`rm -f "$o" "$e"`,
		`printf '\n${SANDBOX_TRAILER} %s %s %s %s\n' "$rc" "$ob" "$eb" "$ns"`,
	].join("\n")
}

interface Trailer {
	readonly exitCode: number
	readonly stdoutBytes: number
	readonly stderrBytes: number
	readonly isolation: "isolated" | "unavailable"
}

/**
 * Read the wrapper's trailer off the end of stdout.
 *
 * The last match wins, because a command is free to print the sentinel itself —
 * it can only mislead its own caller, which is the same agent.
 */
export const parseTrailer = (
	stdout: string,
): Option.Option<{ readonly body: string; readonly trailer: Trailer }> => {
	const at = stdout.lastIndexOf(SANDBOX_TRAILER)
	if (at === -1) return Option.none()
	const parts = stdout
		.slice(at + SANDBOX_TRAILER.length)
		.trim()
		.split(/\s+/)
	const [exitCode, stdoutBytes, stderrBytes] = parts.slice(0, 3).map(Number)
	const isolation = parts[3]
	if (
		parts.length < 4 ||
		exitCode === undefined ||
		stdoutBytes === undefined ||
		stderrBytes === undefined ||
		![exitCode, stdoutBytes, stderrBytes].every(Number.isFinite) ||
		(isolation !== "isolated" && isolation !== "unavailable")
	)
		return Option.none()
	// The wrapper prints a newline before the sentinel; drop exactly that one.
	const body = stdout.slice(0, at).replace(/\n$/, "")
	return Option.some({ body, trailer: { exitCode, stdoutBytes, stderrBytes, isolation } })
}

/**
 * The clone, as a single shell program run in the background.
 *
 * The container keeps one bare mirror of the repository, and every commit's checkout is a
 * `--shared` clone of it: the first commit pays the whole history, later ones fetch only what
 * the mirror lacks. A restored backup (`SANDBOX_SEED_DIR`) stands in for the first fetch.
 */
export const cloneScript = (checkout: SandboxCheckout): string => {
	const dir = checkoutDir(checkout.sha)
	const mirror = shellQuote(SANDBOX_MIRROR_DIR)
	// The token comes from this process's environment through a credential helper, never the URL
	// or an argument: arguments are readable by the account the agent's commands run as.
	const helper = `!f() { echo username=x-access-token; echo "password=$${CLONE_TOKEN_ENV}"; }; f`
	return [
		"set -e",
		// A seed move that fails midway leaves no temporary mirror behind.
		`trap 'rm -rf "\${m:-}"' EXIT`,
		// Nothing a fetch or clone writes may be writable by the agent's account.
		"umask 022",
		`id -u ${SANDBOX_RUN_AS_USER} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /tmp --shell /usr/sbin/nologin ${SANDBOX_RUN_AS_USER}`,
		// Commands run as an account that does not own the tree, which git refuses to read without this.
		`git config --system --replace-all safe.directory '*'`,
		`mkdir -p ${shellQuote(SANDBOX_WORKSPACE_ROOT)}`,
		// Two commits of one repository clone at once, and the backup snapshot reads the
		// mirror; one lock keeps each of them from seeing a fetch half-written.
		`exec 9>${shellQuote(SANDBOX_MIRROR_LOCK)}`,
		// Root's alone: the agent's account could otherwise hold it and stall every clone.
		`chmod 600 ${shellQuote(SANDBOX_MIRROR_LOCK)}`,
		"flock 9",
		`if [ ! -d ${mirror}/objects ]; then`,
		`  m=$(mktemp -d ${shellQuote(`${SANDBOX_MIRROR_DIR}.XXXXXX`)})`,
		// A restored seed is ordinary files on the same disk, so it moves into place rather than copies.
		`  if [ -d ${shellQuote(SANDBOX_SEED_DIR)}/objects ]; then rmdir "$m" && mv -T ${shellQuote(SANDBOX_SEED_DIR)} "$m"; else git init --quiet --bare "$m"; fi`,
		// Checkouts borrow the mirror's objects, so nothing may ever prune them.
		`  git -C "$m" config gc.auto 0`,
		`  mv -T "$m" ${mirror}`,
		"  m=",
		"fi",
		// Every branch keeps `origin/*` in the checkout what a full clone gave, and the
		// commit is pinned under its own ref so a force-pushed branch cannot orphan it.
		`git -C ${mirror} -c ${shellQuote(`credential.helper=${helper}`)} fetch --quiet --no-tags ${shellQuote(checkout.remoteUrl)} '+refs/heads/*:refs/heads/*' ${shellQuote(`+${checkout.sha}:refs/maple/${checkout.sha}`)}`,
		`unset ${CLONE_TOKEN_ENV}`,
		`chmod -R a+rX,go-w ${mirror}`,
		// Named after this script's PID, so eviction can tell a live clone's directory from a leftover.
		`t=$(mktemp -d ${shellQuote(`${SANDBOX_WORKSPACE_ROOT}/.clone-`)}"$$"-XXXXXX)`,
		`git clone --quiet --shared --no-checkout ${mirror} "$t"`,
		"exec 9>&-",
		`git -C "$t" remote set-url origin ${shellQuote(checkout.remoteUrl)}`,
		// A committed symlink is checked out as a file holding its target, so no command the agent
		// runs can follow one out of the checkout; the index still records mode 120000.
		`git -C "$t" config core.symlinks false`,
		`git -C "$t" checkout --quiet --detach ${shellQuote(checkout.sha)}`,
		// Readable and traversable by the agent account, writable by nobody but root.
		// `mktemp -d` creates the directory mode 700, so read and execute have to be
		// added back — removing write alone would leave a tree nothing else can enter.
		`chmod -R a+rX,go-w "$t"`,
		// `-T` refuses to nest inside an existing directory, so a checkout another
		// caller finished first stands and this one's copy is discarded.
		`mv -T "$t" ${shellQuote(dir)} 2>/dev/null || rm -rf "$t"`,
		// Keep the most recently used commits and drop the rest; a container's disk is small and
		// every distinct commit leaves one behind. Nothing used within the grace period goes, nor
		// another clone's scratch directory: concurrent reviews each hold a commit, and evicting by
		// count alone deleted checkouts and clones still in use.
		`ls -1dt ${shellQuote(SANDBOX_WORKSPACE_ROOT)}/*/ 2>/dev/null | tail -n +${SANDBOX_MAX_CHECKOUTS + 1} | while read -r old; do if [ -n "$(find "$old" -maxdepth 0 -mmin +${SANDBOX_CHECKOUT_GRACE_MINUTES})" ]; then chmod -R u+w "$old" && rm -rf "$old"; fi; done`,
		// Scratch directories a failed clone left behind: only those whose clone is no longer running.
		`for old in ${shellQuote(SANDBOX_WORKSPACE_ROOT)}/.clone-*/; do [ -d "$old" ] || continue; pid=$(basename "$old" | cut -d- -f2); if ! kill -0 "$pid" 2>/dev/null; then chmod -R u+w "$old" && rm -rf "$old"; fi; done`,
		"true",
	].join("\n")
}

/**
 * A point-in-time copy of the mirror for a backup to archive.
 *
 * Hard links, taken under the mirror lock: git never rewrites an object or pack in place and
 * replaces refs by rename, so the copy stays exactly what the mirror was when the lock was held,
 * while the next fetch carries on. Then repacked into one pack. Exits 3 when there is no mirror.
 */
export const snapshotScript = (): string =>
	[
		"set -e",
		`test -d ${shellQuote(SANDBOX_MIRROR_DIR)}/objects || exit 3`,
		`rm -rf ${shellQuote(SANDBOX_SNAPSHOT_DIR)}`,
		`flock ${shellQuote(SANDBOX_MIRROR_LOCK)} cp -al ${shellQuote(SANDBOX_MIRROR_DIR)} ${shellQuote(SANDBOX_SNAPSHOT_DIR)}`,
		// One pack per fetch would otherwise ride every archive into the next container and grow
		// forever. Repacking the copy unlinks only the copy's names, so the live mirror is untouched
		// and no lock is held while it runs.
		`git -C ${shellQuote(SANDBOX_SNAPSHOT_DIR)} repack -a -d -q`,
	].join("\n")

/**
 * Reports where a commit's checkout stands, as its first line, and claims the clone when nobody
 * has: `ready`, `cloning`, `claimed`, `failed <code>` (its stderr follows) or `lost`.
 *
 * Failed and lost clones are forgotten as they are reported, so the next call clones again. A
 * clone that finished but whose checkout was since pruned is cloned again too. `mkdir` without
 * `-p` is the claim: it fails when another caller got there first.
 */
export const checkoutStatusScript = (sha: string): string => {
	const dir = shellQuote(checkoutDir(sha))
	const state = cloneStateDir(sha)
	const s = shellQuote(state)
	return [
		// Touched on every use: eviction goes by modification time, so this keeps a commit in use.
		`if [ -d ${dir}/.git ]; then touch -c ${dir} || true; rm -rf ${s}; echo ready; exit 0; fi`,
		`if [ -e ${s}/exit-code ]; then`,
		`  code=$(cat ${s}/exit-code)`,
		`  if [ "$code" != 0 ]; then echo "failed $code"; tail -c 2000 ${s}/stderr.log 2>/dev/null; rm -rf ${s}; exit 0; fi`,
		`  rm -rf ${s}`,
		`elif [ -e ${s}/pid ]; then`,
		`  if kill -0 "$(cat ${s}/pid)" 2>/dev/null || [ -e ${s}/exit-code ]; then echo cloning; exit 0; fi`,
		`  echo lost; rm -rf ${s}; exit 0`,
		// Claimed but never started: the Durable Object went away in between. Give it two minutes.
		`elif [ -d ${s} ]; then`,
		`  if [ -z "$(find ${s} -maxdepth 0 -mmin +2)" ]; then echo cloning; exit 0; fi`,
		`  rm -rf ${s}`,
		"fi",
		`mkdir -p ${shellQuote(state.slice(0, state.lastIndexOf("/")))}`,
		`if mkdir ${s} 2>/dev/null; then echo claimed; else echo cloning; fi`,
	].join("\n")
}

/** The background clone: {@link cloneScript} under a runner that records how it went. */
export const cloneRunner = (checkout: SandboxCheckout): string => {
	const s = shellQuote(cloneStateDir(checkout.sha))
	return [
		`echo $$ >${s}/pid`,
		`(\n${cloneScript(checkout)}\n) >/dev/null 2>${s}/stderr.log`,
		`echo $? >${s}/exit-code.tmp && mv ${s}/exit-code.tmp ${s}/exit-code`,
	].join("\n")
}

/**
 * Make sure the commit is checked out, starting the clone if nobody has.
 *
 * `Option.none` means ready. Anything else is the answer the caller should
 * return as-is: still preparing, or a clone that failed.
 */
export const ensureCheckout = (
	container: SandboxContainer,
	checkout: SandboxCheckout,
): Effect.Effect<Option.Option<SandboxRunCheckoutPending | SandboxRunCheckoutFailed>, SandboxCallError> =>
	Effect.gen(function* () {
		const redact = (text: string) => boundMessage(redactSecret(text, checkout.token))
		const status = yield* container.exec(checkoutStatusScript(checkout.sha))
		const [state = "", ...detail] = status.stdout.split("\n")
		const [name, code] = state.trim().split(" ")
		if (name === "ready") {
			// Every ready checkout asks; the Durable Object answers from memory unless a day has passed.
			if (container.backupMirror) yield* container.backupMirror
			return Option.none()
		}
		if (name === "claimed") {
			// Before the clone, which moves a restored seed into place instead of fetching everything.
			if (container.restoreMirror) yield* container.restoreMirror
			yield* container.spawn(cloneRunner(checkout), { [CLONE_TOKEN_ENV]: checkout.token }).pipe(
				// A claim with no clone behind it would read as cloning for two minutes.
				Effect.tapError(() =>
					container.exec(`rm -rf ${shellQuote(cloneStateDir(checkout.sha))}`).pipe(Effect.ignore),
				),
			)
			return Option.some(
				new SandboxRunCheckoutPending({
					message: `Preparing a checkout of ${checkout.repository} at ${checkout.sha}. Call again in a few seconds.`,
				}),
			)
		}
		if (name === "failed" || name === "lost")
			return Option.some(
				new SandboxRunCheckoutFailed({
					message: redact(
						name === "lost"
							? `Cloning ${checkout.repository} stopped before it finished. Call again to retry.`
							: `Cloning ${checkout.repository} failed (exit ${code}): ${detail.join("\n").trim().slice(0, 500)}`,
					),
				}),
			)
		return Option.some(
			new SandboxRunCheckoutPending({
				message: `The checkout of ${checkout.repository} at ${checkout.sha} is still being prepared. Call again in a few seconds.`,
			}),
		)
	})

/** Run one request end to end: prepare the commit if needed, then the command. */
export const runExec = (
	container: SandboxContainer,
	request: SandboxExecRequest,
): Effect.Effect<SandboxExecResponse, SandboxCallError> =>
	Effect.gen(function* () {
		const notReady = yield* ensureCheckout(container, request.checkout)
		if (Option.isSome(notReady)) return notReady.value
		const dir = checkoutDir(request.checkout.sha)
		const cwd = request.cwd === "." || request.cwd === "" ? dir : `${dir}/${request.cwd}`
		const result = yield* container.exec(wrapCommand(request), { cwd, timeout: request.timeoutMs })
		if (result.timedOut) return new SandboxRunTimedOut({ wallTimeMs: request.timeoutMs })
		const parsed = parseTrailer(result.stdout)
		if (Option.isNone(parsed)) {
			// No trailer means the wrapper itself never finished — the shell died, or
			// the container answered something else entirely.
			return new SandboxRunCheckoutFailed({
				message: boundMessage(
					redactSecret(
						`The sandbox did not run the command: ${result.stderr.trim().slice(0, 500) || "no output"}`,
						request.checkout.token,
					),
				),
			})
		}
		const { body, trailer } = parsed.value
		if (trailer.isolation === "unavailable")
			return new SandboxRunIsolationUnavailable({
				message:
					"this container cannot open a network namespace, so a command requiring no egress was refused",
			})
		const stderr = result.stderr
		return new SandboxRunExited({
			exitCode: trailer.exitCode,
			stdout: body,
			stderr,
			stdoutBytes: trailer.stdoutBytes,
			stderrBytes: trailer.stderrBytes,
			stdoutTruncated: trailer.stdoutBytes > utf8.encode(body).length,
			stderrTruncated: trailer.stderrBytes > utf8.encode(stderr).length,
			wallTimeMs: result.duration,
		})
	})

/**
 * {@link runExec}, with every failure turned into an answer. The container puts the failing
 * command line into its own error messages, so this is one of the paths the clone token can
 * reach: everything leaving here is redacted.
 */
export const execute = (
	container: SandboxContainer,
	request: SandboxExecRequest,
): Effect.Effect<SandboxExecResponse> => {
	const redact = (text: string) => boundMessage(redactSecret(text, request.checkout.token))
	return runExec(container, request).pipe(
		// A container that never came up is the caller's to report.
		Effect.catchTag("@maple/sandbox/SandboxCallError", (error) =>
			Effect.logWarning("sandbox container call failed").pipe(
				Effect.annotateLogs({ "maple.sandbox.key": request.sandboxKey }),
				Effect.as(new SandboxRunUnavailable({ message: redact(error.message) })),
			),
		),
		// Anything left is a bug in this Worker; say what broke, redacted.
		Effect.catchCause((cause) =>
			Effect.logError("sandbox worker failed", cause).pipe(
				Effect.annotateLogs({ "maple.sandbox.key": request.sandboxKey }),
				Effect.as(
					new SandboxRunUnavailable({
						message: redact(`the sandbox worker failed: ${Cause.pretty(cause)}`),
					}),
				),
			),
		),
	)
}
