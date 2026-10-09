import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { GcpConnectorId, GcpProjectId, GcpResourceNumber } from "@maple/domain/primitives"
import {
	gcpLogFilter,
	renderGcpCleanupScript,
	renderGcpSetupScript,
	type GcpScriptTarget,
	type GcpSetupScriptInput,
} from "./setup-scripts"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const hostProject = Schema.decodeUnknownSync(GcpProjectId)("acme-host")
const resourceNumber = Schema.decodeUnknownSync(GcpResourceNumber)("123456789012")
const NAME = "maple-018f2b3c4d5e4f708192a3b4"
const ACCOUNT = `${NAME}@acme-host.iam.gserviceaccount.com`
const SECRET = "maple_gcp_s3cr3t-value"
const WRITER = "serviceAccount:service-1@gcp-sa-logging.iam.gserviceaccount.com"
const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"
const PUSH_ENDPOINT = `https://ingest.test/v1/logpush/gcp/${connectorId}?secret=${SECRET}`
const MAPLE_URL = "https://app.maple.test/integrations?integration=gcp"

const target = (scopeType: GcpScriptTarget["scopeType"]): GcpScriptTarget => ({
	connectorId,
	scopeType,
	scopeId: scopeType === "project" ? hostProject : resourceNumber,
	projectId: hostProject,
	mapleUrl: MAPLE_URL,
})

/** Each scope with the sink flag and IAM command the script must use for it. */
const SCOPES = {
	project: {
		target: target("project"),
		sink: "--project=acme-host",
		sinkWrite: "--project=acme-host",
		iam: "projects",
		id: "acme-host",
		open: [],
		found: [],
	},
	folder: {
		target: target("folder"),
		sink: "--folder=123456789012",
		sinkWrite: "--folder=123456789012 --include-children",
		iam: "resource-manager folders",
		id: "123456789012",
		open: ["resource-manager folders describe 123456789012 --format=value(displayName)"],
		found: ["  ✓ Folder 123456789012 found (acme.com)"],
	},
	organization: {
		target: target("organization"),
		sink: "--organization=123456789012",
		sinkWrite: "--organization=123456789012 --include-children",
		iam: "organizations",
		id: "123456789012",
		open: ["organizations describe 123456789012 --format=value(displayName)"],
		found: ["  ✓ Organization 123456789012 found (acme.com)"],
	},
} as const

type Scope = (typeof SCOPES)[keyof typeof SCOPES]
const scopeTypes = ["project", "folder", "organization"] as const

const setupInput = (
	scope: keyof typeof SCOPES,
	capabilities: { logs: boolean; metrics: boolean },
): GcpSetupScriptInput => ({
	...SCOPES[scope].target,
	pushEndpoint: PUSH_ENDPOINT,
	mapleServiceAccountEmail: MAPLE_ACCOUNT,
	logsEnabled: capabilities.logs,
	metricsEnabled: capabilities.metrics,
	logFilter: "keep",
})

const setup = (input: GcpSetupScriptInput) => Effect.runSync(renderGcpSetupScript(input))
const cleanup = (scope: Scope, pushEndpoint?: string) =>
	Effect.runSync(renderGcpCleanupScript({ ...scope.target, pushEndpoint }))

// A `gcloud` that records its commands, and each argument on its own line so a value split by
// bad quoting shows. It talks on stderr like the real one, which a script must not pass on.
// `describe` answers as the test says: found, missing, or denied, and so does the service account
// list (a missing account is an empty list). `GCLOUD_FAIL` refuses the commands that contain it,
// in the words of `GCLOUD_ANSWER` when the test gives some.
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
printf "%s\\n" "$@" >> "$GCLOUD_LOG.args"
denied() {
  echo "\${GCLOUD_ANSWER:-ERROR: (gcloud) PERMISSION_DENIED: Permission denied on resource (or it may not exist).}" >&2
  exit 1
}
# For a disabled API gcloud asks whether to enable it, unless prompts are off.
api_off() {
  if [ "$CLOUDSDK_CORE_DISABLE_PROMPTS" != 1 ]; then
    echo "API not enabled on project [1]. Would you like to enable and retry? (y/N)" >&2
    exit 1
  fi
  echo "ERROR: (gcloud) API has not been used in project 1 before or it is disabled" >&2
  exit 1
}
if [ -n "$GCLOUD_FAIL" ] && [[ "$*" == *"$GCLOUD_FAIL"* ]]; then denied; fi
case "$*" in
  "config get-value account") echo "$GCLOUD_ACCOUNT" ;;
  "auth print-access-token") echo "ya29.token" ;;
  "projects describe"*) echo "Acme Production" ;;
  "organizations describe"* | "resource-manager folders describe"*) echo "acme.com" ;;
  "billing projects describe"*) echo "$GCLOUD_BILLING" ;;
  "services list"*) echo "$GCLOUD_APIS" ;;
  *"sinks describe"*"--format"*) echo "WARNING: gcloud says something on stderr." >&2; echo "${WRITER}" ;;
  *"service-accounts list"*)
    case "$GCLOUD_DESCRIBE" in
      found) echo "${ACCOUNT}" ;;
      missing) echo "Listed 0 items." >&2 ;;
      denied) denied ;;
      api_off) api_off ;;
    esac ;;
  *" describe "*)
    case "$GCLOUD_DESCRIBE" in
      missing) echo "ERROR: (gcloud) NOT_FOUND: Resource not found" >&2; exit 1 ;;
      denied) denied ;;
      api_off) api_off ;;
    esac ;;
  *"remove-iam-policy-binding"*)
    case "$GCLOUD_UNBIND" in
      absent) echo "ERROR: Policy binding with the specified principal, role, and condition not found!" >&2; exit 1 ;;
      denied) denied ;;
    esac ;;
  *"sinks create"* | *"sinks update"*)
    echo "Please remember to grant the writer the Pub/Sub Publisher role on the topic." >&2 ;;
  *) echo "Operation \\"operations/acat.p2-1\\" finished successfully." >&2 ;;
