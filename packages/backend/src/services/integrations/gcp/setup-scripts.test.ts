import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
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

/** Each scope with the sink flag and IAM command the script must use for it. */
const SCOPES = {
	project: {
		target: { connectorId, scopeType: "project", scopeId: hostProject, projectId: hostProject },
		sink: "--project=acme-host",
		sinkWrite: "--project=acme-host",
		iam: "projects",
		id: "acme-host",
	},
	folder: {
		target: { connectorId, scopeType: "folder", scopeId: resourceNumber, projectId: hostProject },
		sink: "--folder=123456789012",
		sinkWrite: "--folder=123456789012 --include-children",
		iam: "resource-manager folders",
		id: "123456789012",
	},
	organization: {
		target: { connectorId, scopeType: "organization", scopeId: resourceNumber, projectId: hostProject },
		sink: "--organization=123456789012",
		sinkWrite: "--organization=123456789012 --include-children",
		iam: "organizations",
		id: "123456789012",
	},
} as const satisfies Record<string, { target: GcpScriptTarget } & Record<string, unknown>>

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
	excludeGkeContainerLogs: false,
})

// A `gcloud` that records its commands, and each argument on its own line so a value split by
// bad quoting shows. `describe` answers as the test says: found, missing, or denied. The sink's
// writer identity is the one value a script reads back.
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
printf "%s\\n" "$@" >> "$GCLOUD_LOG.args"
case "$*" in
  *"sinks describe"*"--format"*) echo "${WRITER}" ;;
  *" describe "*)
    case "$GCLOUD_DESCRIBE" in
      missing) echo "ERROR: (gcloud) NOT_FOUND: Resource not found" >&2; exit 1 ;;
      denied) echo "ERROR: (gcloud) PERMISSION_DENIED: caller lacks permission" >&2; exit 1 ;;
      api_off) echo "ERROR: (gcloud) API has not been used in project 1 before or it is disabled" >&2; exit 1 ;;
    esac ;;
  *"remove-iam-policy-binding"*)
    case "$GCLOUD_UNBIND" in
      absent) echo "ERROR: Policy binding with the specified principal, role, and condition not found!" >&2; exit 1 ;;
      denied) echo "ERROR: (gcloud) PERMISSION_DENIED: caller lacks permission" >&2; exit 1 ;;
    esac ;;
esac
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run a rendered script in bash against the fake gcloud; returns the commands it issued. */
const run = (
	script: string,
	options: {
		describe?: "found" | "missing" | "denied" | "api_off"
		unbind?: "ok" | "absent" | "denied"
		gcloud?: string
	} = {},
) => {
	const dir = mkdtempSync(join(tmpdir(), "maple-gcp-script-"))
	tempDirs.push(dir)
	writeFileSync(join(dir, "gcloud"), options.gcloud ?? FAKE_GCLOUD)
	chmodSync(join(dir, "gcloud"), 0o755)
	const log = join(dir, "gcloud.log")
	const result = spawnSync("bash", [], {
		input: script,
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			GCLOUD_LOG: log,
			GCLOUD_DESCRIBE: options.describe ?? "missing",
			GCLOUD_UNBIND: options.unbind ?? "ok",
		},
	})
	return {
		dir,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		commands: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
		args: existsSync(`${log}.args`) ? readFileSync(`${log}.args`, "utf8").split("\n") : [],
	}
}

const logsSetupCommands = (scope: (typeof SCOPES)[keyof typeof SCOPES]) => [
	"services enable pubsub.googleapis.com logging.googleapis.com --project=acme-host",
	`pubsub topics describe ${NAME} --project=acme-host`,
	`pubsub topics create ${NAME} --project=acme-host`,
	`pubsub subscriptions describe ${NAME} --project=acme-host`,
	`pubsub subscriptions create ${NAME} --topic=${NAME} --project=acme-host --push-endpoint=${PUSH_ENDPOINT} --push-no-wrapper --ack-deadline=30 --message-retention-duration=1d --expiration-period=never --min-retry-delay=10s --max-retry-delay=600s`,
	`logging sinks describe ${NAME} ${scope.sink}`,
	`logging sinks create ${NAME} pubsub.googleapis.com/projects/acme-host/topics/${NAME} --log-filter=${gcpLogFilter(false)} ${scope.sinkWrite}`,
	`logging sinks describe ${NAME} ${scope.sink} --format=value(writerIdentity)`,
	`projects add-iam-policy-binding acme-host --member=${WRITER} --role=roles/logging.logWriter --condition=None`,
	`pubsub topics add-iam-policy-binding ${NAME} --project=acme-host --member=${WRITER} --role=roles/pubsub.publisher`,
]

