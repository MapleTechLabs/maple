/**
 * What the execution sandbox runs in its container, as shell programs. Pure, so tests run them
 * against real git (`executor-scripts.test.ts`) and in the deployed image (`verify:executor`).
 *
 * Prepare (root, in the container's own network, where only the registry gateway answers) fetches
 * the commit and installs each lockfile with install scripts off, as an unprivileged uid under
 * limits, then makes the checkout read-only. Run puts one agent command in a fresh network, mount
 * and pid namespace holding only loopback, as that agent's own uid with no capabilities, inside a
 * cgroup and `prlimit` bounds, with only its tmpfs scratch writable. Promote copies allowlisted
 * scratch files out after every process of the command is gone.
 */
import {
	EXECUTOR_LIMITS,
	type ExecutorPromotion,
	type ExecutorWorkingDirectory,
} from "@maple/domain/executor"
import { shellQuote } from "@maple/domain/sandbox"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { GATEWAY_HOST } from "./executor-probe"

export const CHECKOUT_DIR = "/work/checkout"
const CACHE_DIR = "/work/cache"
export const PREPARE_STATE_DIR = "/work/prepare"
const AUDIT_DIR = "/audit"
const CGROUP = "/sys/fs/cgroup"
/** Installed by the image; the skill's promotion procedure, run as root. */
export const PROMOTE_HELPER = "/usr/local/lib/maple/promote.py"

/**
 * Every agent's cgroup sits under this one, whose `memory.max` holds all of them, scratch included,
 * below the container (standard-2: 6 GB): when agents together run out, the kernel kills a command
 * (each agent cgroup is one OOM group), not the container and the run's prepared checkout with it.
 */
const AGENTS_CGROUP = "maple-agents"
const AGENTS_MEMORY_BYTES = 4608 * 1024 * 1024
const agentCgroup = (agentId: string) => `${AGENTS_CGROUP}/maple-agent-${agentId}`

/** The uid prepare installs dependencies as. Agents get their own uids from {@link AGENT_UID_BASE}. */
const PREPARE_UID = 20000
const AGENT_UID_BASE = 30000

/** The whole prepare's deadline: a fetch and every install. */
export const PREPARE_TIMEOUT_SECONDS = 20 * 60
/** At most this many lockfiles are installed, shallowest first. */
export const MAX_INSTALLS = 8

/** Printed last by {@link runScript}: started-or-not, exit code and each stream's full size. */
export const RUN_TRAILER = "__maple_executor_trailer__"

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const GATEWAY = `http://${GATEWAY_HOST}`
export const GATEWAY_GIT = `${GATEWAY}/git`
export const GATEWAY_NPM = `${GATEWAY}/npm/`

/** Drops to `uid` for good: no groups, no capabilities, and no way to regain either. */
const dropTo = (uid: string) =>
	`setpriv --reuid=${uid} --regid=${uid} --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs --`

/**
 * cgroup v2 hands controllers to children only while a cgroup holds no processes, so every process
 * moves to a leaf first. Done once per container; the marker makes later calls skip it.
 */
const CGROUP_READY = "/run/maple-cgroup-ready"
const CGROUP_SETUP = Arr.join(
	[
		`if [ ! -e ${CGROUP_READY} ]; then`,
		`  mkdir -p ${CGROUP}/maple-init || exit 3`,
		`  for _ in 1 2 3; do for p in $(cat ${CGROUP}/cgroup.procs); do echo "$p" > ${CGROUP}/maple-init/cgroup.procs 2>/dev/null; done; done`,
		`  echo "+memory +pids" > ${CGROUP}/cgroup.subtree_control || exit 3`,
		`  mkdir -p /run && : > ${CGROUP_READY}`,
		"fi",
	],
	"\n",
)

const cgroup = (name: string, limits: ReadonlyArray<readonly [string, string]>) =>
	Arr.join(
		[
			`mkdir -p ${CGROUP}/${name} || exit 3`,
			...Arr.map(limits, ([file, value]) => `echo ${value} > ${CGROUP}/${name}/${file} || exit 3`),
		],
		"\n",
	)

/**
 * Every world-writable directory outside the run's own trees (`/run/lock` in today's image, besides
 * `/tmp` and `/var/tmp`), found once per container so a directory the platform adds is covered
 * too. Written whole or not at all, so an interrupted scan is redone rather than trusted.
 */