esac
`

// A service account an earlier run deleted: what Google answers for 30 days, even to an Owner.
const FAKE_GCLOUD_ACCOUNT_DELETED = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  "config get-value account") echo jane@acme.com ;;
  "auth print-access-token") echo ya29.token ;;
  "projects describe"*) echo "Acme Production" ;;
  "resource-manager folders describe"*) echo "acme.com" ;;
  "billing projects describe"*) echo True ;;
  *"sinks describe"*"--format"*) echo "${WRITER}" ;;
  *"service-accounts describe"*) echo "ERROR: (gcloud) PERMISSION_DENIED: Permission 'iam.serviceAccounts.get' denied on resource (or it may not exist)." >&2; exit 1 ;;
  *"service-accounts list"*) echo "Listed 0 items." >&2 ;;
  *" describe "*) echo "ERROR: (gcloud) NOT_FOUND: Resource not found" >&2; exit 1 ;;
esac
`

// A `curl` for the two calls a script makes. The permission test answers with the permissions it
// was asked about, less \`CURL_LACKING\`; the report to Maple is recorded with its body.
const FAKE_CURL = `#!/usr/bin/env bash
url="\${!#}"
while [ $# -gt 0 ]; do
  case "$1" in
    --data) data="$2" ;;
    @*) header="$(cat "\${1#@}")" ;;
  esac
  shift
done
case "$url" in
  *testIamPermissions)
    echo "$url $header" >> "$CURL_LOG"
    [ "$CURL_IAM" != unanswered ] || exit 22
    if [ "$CURL_IAM" = nothing ]; then echo "{}"; exit 0; fi
    lacking="\\"$CURL_LACKING\\""
    echo "\${data//$lacking/}" ;;
  *)
    echo "$url $data" >> "$CURL_LOG"
    [ "$CURL_REPORT" = ok ] || exit 22 ;;
esac
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunOptions {
	describe?: "found" | "missing" | "denied" | "api_off"
	unbind?: "ok" | "absent" | "denied"
	gcloud?: string
	/** A substring of the gcloud commands to refuse, and Google's words for it. */
	fail?: string
	answer?: string
	account?: string
	billing?: "True" | "False"
	/** The APIs that are on in the host project. None unless the test says so. */
	apis?: ReadonlyArray<string>
	/**
	 * A permission the account does not hold, `everything` for an account without any, or
	 * `unanswered` when Google cannot be asked.
	 */
	lacking?: string
	report?: "ok" | "unreachable"
	/** Extra arguments for the shell the text is fed to, and text typed after it. */
	shell?: ReadonlyArray<string>
	then?: string
}

/** Feed a rendered script to bash against the fakes; returns what it printed and issued. */
const run = (script: string, options: RunOptions = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "maple-gcp-script-"))
	tempDirs.push(dir)
	const fakes = { gcloud: options.gcloud ?? FAKE_GCLOUD, curl: FAKE_CURL, sleep: "#!/usr/bin/env bash\n" }
	for (const [name, source] of Object.entries(fakes)) {
		writeFileSync(join(dir, name), source)
		chmodSync(join(dir, name), 0o755)
	}
	const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [])
	const log = join(dir, "gcloud.log")
	const result = spawnSync("bash", options.shell ?? [], {
		input: script + (options.then ?? ""),
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			GCLOUD_LOG: log,
			GCLOUD_DESCRIBE: options.describe ?? "missing",
			GCLOUD_UNBIND: options.unbind ?? "ok",
			GCLOUD_FAIL: options.fail ?? "",
			GCLOUD_ANSWER: options.answer ?? "",
			GCLOUD_ACCOUNT: options.account ?? "jane@acme.com",
			GCLOUD_BILLING: options.billing ?? "True",
			GCLOUD_APIS: (options.apis ?? []).join("\n"),
			CURL_LOG: join(dir, "curl.log"),
			CURL_IAM:
				options.lacking === "unanswered"
					? "unanswered"
					: options.lacking === "everything"
						? "nothing"
						: "ok",
			CURL_LACKING: options.lacking ?? "",
			CURL_REPORT: options.report ?? "ok",
		},
	})
	return {
		dir,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		/** Every gcloud command but the access checks, which each test of them names itself. */
		commands: read(log).filter((command) => !isAccessCheck(command)),
		access: read(log).filter(isAccessCheck),
		args: read(`${log}.args`),
		curl: read(join(dir, "curl.log")),
	}
}

const API_LOOKUP = "services list --enabled --project=acme-host --format=value(config.name)"
// Tried before anything is read, for a caller whose gcloud calls are counted against this project.
const RESOURCE_MANAGER_ON = "services enable cloudresourcemanager.googleapis.com --project=acme-host"

const isAccessCheck = (command: string) =>
	command === API_LOOKUP ||
	command === RESOURCE_MANAGER_ON ||
	/^(config get-value|auth print-access-token|projects describe|organizations describe|resource-manager folders describe|billing projects describe|logging read)/.test(
		command,
	)

const REPORT = (members: string) =>
	new RegExp(
		`^\\{"logName":"projects/acme-host/logs/maple-setup","timestamp":"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ","jsonPayload":\\{${members}\\}\\}$`,
	)

const publish = (members: string) =>
	expect.stringMatching(
		new RegExp(
			`^pubsub topics publish ${NAME} --project=acme-host --message=${REPORT(members).source.slice(1)}`,
		),
	)

const logsSetupCommands = (scope: Scope) => [
	// The last access check: whether the sink exists decides whether the filter is tried out.
	`logging sinks describe ${NAME} ${scope.sink}`,
	"services enable pubsub.googleapis.com logging.googleapis.com --project=acme-host",
	`pubsub topics describe ${NAME} --project=acme-host`,
	`pubsub topics create ${NAME} --project=acme-host`,
	`pubsub subscriptions describe ${NAME} --project=acme-host`,
	`pubsub subscriptions create ${NAME} --topic=${NAME} --project=acme-host --push-endpoint=${PUSH_ENDPOINT} --push-no-wrapper --ack-deadline=30 --message-retention-duration=1d --expiration-period=never --min-retry-delay=10s --max-retry-delay=600s`,
	`logging sinks create ${NAME} pubsub.googleapis.com/projects/acme-host/topics/${NAME} --log-filter=${gcpLogFilter(false)} ${scope.sinkWrite}`,
	`logging sinks describe ${NAME} ${scope.sink} --format=value(writerIdentity)`,
	`projects add-iam-policy-binding acme-host --member=${WRITER} --role=roles/logging.logWriter --condition=None`,
	`pubsub topics add-iam-policy-binding ${NAME} --project=acme-host --member=${WRITER} --role=roles/pubsub.publisher`,
	publish('"logs":true'),
]

const metricsSetupCommands = (scope: Scope) => [
	"services enable monitoring.googleapis.com cloudasset.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project=acme-host",
	`iam service-accounts describe ${ACCOUNT} --project=acme-host`,
	`iam service-accounts create ${NAME} --project=acme-host --display-name=Maple metrics and resource reader`,
	`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/monitoring.viewer --condition=None`,
	`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
	`projects add-iam-policy-binding acme-host --member=serviceAccount:${ACCOUNT} --role=roles/serviceusage.serviceUsageConsumer --condition=None`,
	`iam service-accounts add-iam-policy-binding ${ACCOUNT} --project=acme-host --member=serviceAccount:${MAPLE_ACCOUNT} --role=roles/iam.serviceAccountTokenCreator --condition=None`,
]