const metricsSetupCommands = (scope: (typeof SCOPES)[keyof typeof SCOPES]) => [
	"services enable monitoring.googleapis.com cloudasset.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project=acme-host",
	`iam service-accounts describe ${ACCOUNT} --project=acme-host`,
	`iam service-accounts create ${NAME} --project=acme-host --display-name=Maple metrics and resource reader`,
	`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/monitoring.viewer --condition=None`,
	`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
	`projects add-iam-policy-binding acme-host --member=serviceAccount:${ACCOUNT} --role=roles/serviceusage.serviceUsageConsumer --condition=None`,
	`iam service-accounts add-iam-policy-binding ${ACCOUNT} --project=acme-host --member=serviceAccount:${MAPLE_ACCOUNT} --role=roles/iam.serviceAccountTokenCreator --condition=None`,
]

const logsRemovalCommands = (scope: (typeof SCOPES)[keyof typeof SCOPES]) => [
	`logging sinks describe ${NAME} ${scope.sink}`,
	`logging sinks delete ${NAME} ${scope.sink} --quiet`,
	`pubsub subscriptions describe ${NAME} --project=acme-host`,
	`pubsub subscriptions delete ${NAME} --project=acme-host --quiet`,
	`pubsub topics describe ${NAME} --project=acme-host`,
	`pubsub topics delete ${NAME} --project=acme-host --quiet`,
]

const metricsRemovalCommands = (scope: (typeof SCOPES)[keyof typeof SCOPES]) => [
	`iam service-accounts describe ${ACCOUNT} --project=acme-host`,
	`${scope.iam} remove-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/monitoring.viewer --condition=None`,
	`${scope.iam} remove-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
	`projects remove-iam-policy-binding acme-host --member=serviceAccount:${ACCOUNT} --role=roles/serviceusage.serviceUsageConsumer --condition=None`,
	`iam service-accounts delete ${ACCOUNT} --project=acme-host --quiet`,
]

describe.each(scopeTypes)("renderGcpSetupScript for a %s", (scopeType) => {
	const scope = SCOPES[scopeType]

	it("sets up logs and metrics from nothing, at the right scope", () => {
		const { status, stdout, commands } = run(
			renderGcpSetupScript(setupInput(scopeType, { logs: true, metrics: true })),
		)
		expect(status).toBe(0)
		expect(stdout).toContain("Maple setup complete.")
		expect(commands).toEqual([...logsSetupCommands(scope), ...metricsSetupCommands(scope)])
	})

	it("with logs only, sets up logs and removes an earlier metrics setup", () => {
		const script = renderGcpSetupScript(setupInput(scopeType, { logs: true, metrics: false }))
		expect(script).not.toContain(MAPLE_ACCOUNT)
		const { status, commands } = run(script, { describe: "found" })
		expect(status).toBe(0)
		// Everything exists already, so the log pipeline is updated in place.
		expect(commands.filter((command) => command.includes(" create "))).toEqual([])
		expect(commands).toContain(
			`logging sinks update ${NAME} pubsub.googleapis.com/projects/acme-host/topics/${NAME} --log-filter=${gcpLogFilter(false)} ${scope.sinkWrite}`,
		)
		expect(commands).toContainEqual(
			expect.stringMatching(/^pubsub subscriptions update .*--push-no-wrapper/),
		)
		expect(commands.slice(-metricsRemovalCommands(scope).length)).toEqual(metricsRemovalCommands(scope))
	})

	it("with metrics only, removes an earlier log pipeline and carries no secret", () => {
		const script = renderGcpSetupScript(setupInput(scopeType, { logs: false, metrics: true }))
		expect(script).not.toContain(SECRET)
		expect(script).not.toContain("LOG_FILTER")
		const { status, commands } = run(script, { describe: "found" })
		expect(status).toBe(0)
		expect(commands.slice(0, logsRemovalCommands(scope).length)).toEqual(logsRemovalCommands(scope))
		expect(commands).not.toContainEqual(expect.stringContaining("pubsub.googleapis.com logging"))
		expect(commands).toContain(
			`${scope.iam} add-iam-policy-binding ${scope.id} --member=serviceAccount:${ACCOUNT} --role=roles/cloudasset.viewer --condition=None`,
		)
	})

	it("cleans up everything, and touches nothing when nothing exists", () => {
		const script = renderGcpCleanupScript(scope.target)
		expect(script).not.toContain("secret")
		const existing = run(script, { describe: "found" })
		expect(existing.status).toBe(0)
		expect(existing.commands).toEqual([...logsRemovalCommands(scope), ...metricsRemovalCommands(scope)])

		const fresh = run(script)
		expect(fresh.status).toBe(0)
		expect(fresh.commands.every((command) => command.includes(" describe "))).toBe(true)
	})
})

