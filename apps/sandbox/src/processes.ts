/**
 * The argument vectors the sandbox Durable Object hands `container.exec()`.
 *
 * Sandbox SDK 1.0 has no command timeout and no process table, so both are rebuilt here from
 * coreutils `timeout` and a directory per process. Kept apart from `worker.ts`, which needs a
 * Workers runtime, so the unit tests and `verify:image` run exactly these vectors.
 */
import { shellQuote } from "@maple/domain/sandbox"
import type { SandboxProcess } from "./checkout"

/** `timeout`'s grace between TERM and KILL for a command that outran its deadline. */
const KILL_AFTER_SECONDS = 5

/** One directory per background process: its pid, exit code and logs outlive any request. */
export const PROCESS_ROOT = "/var/lib/maple-processes"

/** How much of a background process's log a status check reads back. */
const PROCESS_LOG_BYTES = 64 * 1024

/** Process ids become directory names. */
export const isSafeProcessId = (id: string): boolean => /^[A-Za-z0-9._-]{1,128}$/.test(id)

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

// Cloudflare's background-process recipe: the command runs in its own process group, recording
// its pid on start and its exit code on exit, so a later request can tell where it got to.
const RUN = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

const STATUS = `current() {
	read -r pid boot 2>/dev/null <"$1/pid" &&
		[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ]
}
dir=$1
if [ ! -d "$dir" ]; then echo missing
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif [ ! -e "$dir/pid" ]; then echo starting
elif current "$dir" && kill -0 "$pid" 2>/dev/null; then echo running
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
else echo lost
fi`

export const processDir = (id: string): string => `${PROCESS_ROOT}/${id}`

/** Claims the id: `mkdir` without `-p` fails when it is taken, so two callers cannot both start it. */
export const claimProcessArgv = (id: string): ReadonlyArray<string> => [
	"sh",
	"-c",
	`mkdir -p ${shellQuote(PROCESS_ROOT)} && mkdir ${shellQuote(processDir(id))}`,
]

/** Runs `command` in the background under the claimed directory. Exec it with output ignored. */
export const startProcessArgv = (id: string, command: string): ReadonlyArray<string> => [
	"sh",
	"-c",
	RUN,
	"sh",
	processDir(id),
	"bash",
	"-c",
	command,
]

export const processStatusArgv = (id: string): ReadonlyArray<string> => [
	"sh",
	"-c",
	STATUS,
	"sh",
	processDir(id),
]

export const processLogArgv = (id: string, stream: "stdout" | "stderr"): ReadonlyArray<string> => [
	"sh",
	"-c",
	`tail -c ${PROCESS_LOG_BYTES} ${shellQuote(`${processDir(id)}/${stream}.log`)} 2>/dev/null`,
]

/** What {@link processStatusArgv} printed, as the port's process. `null` for an unused id. */
export const parseProcessStatus = (id: string, stdout: string): SandboxProcess | null => {
	const [name, value] = stdout.trim().split(" ")
	const code = Number(value)
	const exitCode = Number.isFinite(code) ? code : undefined
	if (name === "starting" || name === "running") return { id, status: name }
	if (name === "exited") return { id, status: code === 0 ? "completed" : "failed", exitCode }
	// Ended without recording an exit code: the container restarted under it.
	if (name === "lost") return { id, status: "error" }
	return null
}
