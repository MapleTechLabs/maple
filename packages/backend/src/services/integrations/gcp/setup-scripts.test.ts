import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GcpConnectorId, GcpProjectId } from "@maple/domain/primitives"
import {
	gcpLogFilter,
	renderGcpCleanupScript,
	renderGcpSetupScript,
	type GcpSetupScriptInput,
} from "./setup-scripts"

const connectorId = Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const projectId = Schema.decodeUnknownSync(GcpProjectId)("acme-prod")
const NAME = "maple-018f2b3c4d5e4f708192a3b4"
const SECRET = "maple_gcp_s3cr3t-value"
const WRITER = "serviceAccount:service-1@gcp-sa-logging.iam.gserviceaccount.com"
const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"

const input: GcpSetupScriptInput = {
	connectorId,
	projectId,
	pushEndpoint: `https://ingest.test/v1/logpush/gcp/${connectorId}?secret=${SECRET}`,
	mapleServiceAccountEmail: MAPLE_ACCOUNT,
	excludeGkeContainerLogs: false,
}

// A `gcloud` that records its arguments. `describe` reports "not found" unless the test says
// the resources exist, and the sink's writer identity is the one value a script reads back.
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  *"sinks describe"*"--format"*) echo "${WRITER}" ;;
  *" describe "*) [ "$GCLOUD_EXISTS" = 1 ] || exit 1 ;;
  *" delete "*) exit "$GCLOUD_DELETE_STATUS" ;;
esac
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run a rendered script in bash against the fake gcloud; returns the commands it issued. */
const run = (script: string, options: { exists?: boolean; deleteStatus?: number } = {}) => {
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
			GCLOUD_DELETE_STATUS: String(options.deleteStatus ?? 0),
		},
	})
	return {
		dir,
		status: result.status,
		stdout: result.stdout,
		commands: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
	}
}

describe("renderGcpSetupScript", () => {
	it("creates the log pipeline and the metrics account in a fresh project", () => {
		const { status, stdout, commands } = run(renderGcpSetupScript(input))
		expect(status).toBe(0)
		expect(stdout).toContain("Maple setup complete for acme-prod")
		expect(commands).toEqual([
			"services enable pubsub.googleapis.com logging.googleapis.com monitoring.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project=acme-prod",
			`pubsub topics describe ${NAME} --project=acme-prod`,
			`pubsub topics create ${NAME} --project=acme-prod`,
			`pubsub subscriptions describe ${NAME} --project=acme-prod`,
			`pubsub subscriptions create ${NAME} --topic=${NAME} --project=acme-prod --push-endpoint=${input.pushEndpoint} --push-no-wrapper --ack-deadline=30 --message-retention-duration=1d --expiration-period=never --min-retry-delay=10s --max-retry-delay=600s`,
			`logging sinks describe ${NAME} --project=acme-prod`,
			`logging sinks create ${NAME} pubsub.googleapis.com/projects/acme-prod/topics/${NAME} --log-filter=${gcpLogFilter(false)} --project=acme-prod`,
			`logging sinks describe ${NAME} --project=acme-prod --format=value(writerIdentity)`,
			`projects add-iam-policy-binding acme-prod --member=${WRITER} --role=roles/logging.logWriter --condition=None`,
			`pubsub topics add-iam-policy-binding ${NAME} --project=acme-prod --member=${WRITER} --role=roles/pubsub.publisher`,
			`iam service-accounts describe ${NAME}@acme-prod.iam.gserviceaccount.com --project=acme-prod`,
			`iam service-accounts create ${NAME} --project=acme-prod --display-name=Maple metrics reader`,
			`projects add-iam-policy-binding acme-prod --member=serviceAccount:${NAME}@acme-prod.iam.gserviceaccount.com --role=roles/monitoring.viewer --condition=None`,
			`iam service-accounts add-iam-policy-binding ${NAME}@acme-prod.iam.gserviceaccount.com --project=acme-prod --member=serviceAccount:${MAPLE_ACCOUNT} --role=roles/iam.serviceAccountTokenCreator`,
		])
	})

	it("updates instead of creating when re-run, so an edited filter is applied", () => {
		const { status, commands } = run(renderGcpSetupScript(input), { exists: true })
		expect(status).toBe(0)
		expect(commands.filter((command) => command.includes(" create "))).toEqual([])
		expect(commands).toContainEqual(
			expect.stringMatching(/^pubsub subscriptions update .*--push-no-wrapper/),
		)
		expect(commands).toContainEqual(
			expect.stringMatching(/^logging sinks update .*--log-filter=NOT log_id/),
		)
	})

	it("omits every metrics step when the deployment has no Google identity", () => {
		const script = renderGcpSetupScript({ ...input, mapleServiceAccountEmail: undefined })
		expect(script).not.toContain("service-accounts")
		expect(script).not.toContain("monitoring")
		const { status, commands } = run(script)
		expect(status).toBe(0)
		expect(commands[0]).toBe(
			"services enable pubsub.googleapis.com logging.googleapis.com --project=acme-prod",
		)
		expect(commands.at(-1)).toContain("pubsub topics add-iam-policy-binding")
	})

	it("excludes data-access audit logs and health-check probes by default, GKE containers on request", () => {
		expect(gcpLogFilter(false)).toBe(
			'NOT log_id("cloudaudit.googleapis.com/data_access") AND NOT httpRequest.userAgent:"GoogleHC"',
		)
		expect(gcpLogFilter(true)).toBe(`${gcpLogFilter(false)} AND NOT resource.type="k8s_container"`)
		expect(renderGcpSetupScript({ ...input, excludeGkeContainerLogs: true })).toContain(
			`LOG_FILTER='${gcpLogFilter(true)}'`,
		)
	})

	it("passes interpolated values to gcloud verbatim, whatever they contain", () => {
		const hostile = `x'; touch pwned; echo '$(touch pwned)`
		const { dir, status, commands } = run(
			renderGcpSetupScript({ ...input, mapleServiceAccountEmail: hostile }),
		)
		expect(status).toBe(0)
		expect(commands.at(-1)).toContain(`--member=serviceAccount:${hostile} `)
		expect(existsSync(join(dir, "pwned"))).toBe(false)
	})
})

describe("renderGcpCleanupScript", () => {
	const script = renderGcpCleanupScript(connectorId, projectId)

	it("carries the secret in the setup script only", () => {
		expect(renderGcpSetupScript(input)).toContain(SECRET)
		expect(script).not.toContain("secret")
		expect(script).not.toContain("maple_gcp_")
	})

	it("removes every resource, continuing past ones that are already gone", () => {
		const { status, commands } = run(script, { deleteStatus: 1 })
		expect(status).toBe(0)
		expect(commands).toEqual([
			`logging sinks delete ${NAME} --project=acme-prod --quiet`,
			`pubsub subscriptions delete ${NAME} --project=acme-prod`,
			`pubsub topics delete ${NAME} --project=acme-prod`,
			`projects remove-iam-policy-binding acme-prod --member=serviceAccount:${NAME}@acme-prod.iam.gserviceaccount.com --role=roles/monitoring.viewer --condition=None`,
			`iam service-accounts delete ${NAME}@acme-prod.iam.gserviceaccount.com --project=acme-prod --quiet`,
		])
	})
})