const SHARED_WRITABLE = "/run/maple-shared-writable"
const FIND_SHARED_WRITABLE = `[ -e ${SHARED_WRITABLE} ] || { find / \\( -path /proc -o -path /sys -o -path /dev -o -path /work -o -path /audit \\) -prune -o -type d -perm -0002 -print 2>/dev/null > ${SHARED_WRITABLE}.tmp && mv ${SHARED_WRITABLE}.tmp ${SHARED_WRITABLE}; } || exit 3`
/** What a jailed process sees in place of each shared writable directory. */
const SHARED_DIRS = `/tmp /var/tmp /dev/shm $(cat ${SHARED_WRITABLE})`

/** Kills every process left in a cgroup and waits until none is. */
const reap = (name: string) =>
	`echo 1 > ${CGROUP}/${name}/cgroup.kill 2>/dev/null; for _ in $(seq 100); do [ -z "$(cat ${CGROUP}/${name}/cgroup.procs 2>/dev/null)" ] && break; sleep 0.1; done`

const drained = (name: string) => `[ -z "$(cat ${CGROUP}/${name}/cgroup.procs 2>/dev/null)" ]`

/**
 * One line per lockfile directory, `depth<TAB>dir<TAB>manager`, from `git ls-files` output. A
 * directory with several lockfiles installs with the first of bun, pnpm, npm, yarn; anything under
 * `node_modules` is vendored and skipped.
 */
const LOCKFILE_PLAN_AWK = `!/(^|\\/)node_modules\\// {
  n = split($0, part, "/"); f = part[n]
  d = n == 1 ? "." : substr($0, 1, length($0) - length(f) - 1)
  r = (f == "bun.lock" || f == "bun.lockb") ? 1 : f == "pnpm-lock.yaml" ? 2 : f == "yarn.lock" ? 4 : 3
  if (!(d in best) || r < best[d]) best[d] = r
}
END {
  for (d in best) {
    depth = d == "." ? 0 : gsub("/", "/", d) + 1
    print depth "\\t" d "\\t" (best[d] == 1 ? "bun" : best[d] == 2 ? "pnpm" : best[d] == 3 ? "npm" : "yarn")
  }
}`

const LOCKFILES = Arr.map(
	["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock"],
	(name) => shellQuote(`:(glob)**/${name}`),
)

/** Prints `dir<TAB>manager` for each lockfile directory to install, shallowest first. */
export const lockfilePlanScript = (): string =>
	`git ls-files -- ${Arr.join(LOCKFILES, " ")} | awk ${shellQuote(LOCKFILE_PLAN_AWK)} | sort -n -k1,1 -k2,2 | head -n ${MAX_INSTALLS} | cut -f2-`

/** Each install as one line in `installs`: dir, manager, outcome, the end of its log. */
const INSTALL_LINE = `printf '%s\\t%s\\t%s\\t%s\\n' "$dir" "$manager" "$outcome" "$(tail -c 400 "$log" 2>/dev/null | tr '\\t\\n' '  ')" >> ${PREPARE_STATE_DIR}/installs`

/**
 * The prepare program. Runs as root in the background; every command that reads target-controlled
 * input (git, the package managers) runs as {@link PREPARE_UID} without capabilities, in a cgroup,
 * under `prlimit`, with install scripts off and only the gateway reachable.
 */