const logsRemovalCommands = (scope: Scope) => [
	`logging sinks describe ${NAME} ${scope.sink}`,
	`logging sinks delete ${NAME} ${scope.sink} --quiet`,
	`pubsub subscriptions describe ${NAME} --project=acme-host`,
	`pubsub subscriptions delete ${NAME} --project=acme-host --quiet`,
	`pubsub topics describe ${NAME} --project=acme-host`,
	`pubsub topics delete ${NAME} --project=acme-host --quiet`,
]

const ACCOUNT_LOOKUP = `iam service-accounts list --project=acme-host --filter=email=${ACCOUNT} --format=value(email)`

/** A command that only looks: a describe, or the service account list. */
const isLookup = (command: string) => command.includes(" describe ") || command === ACCOUNT_LOOKUP

const metricsRemovalCommands = (scope: Scope) => [
	ACCOUNT_LOOKUP,
	`${scope.iam} remove-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/monitoring.viewer --condition=None`,
	`${scope.iam} remove-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
	`projects remove-iam-policy-binding acme-host --member=serviceAccount:${ACCOUNT} --role=roles/serviceusage.serviceUsageConsumer --condition=None`,
	`iam service-accounts delete ${ACCOUNT} --project=acme-host --quiet`,
]

const UNFINISHED = "\nSetup did not finish. Nothing needs undoing: fix this and paste the script again.\n"

describe.each(scopeTypes)("renderGcpSetupScript for a %s", (scopeType) => {
	const scope = SCOPES[scopeType]
	const host = scopeType === "project" ? "Project" : "Host project"

	it("sets up logs and metrics from nothing, at the right scope, one line per step", () => {
		const { status, stdout, stderr, commands, access } = run(
			setup(setupInput(scopeType, { logs: true, metrics: true })),
		)
		expect(status).toBe(0)
		expect(stderr).toBe("")
		expect(commands).toEqual([
			...logsSetupCommands(scope),
			...metricsSetupCommands(scope),
			publish('"metrics":true'),
		])
		expect(access).toEqual([
			"config get-value account",
			"auth print-access-token",
			API_LOOKUP,
			RESOURCE_MANAGER_ON,
			...scope.open,
			"projects describe acme-host --format=value(name)",
			"billing projects describe acme-host --format=value(billingEnabled)",
			`logging read ${gcpLogFilter(false)} --limit=1 --freshness=1h ${scope.sink}`,
		])
		expect(stdout).toBe(`Maple setup for ${scopeType} ${scope.id}
  Log forwarding          on
  Metrics and resources   on

Checking access
  ✓ Signed in as jane@acme.com
${[...scope.found, `  ✓ ${host} acme-host found (Acme Production)`].join("\n")}
  ✓ Billing is enabled
  ✓ jane@acme.com has the permissions this script needs
  ✓ Log filter accepted

Log forwarding
  ✓ APIs enabled (Pub/Sub, Cloud Logging, Cloud Resource Manager)
  ✓ Topic created
  ✓ Push subscription created
  ✓ Log sink created
  ✓ Sink allowed to write to the project
  ✓ Sink allowed to publish to the topic
  ✓ Check message sent to Maple through the topic

Metrics and resources
  ✓ APIs enabled (Cloud Monitoring, Cloud Asset, IAM, IAM Credentials, Cloud Resource Manager)
  ✓ Read-only service account created
  ✓ Read-only roles granted (Monitoring Viewer, Cloud Asset Viewer, Service Usage Consumer)
  ✓ Maple allowed to read as that account
  ✓ Maple notified

Done. Google Cloud is set up for Maple.
  Maple confirms it within a minute: ${MAPLE_URL}
  Logs:    a new sink can take about 10 minutes to start forwarding. What is logged before
           it does is not forwarded later.
  Metrics: the first read lands within about 10 minutes.
`)
	})

	it("says host project only where the scope is not the project itself", () => {
		for (const enabled of [true, false]) {
			const script = setup(setupInput(scopeType, { logs: enabled, metrics: enabled }))
			expect(/host project/i.test(script)).toBe(scopeType !== "project")
		}
	})

	it("with logs only, sets up logs and removes an earlier metrics setup", () => {
		const script = setup(setupInput(scopeType, { logs: true, metrics: false }))
		expect(script).not.toContain(MAPLE_ACCOUNT)
		const { status, stdout, commands, access } = run(script, { describe: "found" })
		expect(status).toBe(0)
		// Everything exists already, so the log pipeline is updated in place, filter untouched.
		expect(commands.filter((command) => command.includes(" create "))).toEqual([])
		expect(commands).toContain(
			`logging sinks update ${NAME} pubsub.googleapis.com/projects/acme-host/topics/${NAME} ${scope.sinkWrite}`,
		)
		expect(commands).toContainEqual(
			expect.stringMatching(/^pubsub subscriptions update .*--push-no-wrapper/),
		)
		expect(commands.slice(-metricsRemovalCommands(scope).length - 1)).toEqual([
			...metricsRemovalCommands(scope),
			publish('"metrics":false'),
		])
		// Billing only matters to Cloud Monitoring.
		expect(access).not.toContainEqual(expect.stringContaining("billing"))
		expect(stdout).toContain(`
Metrics and resources
  ✓ Read-only roles removed
  ✓ Read-only service account deleted
  ✓ Maple notified

Done. Google Cloud matches your Maple switches.
  Maple confirms it within a minute: ${MAPLE_URL}
`)
	})

	it("with metrics only, removes an earlier log pipeline and reports without a topic", () => {
		const script = setup(setupInput(scopeType, { logs: false, metrics: true }))
		expect(script).not.toContain("LOG_FILTER")
		const { status, stdout, commands, curl } = run(script, { describe: "found" })
		expect(status).toBe(0)
		expect(commands.slice(0, logsRemovalCommands(scope).length)).toEqual(logsRemovalCommands(scope))
		expect(commands).not.toContainEqual(expect.stringContaining("pubsub.googleapis.com logging"))
		expect(commands).not.toContainEqual(expect.stringContaining("topics publish"))
		expect(commands).toContain(
			`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
		)
		expect(curl.filter((call) => call.startsWith(PUSH_ENDPOINT))).toEqual([
			expect.stringMatching(REPORT('"logs":false').source.slice(1)),
			expect.stringMatching(REPORT('"metrics":true').source.slice(1)),
		])
		expect(stdout).toContain(`  Log forwarding          off, removing
  Metrics and resources   on
`)
		expect(stdout).toContain(`
Log forwarding
  ✓ Log sink deleted
  … waiting a minute for Google to stop routing to the topic
  ✓ Push subscription deleted
  ✓ Topic deleted
  ✓ Maple notified
`)
	})

	it("cleans up everything and tells Maple, and touches nothing when nothing exists", () => {
		const script = cleanup(scope, PUSH_ENDPOINT)
		const existing = run(script, { describe: "found" })
		expect(existing.status).toBe(0)
		expect(existing.commands).toEqual([...logsRemovalCommands(scope), ...metricsRemovalCommands(scope)])
		expect(existing.curl).toEqual([
			expect.stringMatching(REPORT('"logs":false,"metrics":false').source.slice(1)),
		])
		expect(existing.stdout).toBe(`Maple cleanup for ${scopeType} ${scope.id}

Checking access
  ✓ Signed in as jane@acme.com
${[...scope.found, `  ✓ ${host} acme-host found (Acme Production)`].join("\n")}

Log forwarding
  ✓ Log sink deleted
  … waiting a minute for Google to stop routing to the topic
  ✓ Push subscription deleted
  ✓ Topic deleted

Metrics and resources
  ✓ Read-only roles removed
  ✓ Read-only service account deleted

Done. Everything the setup script created is gone.
  Left in place: the APIs it switched on, and the Logs Writer role of Google's logging
  service account on acme-host, which other sinks share.
  Now disconnect in Maple: ${MAPLE_URL}
`)

		const fresh = run(script)
		expect(fresh.status).toBe(0)
		expect(fresh.commands.every(isLookup)).toBe(true)
		expect(fresh.stdout.match(/ {2}✓ Nothing left to remove/g)).toHaveLength(2)
	})
})

