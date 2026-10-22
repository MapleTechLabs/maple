import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { AwsAccountId } from "@maple/domain/primitives"
import { renderAwsCleanupScript, renderAwsSetupScript } from "./setup"

const accountId = Schema.decodeUnknownSync(AwsAccountId)("123456789012")
const target = {
	accountId,
	stackName: "maple-integration-abc",
	metricsStackName: "maple-metrics-abc",
}

// A fake `aws` that logs every call. Metric stream stacks exist in $AWS_STACKS_IN; the first
// wait for a deleted one fails when $AWS_WAIT_FAILS is set, as when Firehose wrote meanwhile.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$AWS_LOG"
region=""
args=("$@")
for i in "\${!args[@]}"; do [ "\${args[$i]}" = "--region" ] && region="\${args[$((i + 1))]}"; done
case "$1 $2" in
  "sts get-caller-identity") echo "123456789012" ;;
  "ec2 describe-regions") echo "us-east-1 eu-central-1 us-west-2" ;;
  "cloudformation describe-stacks")
    case "$*" in
      *maple-metrics-abc*) case " $AWS_STACKS_IN " in *" $region "*) echo CREATE_COMPLETE ;; *) exit 254 ;; esac ;;
      *) echo CREATE_COMPLETE ;;
    esac ;;
  "cloudformation describe-stack-resource") echo "failed-deliveries-$region" ;;
  "cloudformation wait")
    if [ -n "$AWS_WAIT_FAILS" ] && [ ! -e "$AWS_LOG.waited" ]; then touch "$AWS_LOG.waited"; exit 255; fi ;;
esac
exit 0
`

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (script: string, env: { readonly stacksIn: ReadonlyArray<string>; readonly waitFails?: boolean }) => {
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
			AWS_STACKS_IN: env.stacksIn.join(" "),
			AWS_WAIT_FAILS: env.waitFails === true ? "1" : "",
		},
	})
	return {
		status: result.status,
		calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
	}
}

/** The calls that touch one region's metric stream stack or its bucket, in order. */
const metricsCalls = (calls: ReadonlyArray<string>, region: string) =>
	calls
		.filter((call) => call.includes(`--region ${region}`) && /s3 rm|delete-stack|wait stack-delete/u.test(call))
		.filter((call) => !call.includes(target.stackName))
		.map((call) =>
			call.startsWith("s3 rm") ? "empty bucket" : call.includes("delete-stack ") ? "delete" : "wait",
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
		// Regions without the stack are left alone, and the role's stack goes last.
		expect(metricsCalls(calls, "us-west-2")).toEqual([])
		expect(calls.at(-1)).toContain(`stack-delete-complete --region us-east-1 --stack-name ${target.stackName}`)
	})

	it("stops a cleanup that cannot delete a stream's stack, so the role that trusts Maple is not removed first", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const failing = FAKE_AWS.replace(
			`if [ -n "$AWS_WAIT_FAILS" ] && [ ! -e "$AWS_LOG.waited" ]; then touch "$AWS_LOG.waited"; exit 255; fi ;;`,
			"exit 255 ;;",
		)
		const dir = mkdtempSync(join(tmpdir(), "maple-aws-script-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "aws"), failing)
		chmodSync(join(dir, "aws"), 0o755)
		const log = join(dir, "aws.log")
		const result = spawnSync("bash", [], {
			input: cleanup,
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AWS_LOG: log, AWS_STACKS_IN: "eu-central-1" },
		})
		expect(result.status).not.toBe(0)
		expect(readFileSync(log, "utf8")).not.toContain(`delete-stack --region us-east-1 --stack-name ${target.stackName}`)
	})

	it("a setup without a stream removes the stream from every region that still has it", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null))
		const { status, calls } = run(setup, { stacksIn: ["us-east-1", "eu-central-1"] })
		expect(status).toBe(0)
		expect(metricsCalls(calls, "us-east-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "eu-central-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "us-west-2")).toEqual([])
	})
})