describe("renderGcpSetupScript", () => {
	it("leaves an enabled metrics setup alone when the deployment has lost its Google identity", () => {
		const script = renderGcpSetupScript({
			...setupInput("organization", { logs: true, metrics: true }),
			mapleServiceAccountEmail: undefined,
		})
		expect(script).toContain("Metrics and resources: on, unavailable")
		const { status, commands } = run(script, { describe: "found" })
		expect(status).toBe(0)
		expect(commands).not.toContainEqual(expect.stringContaining("service-accounts"))
		expect(commands).not.toContainEqual(expect.stringContaining("remove-iam-policy-binding"))
	})

	it("still deletes the service account when one of its role bindings is already gone", () => {
		const script = renderGcpCleanupScript(SCOPES.folder.target)
		const absent = run(script, { describe: "found", unbind: "absent" })
		expect(absent.commands.at(-1)).toBe(
			`iam service-accounts delete ${ACCOUNT} --project=acme-host --quiet`,
		)
		expect(absent.status).toBe(0)

		// A binding that could not be removed keeps the account, so a later run can still name it.
		const denied = run(script, { describe: "found", unbind: "denied" })
		expect(denied.commands).not.toContainEqual(expect.stringContaining("service-accounts delete"))
		expect(denied.status).toBe(1)
	})

	it("keeps the topic when it cannot tell whether the sink is gone", () => {
		const sinkDenied = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in *"sinks describe"*) echo "ERROR: PERMISSION_DENIED" >&2; exit 1 ;; esac
`
		const { status, commands } = run(renderGcpCleanupScript(SCOPES.organization.target), {
			gcloud: sinkDenied,
		})
		expect(commands).not.toContainEqual(expect.stringContaining("pubsub"))
		expect(commands).not.toContainEqual(expect.stringContaining("service-accounts delete"))
		expect(status).toBe(1)
	})

	it("does not take a resource it may not look at for one that is gone", () => {
		const cleanup = run(renderGcpCleanupScript(SCOPES.organization.target), { describe: "denied" })
		expect(cleanup.commands.every((command) => command.includes(" describe "))).toBe(true)
		expect(cleanup.stderr).toContain("PERMISSION_DENIED")
		expect(cleanup.stderr).toContain("Not everything could be removed")
		expect(cleanup.status).toBe(1)

		// Setting up still works: a failed look falls through to the create, which reports for itself.
		const setup = run(renderGcpSetupScript(setupInput("organization", { logs: true, metrics: true })), {
			describe: "denied",
		})
		expect(setup.status).toBe(0)
	})

	it("reads a disabled API as nothing to remove in the host project, but not for the sink", () => {
		const { status, stderr, commands } = run(renderGcpCleanupScript(SCOPES.organization.target), {
			describe: "api_off",
		})
		expect(commands.every((command) => command.includes(" describe "))).toBe(true)
		expect(stderr.match(/has not been used/g)).toHaveLength(1)
		expect(status).toBe(1)
	})

	it("hands gcloud each value as one argument", () => {
		const { args } = run(renderGcpSetupScript(setupInput("folder", { logs: true, metrics: true })))
		expect(args).toEqual(
			expect.arrayContaining([
				`--log-filter=${gcpLogFilter(false)}`,
				`--push-endpoint=${PUSH_ENDPOINT}`,
				"--display-name=Maple metrics and resource reader",
				"--format=value(writerIdentity)",
				`--member=${WRITER}`,
			]),
		)
	})

	it("excludes data-access audit logs and health-check probes by default, GKE containers on request", () => {
		expect(gcpLogFilter(false)).toBe(
			'NOT log_id("cloudaudit.googleapis.com/data_access") AND NOT httpRequest.userAgent:"GoogleHC"',
		)
		expect(gcpLogFilter(true)).toBe(`${gcpLogFilter(false)} AND NOT resource.type="k8s_container"`)
		expect(
			renderGcpSetupScript({
				...setupInput("project", { logs: true, metrics: false }),
				excludeGkeContainerLogs: true,
			}),
		).toContain(`LOG_FILTER='${gcpLogFilter(true)}'`)
	})

	it("passes interpolated values to gcloud verbatim, whatever they contain", () => {
		const hostile = `x'; touch pwned; echo '$(touch pwned)`
		const { dir, status, commands } = run(
			renderGcpSetupScript({
				...setupInput("project", { logs: false, metrics: true }),
				mapleServiceAccountEmail: hostile,
			}),
		)
		expect(status).toBe(0)
		expect(commands.at(-1)).toContain(`--member=serviceAccount:${hostile} `)
		expect(existsSync(join(dir, "pwned"))).toBe(false)
	})
})