describe("the text that is copied", () => {
	const script = setup(setupInput("project", { logs: true, metrics: true }))

	it("is the script as a here-document for a child bash", () => {
		const lines = script.split("\n")
		expect(lines.slice(0, 3)).toEqual([
			` { [ -z "\${BASH_VERSION-}" ] || case "$(history 1)" in *MAPLE_SETUP_SCRIPT*) history -d -1 ;; esac 2>/dev/null`,
			"bash /dev/fd/3 3<<'MAPLE_SETUP_SCRIPT'",
			"#!/usr/bin/env bash",
		])
		expect(script.endsWith("\nMAPLE_SETUP_SCRIPT\n}\n")).toBe(true)
		// An interactive zsh runs a comment as a command.
		expect(
			lines
				.slice(0, 2)
				.concat(lines.slice(-3))
				.some((line) => line.startsWith("#")),
		).toBe(false)
		// Plain ASCII survives a paste under any locale; the marks it prints are spelled as bytes.
		expect([...script].every((character) => character.charCodeAt(0) < 128)).toBe(true)

		const cleanupLines = cleanup(SCOPES.project).split("\n")
		expect(cleanupLines[1]).toBe("bash /dev/fd/3 3<<'MAPLE_CLEANUP_SCRIPT'")
		expect(cleanupLines.slice(-3)).toEqual(["MAPLE_CLEANUP_SCRIPT", "}", ""])
	})

	it("leaves an interactive shell alive, with its options and the script's exit status", () => {
		const { stdout } = run(script, {
			fail: "sinks create",
			shell: ["--norc", "--noprofile", "-i"],
			// The next command to fail must not close the shell either.
			then: "echo STATUS=$? ALIVE; false; echo AFTER=$?; set -o | grep -E 'errexit|nounset'; history | grep -c 'MAPLE_SETUP_SCRIP[T]'\n",
		})
		expect(stdout).toContain(UNFINISHED)
		expect(stdout).toContain("STATUS=1 ALIVE\nAFTER=1\n")
		expect(stdout).toMatch(/errexit\s+off\nnounset\s+off/)
		// bash 5 can name the running command's history entry; older ones keep the paste.
		const bashMajor = Number(
			spawnSync("bash", ["-c", "echo $BASH_VERSINFO"], { encoding: "utf8" }).stdout,
		)
		if (bashMajor >= 5) expect(stdout.trim().endsWith("\n0")).toBe(true)
	})

	it("is refused when a value would end the here-document early", () => {
		const hostile = { ...setupInput("project", { logs: true, metrics: true }) }
		const result = Effect.runSync(
			Effect.result(
				renderGcpSetupScript({
					...hostile,
					mapleServiceAccountEmail: "x\nMAPLE_SETUP_SCRIPT\ntouch pwned",
				}),
			),
		)
		expect(result._tag).toBe("Failure")
	})
})

