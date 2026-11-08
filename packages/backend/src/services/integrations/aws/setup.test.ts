import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Schema, Array as Arr, String as Str, Option } from "effect"
import { AwsAccountId } from "@maple/domain/primitives"
import { renderAwsCleanupScript, renderAwsSetupScript } from "./setup"

const accountId = Schema.decodeSync(AwsAccountId)("123456789012")
const PROVIDER_ARN = "arn:aws:iam::123456789012:oidc-provider/api.maple.test/oidc/aws"
const target = {
	accountId,
	stackName: "maple-integration-abc",
	metricsStackName: "maple-metrics-abc",
	oidcProvider: {
		arn: PROVIDER_ARN,
		url: "https://api.maple.test/oidc/aws",
		audience: "sts.amazonaws.com",
	},
}

// A fake `aws` that logs every call. Metric stream stacks exist in $AWS_STACKS_IN. The account has
// Maple's OIDC provider when $AWS_PROVIDER_EXISTS is set, and the roles in $AWS_ROLES_LEFT. The first wait
// fails with $AWS_WAIT_FAILS (Firehose wrote meanwhile); the first delete call with $AWS_DELETE_FAILS.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$AWS_LOG"
region=""
args=("$@")
for i in "\${!args[@]}"; do [ "\${args[$i]}" = "--region" ] && region="\${args[$((i + 1))]}"; done
case "$1 $2" in
  "sts get-caller-identity") echo "123456789012" ;;
  "ec2 describe-regions") echo "us-east-1 eu-central-1 us-west-2" ;;
  "iam get-open-id-connect-provider") [ -n "$AWS_PROVIDER_EXISTS" ] || exit 254 ;;
  "iam list-roles") echo "$AWS_ROLES_LEFT" ;;
  "cloudformation describe-stacks")
    case "$*" in
      *maple-metrics-abc*) case " $AWS_STACKS_IN " in *" $region "*) echo CREATE_COMPLETE ;; *) exit 254 ;; esac ;;
      *) echo CREATE_COMPLETE ;;
    esac ;;
  "cloudformation describe-stack-resource") echo "failed-deliveries-$region" ;;
  "cloudformation delete-stack")
    if [ -n "$AWS_DELETE_FAILS" ] && [ ! -e "$AWS_LOG.deleted" ]; then touch "$AWS_LOG.deleted"; exit 254; fi ;;
  "cloudformation wait")
    if [ -n "$AWS_WAIT_FAILS" ] && [ ! -e "$AWS_LOG.waited" ]; then touch "$AWS_LOG.waited"; exit 255; fi ;;
esac
exit 0
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (
	script: string,
	env: {
		readonly stacksIn: ReadonlyArray<string>
		readonly waitFails?: boolean
		readonly deleteFails?: boolean
		readonly providerExists?: boolean
		readonly rolesLeft?: string
	},
) => {
	const dir = mkdtempSync(join(tmpdir(), "maple-aws-script-"))
	tempDirs.push(dir)
	writeFileSync(join(dir, "aws"), FAKE_AWS)
	chmodSync(join(dir, "aws"), 0o755)
	const log = join(dir, "aws.log")
	const result = spawnSync("bash", [], {
		input: script,
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			AWS_LOG: log,
			AWS_STACKS_IN: Arr.join(env.stacksIn, " "),
			AWS_WAIT_FAILS: env.waitFails === true ? "1" : "",
			AWS_DELETE_FAILS: env.deleteFails === true ? "1" : "",
			AWS_PROVIDER_EXISTS: env.providerExists === true ? "1" : "",
			AWS_ROLES_LEFT: env.rolesLeft ?? "",
		},
	})
	return {
		status: result.status,
		calls: existsSync(log) ? Str.split("\n")(Str.trim(readFileSync(log, "utf8"))) : [],
	}
}

/** The calls that touch one region's metric stream stack or its bucket, in order. */
const metricsCalls = (calls: ReadonlyArray<string>, region: string) =>
	Arr.map(
		Arr.filter(
			Arr.filter(
				calls,
				(call) =>
					Str.includes(`--region ${region}`)(call) &&
					/s3 rm|delete-stack|wait stack-delete/u.test(call),
			),
			(call) => !Str.includes(target.stackName)(call),
		),
		(call) =>
			Str.startsWith("s3 rm")(call)
				? "empty bucket"
				: Str.includes("delete-stack ")(call)
					? "delete"
					: "wait",
	)