export const prepareScript = (sha: string): string => {
	const environment = Arr.join(
		[
			`PATH=${PATH}`,
			`HOME=${CACHE_DIR}/home`,
			"LANG=C.UTF-8",
			"CI=1",
			"GIT_TERMINAL_PROMPT=0",
			`npm_config_cache=${CACHE_DIR}/npm`,
			"npm_config_update_notifier=false",
			`BUN_INSTALL_CACHE_DIR=${CACHE_DIR}/bun`,
			`NPM_CONFIG_REGISTRY=${GATEWAY_NPM}`,
			`BUN_CONFIG_REGISTRY=${GATEWAY_NPM}`,
		],
		" ",
	)
	// Each command that reads target-controlled input: in the prepare cgroup, its own pid and mount
	// namespaces (private temporary directories; nothing it starts outlives it), then unprivileged.
	const jail = `${CGROUP}/maple-prepare/cgroup.procs`
	const inner = `for d in ${SHARED_DIRS}; do mount -t tmpfs -o size=1g,mode=1777 tmpfs "$d" || exit 1; done; exec "$@"`
	const asPrepare = `sh -c 'echo $$ > ${jail} && exec "$@"' sh unshare --mount --pid --fork --kill-child --mount-proc -- sh -c ${shellQuote(inner)} sh prlimit --fsize=${2 * 1024 * 1024 * 1024} --nofile=8192 --core=0 -- ${dropTo(String(PREPARE_UID))} env -i ${environment}`
	const registry = shellQuote(GATEWAY_NPM)
	return Arr.join(
		[
			"set -u",
			"umask 022",
			CGROUP_SETUP,
			FIND_SHARED_WRITABLE,
			cgroup("maple-prepare", [
				["memory.max", String(4 * 1024 * 1024 * 1024)],
				["pids.max", "1024"],
			]),
			`mkdir -p ${CHECKOUT_DIR} ${CACHE_DIR}/home || exit 4`,
			`chown ${PREPARE_UID}:${PREPARE_UID} ${CHECKOUT_DIR} ${CACHE_DIR} ${CACHE_DIR}/home || exit 4`,
			`cd ${CHECKOUT_DIR} || exit 4`,
			`${asPrepare} git init -q . || exit 10`,
			// The gateway adds the repository's credential; the container never holds it.
			`${asPrepare} git -c protocol.version=2 fetch -q --depth=1 --no-tags ${shellQuote(GATEWAY_GIT)} ${shellQuote(sha)} || exit 11`,
			`${asPrepare} git -c advice.detachedHead=false checkout -q --detach FETCH_HEAD || exit 12`,
			`: > ${PREPARE_STATE_DIR}/installs`,
			`${asPrepare} sh -c ${shellQuote(lockfilePlanScript())} > ${PREPARE_STATE_DIR}/plan || exit 13`,
			`while IFS="$(printf '\\t')" read -r dir manager; do`,
			`  log=${PREPARE_STATE_DIR}/install.log; : > "$log"; outcome=failed`,
			'  case "$manager" in',
			`    npm) (cd "$dir" && ${asPrepare} npm ci --ignore-scripts --no-audit --no-fund --registry=${registry}) >"$log" 2>&1 && outcome=installed ;;`,
			`    pnpm) (cd "$dir" && ${asPrepare} pnpm install --frozen-lockfile --ignore-scripts --registry=${registry} --ignore-pnpmfile --store-dir=${CACHE_DIR}/pnpm --config.manage-package-manager-versions=false) >"$log" 2>&1 && outcome=installed ;;`,
			`    bun) (cd "$dir" && ${asPrepare} bun install --frozen-lockfile --ignore-scripts) >"$log" 2>&1 && outcome=installed ;;`,
			'    *) echo "yarn lockfiles are not installed yet" >"$log"; outcome=skipped ;;',
			"  esac",
			`  ${INSTALL_LINE}`,
			`done < ${PREPARE_STATE_DIR}/plan`,
			// From here on nothing the target controls may change the checkout or what it installed.
			reap("maple-prepare"),
			`${drained("maple-prepare")} || exit 15`,
			`chown -R 0:0 ${CHECKOUT_DIR} && chmod -R a+rX,go-w ${CHECKOUT_DIR} || exit 14`,
			`rm -rf ${CACHE_DIR}`,
			`echo ${shellQuote(sha)} > ${PREPARE_STATE_DIR}/sha`,
		],
		"\n",
	)
}

/** The background prepare: {@link prepareScript} under a runner that records how it went. */
export const prepareRunner = (sha: string): string => {
	const s = PREPARE_STATE_DIR
	return Arr.join(
		[
			"umask 022",
			`echo $$ > ${s}/pid`,
			`timeout --kill-after=10 ${PREPARE_TIMEOUT_SECONDS} bash -c ${shellQuote(prepareScript(sha))} > ${s}/log 2>&1`,
			`echo $? > ${s}/exit-code.tmp && mv ${s}/exit-code.tmp ${s}/exit-code`,
		],
		"\n",
	)
}

/**
 * Where prepare stands: `ready <sha>`, `running`, `failed <code>` (then the log's end), `lost`
 * (it stopped without an exit code, or was claimed and never started) or `claimed` (nothing ran
 * yet; the caller starts it). The caller resets a failed or lost prepare, so the next call claims.
 */