describe("renderGcpSetupScript", () => {
	it("reads a re-run as already in place and keeps the sink's filter", () => {
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: true, metrics: true })),
			{
				describe: "found",
			},
		)
		expect(status).toBe(0)
		expect(commands.filter((command) => command.includes(" create "))).toEqual([])
		expect(commands).not.toContainEqual(expect.stringContaining("--log-filter"))
		expect(stdout).toContain(`
Log forwarding
  ✓ APIs enabled (Pub/Sub, Cloud Logging, Cloud Resource Manager)
  ✓ Topic already exists
  ✓ Push subscription up to date
  ✓ Log sink up to date (filter kept)
  ✓ Sink allowed to write to the project
  ✓ Sink allowed to publish to the topic
  ✓ Check message sent to Maple through the topic

Metrics and resources
  ✓ APIs enabled (Cloud Monitoring, Cloud Asset, IAM, IAM Credentials, Cloud Resource Manager)
  ✓ Read-only service account already exists
  ✓ Read-only roles granted (Monitoring Viewer, Cloud Asset Viewer, Service Usage Consumer)
  ✓ Maple allowed to read as that account
  ✓ Maple notified

Done. Everything is in place.
  Maple confirms it within a minute: ${MAPLE_URL}
`)
		expect(stdout).not.toMatch(/Logs: {4}|Metrics: /)
	})

	it("replaces the sink's filter only when asked to", () => {
		const filtered = (logFilter: GcpSetupScriptInput["logFilter"]) =>
			setup({ ...setupInput("project", { logs: true, metrics: false }), logFilter })
		expect(filtered("keep")).toContain(`LOG_FILTER_MODE='keep'\nLOG_FILTER='${gcpLogFilter(false)}'`)
		expect(filtered("default")).toContain(`LOG_FILTER_MODE='set'\nLOG_FILTER='${gcpLogFilter(false)}'`)
		expect(filtered("exclude_gke_container_logs")).toContain(
			`LOG_FILTER_MODE='set'\nLOG_FILTER='${gcpLogFilter(true)}'`,
		)

		const { stdout, commands } = run(filtered("exclude_gke_container_logs"), { describe: "found" })
		expect(stdout).toContain("  ✓ Log filter accepted\n")
		expect(stdout).toContain("  ✓ Log sink up to date (filter replaced)")
		// The closing line says what this run changed.
		expect(stdout).not.toContain("Done. Everything is in place.")
		expect(commands).toContain(
			`logging sinks update ${NAME} pubsub.googleapis.com/projects/acme-host/topics/${NAME} --log-filter=${gcpLogFilter(true)} --project=acme-host`,
		)
	})

	it("shows Google's answer and what to do when a step is refused, and stops there", () => {
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: true, metrics: true })),
			{
				fail: "sinks create",
			},
		)
		expect(status).toBe(1)
		expect(commands.at(-1)).toContain("logging sinks create")
		expect(
			stdout.endsWith(`
Log forwarding
  ✓ APIs enabled (Pub/Sub, Cloud Logging, Cloud Resource Manager)
  ✓ Topic created
  ✓ Push subscription created
  ✗ Couldn't create the log sink.

      ERROR: (gcloud) PERMISSION_DENIED: Permission denied on resource (or it may not exist).

    What to do: jane@acme.com needs Logs Configuration Writer on project acme-host.
${UNFINISHED}`),
		).toBe(true)
	})

	it("prints Google's error without its machine-readable details", () => {
		const { stdout } = run(setup(setupInput("project", { logs: true, metrics: true })), {
			fail: "topics create",
			answer: [
				"WARNING: This command is using service account impersonation.",
				"ERROR: (gcloud.pubsub.topics.create) Failed to create topic: User not authorized to perform this action.",
				"- '@type': type.googleapis.com/google.rpc.ErrorInfo",
				"  metadata:",
				"    troubleshooter_url: https://console.cloud.google.com/iam-admin/troubleshooter",
			].join("\n"),
		})
		expect(stdout).toContain(
			"User not authorized to perform this action.\n\n    What to do: jane@acme.com needs Owner on project acme-host.",
		)
		expect(stdout).not.toContain("troubleshooter_url")
	})

	it("reads Google's other refusals for what they are, and never prints the secret back", () => {
		const script = setup(setupInput("project", { logs: true, metrics: true }))
		const propagating = run(script, {
			fail: "topics create",
			answer: "ERROR: (gcloud) PERMISSION_DENIED: Cloud Pub/Sub API has not been used in project 1 before or it is disabled.",
		})
		expect(propagating.stdout).toContain(
			"What to do: Google is still switching an API on, or the API is off. Wait a minute and paste the script again.",
		)

		const quoted = run(script, {
			fail: "subscriptions create",
			answer: `ERROR: (gcloud) INVALID_ARGUMENT: Invalid push endpoint given (endpoint=${PUSH_ENDPOINT}).`,
		})
		expect(quoted.stdout).toContain("?secret=HIDDEN).")
		expect(quoted.stdout).not.toContain(SECRET)
		expect(quoted.stdout).toContain(
			"What to do: Read Google's answer above. If it is unclear, send this output to support@maple.dev.",
		)
	})

	it("names the role of the scope for a refused grant there", () => {
		const { stdout } = run(setup(setupInput("organization", { logs: false, metrics: true })), {
			fail: "organizations add-iam-policy-binding",
		})
		expect(stdout).toContain(`  ✗ Couldn't grant the read-only roles.`)
		expect(stdout).toContain(
			"What to do: jane@acme.com needs Organization Administrator on organization 123456789012.",
		)
	})

	it("changes nothing when the project cannot be opened", () => {
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: true, metrics: true })),
			{
				fail: "projects describe",
			},
		)
		expect(status).toBe(1)
		expect(commands).toEqual([])
		expect(stdout).toContain(`
Checking access
  ✓ Signed in as jane@acme.com
  ✗ Can't open project acme-host as jane@acme.com.

      ERROR: (gcloud) PERMISSION_DENIED: Permission denied on resource (or it may not exist).

    What to do: Check the ID in Maple (it is the project ID, not the name or number; list yours with: gcloud projects list). If it is wrong, remove the connection in Maple and connect the right ID: a connection's ID can't be changed. If it is right, this account has no access to the project.
${UNFINISHED}`)
	})

	it("needs the organization to open for metrics, and leaves that to the permissions for logs alone", () => {
		const options = { fail: "organizations describe" }
		const both = run(setup(setupInput("organization", { logs: true, metrics: true })), options)
		expect(both.status).toBe(1)
		expect(both.commands).toEqual([])
		expect(both.stdout).toContain("  ✗ Can't open organization 123456789012 as jane@acme.com.")
		expect(both.stdout).toContain(
			"What to do: Check the ID with: gcloud organizations list. If it is wrong, remove the connection in Maple and connect the right ID: a connection's ID can't be changed. If it is right, this account needs Organization Administrator there.",
		)

		// Logs Configuration Writer does not include reading the organization.
		const logsOnly = run(setup(setupInput("organization", { logs: true, metrics: false })), options)
		expect(logsOnly.status).toBe(0)
		expect(logsOnly.stdout).not.toContain("Organization 123456789012 found")
	})

	it("switches on only the APIs that are off, so a caller who may not switch any on can still run it", () => {
		const script = setup(setupInput("project", { logs: true, metrics: true }))
		const all = [
			"pubsub.googleapis.com",
			"logging.googleapis.com",
			"monitoring.googleapis.com",
			"cloudasset.googleapis.com",
			"iam.googleapis.com",
			"iamcredentials.googleapis.com",
			"cloudresourcemanager.googleapis.com",
		]
		const allOn = run(script, { apis: all, fail: "services enable" })
		expect(allOn.status).toBe(0)
		expect(allOn.commands).not.toContainEqual(expect.stringContaining("services enable"))
		expect(allOn.access).not.toContain(RESOURCE_MANAGER_ON)
		expect(allOn.stdout).toContain("  ✓ APIs enabled (Pub/Sub, Cloud Logging, Cloud Resource Manager)\n")

		// One is off: only that one is switched on, and a refusal names it and the role.
		const oneOff = run(script, { apis: all.filter((api) => api !== "iam.googleapis.com") })
		expect(oneOff.commands.filter((command) => command.startsWith("services enable"))).toEqual([
			"services enable iam.googleapis.com --project=acme-host",
		])
		const refused = run(script, {
			apis: all.filter((api) => api !== "pubsub.googleapis.com"),
			fail: "services enable",
		})
		expect(refused.status).toBe(1)
		expect(refused.stdout).toContain(`  ✗ Couldn't switch on: pubsub.googleapis.com.`)
		expect(refused.stdout).toContain(
			"What to do: jane@acme.com needs Service Usage Admin on project acme-host.",
		)
	})

	it("stops before the first change without billing, a sign-in, or gcloud", () => {
		const script = setup(setupInput("project", { logs: true, metrics: true }))
		const unbilled = run(script, { billing: "False" })
		expect(unbilled.commands).toEqual([])
		expect(unbilled.stdout).toContain(`  ✗ Project acme-host has no billing account.

    What to do: Cloud Monitoring only answers for projects with billing. Link one at https://console.cloud.google.com/billing/linkedaccount?project=acme-host
${UNFINISHED}`)

		const signedOut = run(script, { account: "" })
		expect(signedOut.commands).toEqual([])
		expect(signedOut.stdout).toContain(`  ✗ You are not signed in to Google Cloud.

    What to do: In Cloud Shell, click Authorize when it asks. Elsewhere, run: gcloud auth login
`)

		// The shell the text is fed to still has to find bash.
		const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim()
		const dir = mkdtempSync(join(tmpdir(), "maple-gcp-bin-"))
		tempDirs.push(dir)
		symlinkSync(bash, join(dir, "bash"))
		const bare = spawnSync(bash, [], { input: script, encoding: "utf8", env: { PATH: dir } })
		expect(bare.status).toBe(1)
		expect(bare.stdout).toContain(`  ✗ gcloud is not installed here.

    What to do: Run this script in Cloud Shell: https://shell.cloud.google.com
`)
	})

	it("tries the log filter out before anything is created, when the script is going to set it", () => {
		const unparseable =
			"ERROR: (gcloud.logging.read) INVALID_ARGUMENT: Unparseable filter: syntax error at line 1, column 16, token ' '"
		const script = setup(setupInput("project", { logs: true, metrics: false }))
		const refused = run(script, { fail: "logging read", answer: unparseable })
		expect(refused.status).toBe(1)
		expect(refused.commands).toEqual([`logging sinks describe ${NAME} --project=acme-host`])
		expect(refused.stdout).toContain(`  ✗ Google does not accept the log filter.

      ${unparseable}

    What to do: Google does not accept the log filter. Correct the filter near the top of the script and paste it again. Filter syntax: https://cloud.google.com/logging/docs/view/logging-query-language
`)

		// Someone who may not read logs can still set the sink up.
		const unreadable = run(script, { fail: "logging read" })
		expect(unreadable.status).toBe(0)
		expect(unreadable.stdout).not.toContain("Log filter accepted")

		// An existing sink that keeps its filter has none to try out.
		const kept = run(script, { describe: "found", fail: "logging read", answer: unparseable })
		expect(kept.status).toBe(0)
		expect(kept.access).not.toContainEqual(expect.stringContaining("logging read"))
	})

	it("stops in the access check when an API is off and the account may not switch it on", () => {
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: true, metrics: true })),
			{
				apis: [
					"pubsub.googleapis.com",
					"logging.googleapis.com",
					"cloudresourcemanager.googleapis.com",
				],
				lacking: "serviceusage.services.enable",
			},
		)
		expect(status).toBe(1)
		expect(commands).toEqual([])
		expect(stdout)
			.toContain(`  ✗ jane@acme.com is missing permissions on project acme-host: serviceusage.services.enable.

    What to do: This script has to switch on: monitoring.googleapis.com cloudasset.googleapis.com iam.googleapis.com iamcredentials.googleapis.com. Ask for Service Usage Admin there, or have an administrator switch them on.
`)
	})

	it("reads an account without any of the permissions as a wrong ID first", () => {
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: true, metrics: true })),
			{ lacking: "everything" },
		)
		expect(status).toBe(1)
		expect(commands).toEqual([])
		expect(stdout)
			.toContain(`  ✗ jane@acme.com has none of the permissions this script needs on project acme-host.

    What to do: Check the ID in Maple. If it is wrong, remove the connection in Maple and connect the right ID: a connection's ID can't be changed. If it is right, this account has no rights there. Ask for Owner there, or have an administrator run this script.
`)
		expect(stdout).not.toContain("pubsub.topics.create")
	})

	it("names a missing permission before the first change", () => {
		const script = setup(setupInput("organization", { logs: true, metrics: true }))
		const onHost = run(script, { lacking: "resourcemanager.projects.setIamPolicy" })
		expect(onHost.status).toBe(1)
		expect(onHost.commands).toEqual([])
		expect(onHost.stdout)
			.toContain(`  ✗ jane@acme.com is missing permissions on project acme-host: resourcemanager.projects.setIamPolicy.

    What to do: Ask for Owner there, or have an administrator run this script.
`)
		expect(onHost.curl).toEqual([
			"https://cloudresourcemanager.googleapis.com/v3/projects/acme-host:testIamPermissions Authorization: Bearer ya29.token",
		])

		const onScope = run(script, { lacking: "logging.sinks.create" })
		expect(onScope.commands).toEqual([])
		expect(onScope.stdout)
			.toContain(`  ✗ jane@acme.com is missing permissions on organization 123456789012: logging.sinks.create.

    What to do: Ask for Logs Configuration Writer and Organization Administrator there, or have an administrator run this script. If the ID looks wrong, check it with: gcloud organizations list
`)
		expect(onScope.curl.at(-1)).toContain("/v3/organizations/123456789012:testIamPermissions")

		// No answer is not a refusal: the steps report for themselves.
		const unanswered = run(script, { lacking: "unanswered" })
		expect(unanswered.status).toBe(0)
		expect(unanswered.stdout).not.toContain("has the permissions")
	})

	it("finishes when Maple cannot be reached, and does not claim a confirmation", () => {
		const { status, stdout } = run(setup(setupInput("project", { logs: false, metrics: true })), {
			report: "unreachable",
		})
		expect(status).toBe(0)
		expect(stdout).toContain(
			"  • Couldn't reach Maple to confirm. Maple shows the connection as pending until a later run reaches it.\n",
		)
		expect(stdout).toContain("Done. Google Cloud is set up for Maple.")
		expect(stdout).not.toContain("Maple confirms it")

		const unpublished = run(setup(setupInput("project", { logs: true, metrics: true })), {
			fail: "topics publish",
		})
		expect(unpublished.status).toBe(0)
		expect(unpublished.stdout).not.toContain("Maple confirms it")
	})

	it("waits for a new service account only while Google says it does not exist", () => {
		// The first two grants are answered as for an account IAM has not heard of yet.
		const slow = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  "config get-value account") echo jane@acme.com ;;
  "auth print-access-token") echo ya29.token ;;
  "projects describe"*) echo "Acme Production" ;;
  "billing projects describe"*) echo True ;;
  *" describe "*) echo "ERROR: (gcloud) NOT_FOUND: Resource not found" >&2; exit 1 ;;
  *"add-iam-policy-binding"*)
    if [ "$(grep -c add-iam-policy-binding "$GCLOUD_LOG")" -le 2 ]; then
      echo "ERROR: (gcloud) INVALID_ARGUMENT: Service account ${ACCOUNT} does not exist." >&2
      exit 1
    fi ;;
