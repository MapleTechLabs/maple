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

// A `gcloud` that records its arguments. `describe` reports "not found" unless the test says
// the resources exist, and the sink's writer identity is the one value a script reads back.
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  *"sinks describe"*"--format"*) echo "${WRITER}" ;;
  *" describe "*) [ "$GCLOUD_EXISTS" = 1 ] || exit 1 ;;
  *"remove-iam-policy-binding"*) exit "$GCLOUD_REMOVE_BINDING_STATUS" ;;
esac
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run a rendered script in bash against the fake gcloud; returns the commands it issued. */
const run = (script: string, options: { exists?: boolean; removeBindingStatus?: number } = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "maple-gcp-script-"))
	tempDirs.push(dir)
	writeFileSync(join(dir, "gcloud"), FAKE_GCLOUD)
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
			GCLOUD_EXISTS: options.exists === true ? "1" : "0",
			GCLOUD_REMOVE_BINDING_STATUS: String(options.removeBindingStatus ?? 0),
		},
	})
	return {
		dir,
		status: result.status,
		stdout: result.stdout,
		commands: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
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
	`iam service-accounts add-iam-policy-binding ${ACCOUNT} --project=acme-host --member=serviceAccount:${MAPLE_ACCOUNT} --role=roles/iam.serviceAccountTokenCreator`,
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
		const { status, commands } = run(script, { exists: true })
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
		const { status, commands } = run(script, { exists: true })
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
		const existing = run(script, { exists: true })
		expect(existing.status).toBe(0)
		expect(existing.commands).toEqual([...logsRemovalCommands(scope), ...metricsRemovalCommands(scope)])

		const fresh = run(script)
		expect(fresh.status).toBe(0)
		expect(fresh.commands.every((command) => command.includes(" describe "))).toBe(true)
	})
})

describe("renderGcpSetupScript", () => {
	it("treats metrics as off when the deployment has no Google identity", () => {
		const script = renderGcpSetupScript({
			...setupInput("organization", { logs: true, metrics: true }),
			mapleServiceAccountEmail: undefined,
		})
		const { status, commands } = run(script)
		expect(status).toBe(0)
		expect(commands).toEqual([
			...logsSetupCommands(SCOPES.organization),
			`iam service-accounts describe ${ACCOUNT} --project=acme-host`,
		])
	})

	it("still deletes the service account when one of its role bindings is already gone", () => {
		const { status, commands } = run(renderGcpCleanupScript(SCOPES.folder.target), {
			exists: true,
			removeBindingStatus: 1,
		})
		expect(status).toBe(0)
		expect(commands.at(-1)).toBe(`iam service-accounts delete ${ACCOUNT} --project=acme-host --quiet`)
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