export const prepareStatusScript = (): string => {
	const s = PREPARE_STATE_DIR
	return Arr.join(
		[
			"umask 022",
			`if [ -e ${s}/exit-code ]; then`,
			`  code=$(cat ${s}/exit-code)`,
			`  if [ "$code" = 0 ]; then echo "ready $(cat ${s}/sha)"; cat ${s}/installs; exit 0; fi`,
			`  echo "failed $code"; tail -c 1500 ${s}/log 2>/dev/null; exit 0`,
			"fi",
			`if [ -e ${s}/pid ]; then`,
			`  if kill -0 "$(cat ${s}/pid)" 2>/dev/null; then echo running; else echo lost; fi`,
			"  exit 0",
			"fi",
			// Claimed but never started: the Durable Object went away in between. Give it two minutes.
			`if [ -d ${s} ]; then`,
			`  if [ -z "$(find ${s} -maxdepth 0 -mmin +2)" ]; then echo running; else echo lost; fi`,
			"  exit 0",
			"fi",
			`if mkdir -p /work && mkdir ${s} 2>/dev/null; then echo claimed; else echo running; fi`,
		],
		"\n",
	)
}

const InstallLine = Schema.Struct({
	dir: Schema.String,
	manager: Schema.Literals(["npm", "pnpm", "bun", "yarn"]),
	outcome: Schema.Literals(["installed", "failed", "skipped"]),
	detail: Schema.String,
})
const decodeInstallLine = Schema.decodeUnknownOption(InstallLine)

export type PrepareStatus =
	| {
			readonly _tag: "ready"
			readonly sha: string
			readonly installs: ReadonlyArray<typeof InstallLine.Type>
	  }
	| { readonly _tag: "running" }
	| { readonly _tag: "failed"; readonly code: string; readonly log: string }
	| { readonly _tag: "lost" }
	| { readonly _tag: "claimed" }

export const parsePrepareStatus = (stdout: string): PrepareStatus => {
	const [head, ...rest] = Str.split("\n")(stdout)
	const [state, value = ""] = Str.split(" ")(Str.trim(head))
	switch (state) {
		case "ready":
			return {
				_tag: "ready",
				sha: value,
				installs: Arr.flatMap(rest, (line) => {
					const [dir, manager, outcome, detail = ""] = Str.split("\t")(line)
					const decoded = decodeInstallLine({ dir, manager, outcome, detail: Str.trim(detail) })
					return decoded._tag === "Some" ? [decoded.value] : []
				}),
			}
		case "failed":
			return { _tag: "failed", code: value, log: Str.trim(Arr.join(rest, "\n")) }
		case "lost":
		case "claimed":
		case "running":
			return { _tag: state }
		default:
			return { _tag: "failed", code: "status", log: Str.slice(0, 1500)(Str.trim(stdout)) }
	}
}

/** Clears a lost prepare so the next status call claims it again. */
export const resetPrepareScript = (): string => `rm -rf ${PREPARE_STATE_DIR} ${CHECKOUT_DIR} ${CACHE_DIR}`

const agentDir = (agentId: string) => `${AUDIT_DIR}/agents/${agentId}`
/** Written when an agent is released; its commands are refused from then on. */
const releasedMarker = (agentId: string) => `${AUDIT_DIR}/released/${agentId}`
export const agentScratch = (agentId: string) => `${agentDir(agentId)}/scratch`
const agentArtifacts = (agentId: string) => `${agentDir(agentId)}/artifacts`

export interface RunScriptInput {
	readonly agentId: string
	readonly callId: string
	readonly command: string
	readonly cwd: ExecutorWorkingDirectory
	readonly timeoutMs: number
}

/**
 * One agent command. The agent's uid, scratch and cgroup are set up on its first call. The command
 * runs in new network, mount and pid namespaces: only loopback, `/tmp`, `/var/tmp` and `/dev/shm`
 * bound to its scratch, the checkout bound read-only, and its own `/proc`. When it returns, its
 * cgroup is killed so no process outlives it, which promotion relies on.
 */