describe("AWS setup scripts", () => {
	it("empties a stream's bucket before every delete, and retries a delete that failed", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const { status, calls } = run(cleanup, { stacksIn: ["eu-central-1"], waitFails: true })
		expect(status).toBe(0)
		expect(metricsCalls(calls, "eu-central-1")).toEqual([
			"empty bucket",
			"delete",
			"wait",
			"empty bucket",
			"delete",
			"wait",
		])
		// Regions without the stack are left alone, and the role's stack goes after them.
		expect(metricsCalls(calls, "us-west-2")).toEqual([])
		const roleStackDeleted = Option.getOrElse(
			Arr.findFirstIndex(calls, (call) =>
				Str.includes(`stack-delete-complete --region us-east-1 --stack-name ${target.stackName}`)(
					call,
				),
			),
			() => -1,
		)
		expect(roleStackDeleted).toBeGreaterThan(
			Option.getOrElse(
				Arr.findLastIndex(calls, (call) => Str.includes("eu-central-1")(call)),
				() => -1,
			),
		)
	})

	it("retries a delete request AWS refused, instead of ending the script", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const { status, calls } = run(cleanup, { stacksIn: ["eu-central-1"], deleteFails: true })
		expect(status).toBe(0)
		expect(metricsCalls(calls, "eu-central-1")).toEqual([
			"empty bucket",
			"delete",
			"empty bucket",
			"delete",
			"wait",
		])
	})

	it("stops a cleanup that cannot delete a stream's stack, so the role that trusts Maple is not removed first", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const failing = Str.replace(
			`if [ -n "$AWS_WAIT_FAILS" ] && [ ! -e "$AWS_LOG.waited" ]; then touch "$AWS_LOG.waited"; exit 255; fi ;;`,
			"exit 255 ;;",
		)(FAKE_AWS)
		const dir = mkdtempSync(join(tmpdir(), "maple-aws-script-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "aws"), failing)
		chmodSync(join(dir, "aws"), 0o755)
		const log = join(dir, "aws.log")
		const result = spawnSync("bash", [], {
			input: cleanup,
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				AWS_LOG: log,
				AWS_STACKS_IN: "eu-central-1",
			},
		})
		expect(result.status).not.toBe(0)
		expect(readFileSync(log, "utf8")).not.toContain(
			`delete-stack --region us-east-1 --stack-name ${target.stackName}`,
		)
	})

	it("a setup without a stream removes the stream from every region that still has it", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null))
		const { status, calls } = run(setup, { stacksIn: ["us-east-1", "eu-central-1"] })
		expect(status).toBe(0)
		expect(metricsCalls(calls, "us-east-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "eu-central-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "us-west-2")).toEqual([])
	})

	it("registers Maple's identity provider only when the account lacks it, before the stack needs it", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null))
		const fresh = run(setup, { stacksIn: [] })
		expect(fresh.status).toBe(0)
		const created = Option.getOrElse(
			Arr.findFirstIndex(fresh.calls, (call) =>
				Str.startsWith("iam create-open-id-connect-provider")(call),
			),
			() => -1,
		)
		expect(fresh.calls[created]).toContain(
			`--url ${target.oidcProvider.url} --client-id-list sts.amazonaws.com`,
		)
		const deployed = Option.getOrElse(
			Arr.findFirstIndex(fresh.calls, (call) => Str.startsWith("cloudformation deploy")(call)),
			() => -1,
		)
		expect(created).toBeLessThan(deployed)
		// The stack never owns it, so deleting one connection's stack cannot take it from another.
		expect(fresh.calls[deployed]).toContain("--parameter-overrides CreateOidcProvider=false")

		const again = run(setup, { stacksIn: [], providerExists: true })
		expect(again.status).toBe(0)
		expect(
			Arr.some(again.calls, (call) => Str.startsWith("iam create-open-id-connect-provider")(call)),
		).toBe(false)
		// One that exists gets Maple's audience, in case it was made by hand without it.
		expect(again.calls).toContain(
			`iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${PROVIDER_ARN} --client-id sts.amazonaws.com`,
		)
	})

	it("deletes Maple's identity provider with the last Maple role, and keeps it for another", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const shared = run(cleanup, { stacksIn: [], rolesLeft: "MapleIntegration-def" })
		expect(shared.status).toBe(0)
		expect(
			Arr.some(shared.calls, (call) => Str.startsWith("iam delete-open-id-connect-provider")(call)),
		).toBe(false)

		const last = run(cleanup, { stacksIn: [] })
		expect(last.status).toBe(0)
		expect(last.calls.at(-1)).toBe(
			`iam delete-open-id-connect-provider --open-id-connect-provider-arn ${PROVIDER_ARN}`,
		)
	})
})