esac
`
		const { status, stdout, commands } = run(
			setup(setupInput("project", { logs: false, metrics: true })),
			{ gcloud: slow },
		)
		expect(status).toBe(0)
		expect(stdout.match(/ {2}… waiting for Google to publish the new service account\n/g)).toHaveLength(1)
		expect(commands.filter((command) => command.includes("roles/monitoring.viewer"))).toHaveLength(3)
	})

	it("leaves an enabled metrics setup alone when the deployment has lost its Google identity", () => {
		const script = setup({
			...setupInput("organization", { logs: true, metrics: true }),
			mapleServiceAccountEmail: undefined,
		})
		expect(script).toContain(
			"#   Metrics and resources: not available on this Maple deployment, left as is\n",
		)
		const { status, stdout, commands } = run(script, { describe: "found" })
		expect(status).toBe(0)
		expect(stdout).toContain(
			"  Metrics and resources   not available on this Maple deployment, left as is\n",
		)
		expect(stdout).not.toContain("\nMetrics and resources\n")
		expect(commands).not.toContainEqual(expect.stringContaining("service-accounts"))
		expect(commands).not.toContainEqual(expect.stringContaining("remove-iam-policy-binding"))
	})

	it("still deletes the service account when one of its role bindings is already gone", () => {
		const script = cleanup(SCOPES.folder)
		const absent = run(script, { describe: "found", unbind: "absent" })
		expect(absent.commands.at(-1)).toBe(
			`iam service-accounts delete ${ACCOUNT} --project=acme-host --quiet`,
		)
		expect(absent.status).toBe(0)

		// A binding that could not be removed keeps the account, so a later run can still name it.
		const denied = run(script, { describe: "found", unbind: "denied" })
		expect(denied.commands).not.toContainEqual(expect.stringContaining("service-accounts delete"))
		expect(denied.status).toBe(1)
		expect(denied.stdout).toContain(`  ✗ Couldn't remove the read-only roles.`)
		expect(denied.stdout).toContain(
			"What to do: jane@acme.com needs Folder IAM Admin on folder 123456789012.",
		)
		expect(denied.stdout).toContain(
			"\nCleanup did not finish. Fix this and paste the script again: it continues where it stopped.\n",
		)

		// The host project's binding is the Owner's to remove, and only gcloud's own "not found"
		// means a binding is gone.
		const hostDenied = run(script, { describe: "found", fail: "projects remove-iam-policy-binding" })
		expect(hostDenied.stdout).toContain("What to do: jane@acme.com needs Owner on project acme-host.")
		const unknown = run(script, {
			describe: "found",
			fail: "remove-iam-policy-binding",
			answer: "ERROR: (gcloud) NOT_FOUND: Requested entity was not found.",
		})
		expect(unknown.commands).not.toContainEqual(expect.stringContaining("service-accounts delete"))
		expect(unknown.status).toBe(1)
	})

	it("keeps the topic when it cannot tell whether the sink is gone", () => {
		const { status, stdout, commands } = run(cleanup(SCOPES.organization), { fail: "sinks describe" })
		expect(commands).not.toContainEqual(expect.stringContaining("pubsub"))
		expect(commands).not.toContainEqual(expect.stringContaining("service-accounts"))
		expect(status).toBe(1)
		expect(stdout).toContain(`  ✗ Couldn't check whether the log sink still exists.`)
		expect(stdout).toContain(
			"What to do: jane@acme.com needs Logs Configuration Writer on organization 123456789012.",
		)
	})

	it("does not take a resource it may not look at for one that is gone", () => {
		const removal = run(cleanup(SCOPES.organization), { describe: "denied" })
		expect(removal.commands).toEqual([`logging sinks describe ${NAME} --organization=123456789012`])
		expect(removal.stdout).toContain("PERMISSION_DENIED")
		expect(removal.status).toBe(1)

		// Setting up still works: a failed look falls through to the create, which reports for itself.
		const created = run(setup(setupInput("organization", { logs: true, metrics: true })), {
			describe: "denied",
		})
		expect(created.status).toBe(0)
	})

	it("reads a disabled API as nothing to remove in the host project, but not for the sink", () => {
		const sinkUnknown = run(cleanup(SCOPES.organization), { describe: "api_off" })
		expect(sinkUnknown.commands).toEqual([`logging sinks describe ${NAME} --organization=123456789012`])
		expect(sinkUnknown.stdout).toContain("has not been used")
		expect(sinkUnknown.status).toBe(1)

		// With the sink known to be gone, the host project's disabled APIs hold nothing.
		const hostOff = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  "config get-value account") echo jane@acme.com ;;
  "auth print-access-token") echo ya29.token ;;
  "projects describe"*) echo "Acme Production" ;;
  *"sinks describe"*) echo "ERROR: (gcloud) NOT_FOUND: Resource not found" >&2; exit 1 ;;
  *) echo "ERROR: (gcloud) API has not been used in project 1 before or it is disabled" >&2; exit 1 ;;