export const runScript = (input: RunScriptInput): string => {
	const a = agentDir(input.agentId)
	const scratch = agentScratch(input.agentId)
	const name = agentCgroup(input.agentId)
	const g = `${CGROUP}/${name}`
	const c = `${AUDIT_DIR}/calls/${input.callId}`
	const limit = EXECUTOR_LIMITS.outputBytes
	const environment = Arr.join(
		[
			`PATH=${PATH}`,
			`HOME=${scratch}/.home`,
			"TMPDIR=/tmp",
			"LANG=C.UTF-8",
			"CI=1",
			`XDG_CACHE_HOME=${scratch}/.cache`,
			`npm_config_cache=${scratch}/.cache/npm`,
			"npm_config_update_notifier=false",
			"GIT_CONFIG_GLOBAL=/dev/null",
		],
		" ",
	)
	const cwd = input.cwd === "checkout" ? CHECKOUT_DIR : scratch
	const inner = Arr.join(
		[
			"ip link set lo up || exit 1",
			`for d in ${SHARED_DIRS}; do mount --bind ${scratch}/.tmp "$d" || exit 1; done`,
			`mount --bind ${CHECKOUT_DIR} ${CHECKOUT_DIR} && mount -o remount,bind,ro ${CHECKOUT_DIR} || exit 1`,
			`cd ${cwd} || exit 1`,
			`: > ${c}/started`,
			`exec prlimit --fsize=${EXECUTOR_LIMITS.fileSizeBytes} --nofile=${EXECUTOR_LIMITS.openFiles} --nproc=${EXECUTOR_LIMITS.processes} --core=0 -- ${dropTo('"$1"')} env -i ${environment} bash -c ${shellQuote(input.command)}`,
		],
		"\n",
	)
	const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000))
	return Arr.join(
		[
			"set -u",
			"umask 022",
			`if [ "$(cat ${PREPARE_STATE_DIR}/exit-code 2>/dev/null)" != 0 ]; then printf '\\n${RUN_TRAILER} not-prepared 0 0 0\\n'; exit 0; fi`,
			`mkdir -p ${AUDIT_DIR}/agents ${AUDIT_DIR}/calls && chmod 711 ${AUDIT_DIR} ${AUDIT_DIR}/agents && chmod 700 ${AUDIT_DIR}/calls || exit 2`,
			// The agent's uid is its position in creation order, claimed under a lock. Release takes the
			// same lock, so an agent is either set up before it is released or refused after.
			`exec 9> ${AUDIT_DIR}/agents.lock && flock 9 || exit 2`,
			`if [ -e ${releasedMarker(input.agentId)} ]; then printf '\\n${RUN_TRAILER} released 0 0 0\\n'; exit 0; fi`,
			// A counter, never a count of directories: a uid is never handed out twice.
			`if [ ! -s ${a}/uid ]; then`,
			`  mkdir -p -m 711 ${a} || exit 2`,
			`  n=$(( $(cat ${AUDIT_DIR}/next-uid 2>/dev/null || echo ${AGENT_UID_BASE}) + 1 )) && echo "$n" > ${AUDIT_DIR}/next-uid && echo "$n" > ${a}/uid || exit 2`,
			"fi",
			`u=$(cat ${a}/uid)`,
			`if ! mountpoint -q ${scratch}; then`,
			`  mkdir -p -m 700 ${scratch} ${agentArtifacts(input.agentId)} || exit 2`,
			`  mount -t tmpfs -o size=${EXECUTOR_LIMITS.scratchBytes},mode=0700,uid=$u,gid=$u tmpfs ${scratch} || exit 2`,
			`  install -d -m 700 -o "$u" -g "$u" ${scratch}/.home ${scratch}/.tmp ${scratch}/.cache || exit 2`,
			"fi",
			FIND_SHARED_WRITABLE,
			CGROUP_SETUP,
			cgroup(AGENTS_CGROUP, [
				["cgroup.subtree_control", `"+memory +pids"`],
				["memory.max", String(AGENTS_MEMORY_BYTES)],
			]),
			cgroup(name, [
				["memory.max", String(EXECUTOR_LIMITS.memoryBytes)],
				["memory.oom.group", "1"],
				["pids.max", String(EXECUTOR_LIMITS.processes)],
			]),
			"flock -u 9; exec 9>&-",
			`mkdir -m 700 ${c} || exit 2`,
			`(echo $BASHPID > ${g}/cgroup.procs && exec timeout --kill-after=5 ${seconds} unshare --net --mount --pid --ipc --uts --fork --kill-child --mount-proc -- sh -c ${shellQuote(inner)} sh "$u") > ${c}/out 2> ${c}/err < /dev/null`,
			"rc=$?",
			// Nothing the command started may outlive it: promotion reads scratch only after this.
			reap(name),
			`if [ ! -e ${c}/started ]; then state=setup-failed; elif ${drained(name)}; then state=started; else state=unreaped; fi`,
			`ob=$(wc -c < ${c}/out) && eb=$(wc -c < ${c}/err)`,
			`head -c ${limit} ${c}/out`,
			`head -c ${limit} ${c}/err >&2`,
			`rm -rf ${c}`,
			`printf '\\n${RUN_TRAILER} %s %s %s %s\\n' "$state" "$rc" "$ob" "$eb"`,
		],
		"\n",
	)
}

/**
 * Gives back what an agent held once its invocation ended: kills what is left of its commands, then
 * unmounts its scratch (tmpfs pages stay charged until then), removes its cgroup and deletes its
 * promoted artifacts, which the parent already holds. The marker refuses any later command.
 */
export const releaseScript = (agentId: string): string => {
	const name = agentCgroup(agentId)
	const scratch = agentScratch(agentId)
	return Arr.join(
		[
			"set -u",
			`mkdir -p ${AUDIT_DIR}/released && chmod 700 ${AUDIT_DIR}/released || exit 2`,
			`exec 9> ${AUDIT_DIR}/agents.lock && flock 9 || exit 2`,
			`: > ${releasedMarker(agentId)} || exit 2`,
			"flock -u 9; exec 9>&-",
			"left=",
			// The cgroup goes first: a command that set up before the marker can join it only while it
			// exists, so kill and remove until it is gone; one that comes later fails to start.
			`for _ in 1 2 3 4 5; do [ -d ${CGROUP}/${name} ] || break; ${reap(name)}; rmdir ${CGROUP}/${name} 2>/dev/null && break; done`,
			`[ ! -e ${CGROUP}/${name} ] || left="$left processes"`,
			// Where an agent's cgroup lived before it moved under the run's bound.
			`rmdir ${CGROUP}/maple-agent-${agentId} 2>/dev/null`,
			// Lazily if a process survived: the pages are freed when it finally goes.
			`if mountpoint -q ${scratch}; then umount ${scratch} 2>/dev/null || umount -l ${scratch} || left="$left scratch"; fi`,
			`rm -rf ${agentDir(agentId)} || left="$left files"`,
			`if [ -n "$left" ]; then echo "could not release:$left" >&2; exit 3; fi`,
		],
		"\n",
	)
}

export interface RunTrailer {
	/**
	 * `unreaped`: it ran, but a process of it could not be stopped, so nothing may be promoted.
	 * `released`: the agent was released, so the command never ran.
	 */
	readonly state: "started" | "unreaped" | "setup-failed" | "not-prepared" | "released"
	readonly exitCode: number
	readonly stdoutBytes: number
	readonly stderrBytes: number
}

/** The command's own output and the trailer after it; the last trailer wins. */
export const parseRunOutput = (
	stdout: string,
): { readonly body: string; readonly trailer: RunTrailer } | undefined => {
	const found = Str.lastIndexOf(RUN_TRAILER)(stdout)
	if (Option.isNone(found)) return undefined
	const at = found.value
	const [state, ...numbers] = Str.split(/\s+/u)(Str.trim(Str.slice(at + RUN_TRAILER.length)(stdout)))
	const [exitCode, stdoutBytes, stderrBytes] = Arr.map(numbers, Number)
	if (
		(state !== "started" &&
			state !== "unreaped" &&
			state !== "setup-failed" &&
			state !== "not-prepared" &&
			state !== "released") ||
		exitCode === undefined ||
		stdoutBytes === undefined ||
		stderrBytes === undefined ||
		!Arr.every([exitCode, stdoutBytes, stderrBytes], Number.isFinite)
	)
		return undefined
	return {
		body: Str.replace(/\n$/u, "")(Str.slice(0, at)(stdout)),
		trailer: { state, exitCode, stdoutBytes, stderrBytes },
	}
}

const encodePromotions = Schema.encodeSync(
	Schema.fromJsonString(Schema.Array(Schema.Struct({ path: Schema.String, maxBytes: Schema.Finite }))),
)

/** The promotion helper over the agent's scratch and artifacts, for the files the command declared. */
export const promoteScript = (agentId: string, promote: ReadonlyArray<ExecutorPromotion>): string =>
	Arr.join(
		Arr.map(
			[
				"python3",
				"-I",
				PROMOTE_HELPER,
				agentScratch(agentId),
				agentArtifacts(agentId),
				String(EXECUTOR_LIMITS.promotedTotalBytes),
				encodePromotions(Arr.map(promote, ({ path, maxBytes }) => ({ path, maxBytes }))),
			],
			shellQuote,
		),
		" ",
	)