esac
`
		const { status, stdout, commands } = run(cleanup(SCOPES.project), { gcloud: hostOff })
		expect(status).toBe(0)
		expect(commands.every(isLookup)).toBe(true)
		expect(stdout.match(/ {2}✓ Nothing left to remove/g)).toHaveLength(2)
	})

	it("finishes when the service account was deleted by an earlier run", () => {
		const removal = run(cleanup(SCOPES.project), { gcloud: FAKE_GCLOUD_ACCOUNT_DELETED })
		expect(removal.stdout).toContain("Done. Everything the setup script created is gone.")
		expect(removal.status).toBe(0)
		expect(removal.commands.every(isLookup)).toBe(true)

		// So does a setup script with metrics off, run a second time.
		const metricsOff = run(setup(setupInput("project", { logs: true, metrics: false })), {
			gcloud: FAKE_GCLOUD_ACCOUNT_DELETED,
		})
		expect(metricsOff.status).toBe(0)
		expect(metricsOff.commands.slice(-2)).toEqual([ACCOUNT_LOOKUP, publish('"metrics":false')])
	})

	it("creates the service account again after an earlier run deleted it", () => {
		const { status, commands } = run(setup(setupInput("folder", { logs: false, metrics: true })), {
			gcloud: FAKE_GCLOUD_ACCOUNT_DELETED,
		})
		expect(status).toBe(0)
		// The new account has none of the deleted one's roles: all four grants are made again.
		expect(commands.slice(-metricsSetupCommands(SCOPES.folder).length)).toEqual(
			metricsSetupCommands(SCOPES.folder),
		)
	})

	it("carries no secret and reports nothing once the connector is gone", () => {
		const script = cleanup(SCOPES.project)
		expect(script).not.toContain("maple_gcp_")
		expect(script).not.toContain("PUSH_ENDPOINT=")
		const { status, stdout, curl } = run(script, { describe: "found" })
		expect(status).toBe(0)
		expect(curl).toEqual([])
		expect(stdout).not.toContain("disconnect in Maple")
	})

	it("hands gcloud each value as one argument", () => {
		const { args } = run(setup(setupInput("folder", { logs: true, metrics: true })))
		expect(args).toEqual(
			expect.arrayContaining([
				`--log-filter=${gcpLogFilter(false)}`,
				`--push-endpoint=${PUSH_ENDPOINT}`,
				"--display-name=Maple metrics and resource reader",
				"--format=value(writerIdentity)",
				`--member=${WRITER}`,
				expect.stringMatching(`^--message=${REPORT('"logs":true').source.slice(1)}`),
			]),
		)
	})

	it("leaves out high-volume noise by default, and GKE containers on request", () => {
		expect(gcpLogFilter(false)).toBe(
			'NOT log_id("cloudaudit.googleapis.com/data_access") AND NOT httpRequest.userAgent:"GoogleHC" AND NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update" AND NOT logName:"serialconsole.googleapis.com"',
		)
		expect(gcpLogFilter(true)).toBe(`${gcpLogFilter(false)} AND NOT resource.type="k8s_container"`)
	})

	it("passes interpolated values to gcloud verbatim, whatever they contain", () => {
		const hostile = `x'; touch pwned; echo '$(touch pwned)`
		const { dir, status, commands } = run(
			setup({
				...setupInput("project", { logs: false, metrics: true }),
				mapleServiceAccountEmail: hostile,
				mapleUrl: hostile,
			}),
		)
		expect(status).toBe(0)
		expect(commands.at(-1)).toContain(`--member=serviceAccount:${hostile} `)
		expect(existsSync(join(dir, "pwned"))).toBe(false)
	})
})
