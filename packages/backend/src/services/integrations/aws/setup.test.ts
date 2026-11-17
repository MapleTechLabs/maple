import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Schema, Array as Arr, String as Str, Option, Order as Ord } from "effect"
import { AwsAccountId, AwsConnectionId } from "@maple/primitives"
import {
	renderAwsAuditCloudFormation,
	renderAwsAuditForwarderCloudFormation,
	renderAwsCleanupScript,
	renderAwsSetupScript,
} from "./setup"

const accountId = Schema.decodeSync(AwsAccountId)("123456789012")
const connectionId = Schema.decodeSync(AwsConnectionId)("0b3c2c64-9e5a-4f0e-9a39-5b1f7d1b2c3d")
const PROVIDER_ARN = "arn:aws:iam::123456789012:oidc-provider/api.maple.test/oidc/aws"
const target = {
	accountId,
	stackName: "maple-integration-abc",
	metricsStackName: "maple-metrics-abc",
	auditStackName: "maple-audit-abc",
	auditForwarderStackName: "maple-audit-fwd-abc",
	auditTrailName: "maple-0123456789abcdef01234567",
	oidcProvider: {
		arn: PROVIDER_ARN,
		url: "https://api.maple.test/oidc/aws",
		audience: "sts.amazonaws.com",
	},
}

// A fake `aws` that logs every call. Metric stream stacks exist in $AWS_STACKS_IN. The account has
// Maple's OIDC provider when $AWS_PROVIDER_EXISTS is set, and the roles in $AWS_ROLES_LEFT. The first wait
// fails with $AWS_WAIT_FAILS (Firehose wrote meanwhile); the first delete call with $AWS_DELETE_FAILS.
// CloudTrail feed stacks exist in $AWS_AUDIT_IN; the account's multi-region trails are $AWS_TRAILS, each
// logging as $AWS_TRAIL_LOGGING says ("fail": its status cannot be read) with the selector counts in
// $AWS_TRAIL_SELECTORS; listing them fails with $AWS_TRAILS_FAIL. A deploy to a region in
// $AWS_DEPLOY_FAILS_IN fails, and one in $AWS_DEPLOY_DENIED_IN is denied by an organization policy.
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
      *maple-audit-*) case " $AWS_AUDIT_IN " in *" $region "*) echo CREATE_COMPLETE ;; *) exit 254 ;; esac ;;
      *) echo CREATE_COMPLETE ;;
    esac ;;
  "cloudformation describe-stack-resource") echo "failed-deliveries-$region" ;;
  "cloudformation delete-stack")
    if [ -n "$AWS_DELETE_FAILS" ] && [ ! -e "$AWS_LOG.deleted" ]; then touch "$AWS_LOG.deleted"; exit 254; fi ;;
  "cloudtrail describe-trails") [ -n "$AWS_TRAILS_FAIL" ] && exit 254; echo "\${AWS_TRAILS:-None}" ;;
  "cloudtrail get-event-selectors") echo "\${AWS_TRAIL_SELECTORS:-1 0}" ;;
  "cloudtrail get-trail-status") [ "$AWS_TRAIL_LOGGING" = "fail" ] && exit 254; echo "$AWS_TRAIL_LOGGING" ;;
  "cloudformation deploy")
    case " $AWS_DEPLOY_FAILS_IN " in *" $region "*) echo "Template error in $region" >&2; exit 255 ;; esac
    case " $AWS_DEPLOY_DENIED_IN " in *" $region "*) echo "AccessDenied: explicit deny in a service control policy" >&2; exit 255 ;; esac ;;
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
		readonly auditIn?: ReadonlyArray<string>
		readonly trails?: string
		readonly trailLogging?: "True" | "False" | "fail"
		readonly deployFailsIn?: ReadonlyArray<string>
		readonly deployDeniedIn?: ReadonlyArray<string>
		readonly trailSelectors?: string
		readonly trailsFail?: boolean
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
			AWS_AUDIT_IN: Arr.join(env.auditIn ?? [], " "),
			AWS_TRAILS: env.trails ?? "",
			AWS_TRAIL_LOGGING: env.trailLogging ?? "True",
			AWS_DEPLOY_FAILS_IN: Arr.join(env.deployFailsIn ?? [], " "),
			AWS_DEPLOY_DENIED_IN: Arr.join(env.deployDeniedIn ?? [], " "),
			AWS_TRAIL_SELECTORS: env.trailSelectors ?? "",
			AWS_TRAILS_FAIL: env.trailsFail === true ? "1" : "",
		},
	})
	return {
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
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
			(call) => !Str.includes(target.stackName)(call) && !Str.includes("maple-audit-")(call),
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
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, null))
		const { status, calls } = run(setup, { stacksIn: ["us-east-1", "eu-central-1"] })
		expect(status).toBe(0)
		expect(metricsCalls(calls, "us-east-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "eu-central-1")).toEqual(["empty bucket", "delete", "wait"])
		expect(metricsCalls(calls, "us-west-2")).toEqual([])
	})

	it("registers Maple's identity provider only when the account lacks it, before the stack needs it", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, null))
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

const audit = {
	target: {
		endpoint: "https://ingest.maple.test/v1/firehose/aws/abc/audit",
		accessKey: "maple_aws_secret",
	},
	template: "{}\n",
	forwarderTemplate: "{}\n",
}

/** The `cloudformation deploy` calls of one stack, as `region:CreateTrail`, or the region alone. */
const deploys = (calls: ReadonlyArray<string>, stackName: string) =>
	Arr.flatMap(calls, (call) => {
		if (
			!Str.startsWith("cloudformation deploy")(call) ||
			!Str.includes(`--stack-name ${stackName} `)(call)
		)
			return []
		const region = /--region (\S+)/u.exec(call)?.[1] ?? ""
		const trail = /CreateTrail=(\S+)/u.exec(call)?.[1]
		return [trail === undefined ? region : `${region}:${trail}`]
	})

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const RuleTemplate = Schema.Struct({
	Resources: Schema.Record(
		Schema.String,
		Schema.Struct({
			Properties: Schema.optionalKey(
				Schema.Struct({
					EventPattern: Schema.optionalKey(Schema.Unknown),
					Targets: Schema.optionalKey(Schema.Array(Schema.Struct({ Arn: Schema.Unknown }))),
				}),
			),
		}),
	),
})
const ruleOf = (template: string, rule: string) =>
	Schema.decodeUnknownSync(RuleTemplate)(decodeJson(template)).Resources[rule]?.Properties

describe("AWS CloudTrail feed setup", () => {
	it("deploys the feed to us-east-1 and a forwarder to every other enabled region", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, audit))
		const { status, calls } = run(setup, {
			stacksIn: [],
			trails: "arn:aws:cloudtrail:us-east-1:123456789012:trail/org",
		})
		expect(status).toBe(0)
		expect(deploys(calls, target.auditStackName)).toEqual(["us-east-1:false"])
		expect(Arr.sort(deploys(calls, target.auditForwarderStackName), Ord.string)).toEqual([
			"eu-central-1",
			"us-west-2",
		])
		// The access key reaches the feed's Firehose and nothing else.
		expect(Arr.filter(calls, (call) => Str.includes("maple_aws_secret")(call)).length).toBe(1)
	})

	it("creates a trail only when no other multi-region trail logs", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, audit))
		const trailFor = (env: {
			readonly trails?: string
			readonly trailLogging?: "True" | "False" | "fail"
			readonly trailSelectors?: string
		}) => deploys(run(setup, { stacksIn: [], ...env }).calls, target.auditStackName)

		expect(trailFor({})).toEqual(["us-east-1:true"])
		expect(
			trailFor({
				trails: "arn:aws:cloudtrail:eu-west-1:123456789012:trail/main",
				trailLogging: "False",
			}),
		).toEqual(["us-east-1:true"])
		// Its own trail from an earlier run does not count, or a re-run would delete it.
		expect(
			trailFor({
				trails: "arn:aws:cloudtrail:us-east-1:123456789012:trail/maple-0123456789abcdef01234567",
			}),
		).toEqual(["us-east-1:true"])
		// Nor does another Maple connection's: it goes when that connection does.
		expect(
			trailFor({
				trails: "arn:aws:cloudtrail:us-east-1:123456789012:trail/maple-fedcba9876543210fedcba98",
			}),
		).toEqual(["us-east-1:true"])
		// A trail that records only reads sends EventBridge no changes; advanced selectors are trusted.
		const main = "arn:aws:cloudtrail:us-east-1:123456789012:trail/main"
		expect(trailFor({ trails: main, trailSelectors: "0 0" })).toEqual(["us-east-1:true"])
		expect(trailFor({ trails: main, trailSelectors: "0 2" })).toEqual(["us-east-1:false"])
		// An organization trail a member account cannot read is assumed to log: no second, billed trail.
		expect(
			trailFor({ trails: "arn:aws:cloudtrail:us-east-1:999999999999:trail/org", trailLogging: "fail" }),
		).toEqual(["us-east-1:false"])
	})

	it("names a region whose forwarder failed, with its error, and fails the script", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, audit))
		const { status, stderr } = run(setup, { stacksIn: [], deployFailsIn: ["us-west-2"] })
		expect(status).not.toBe(0)
		expect(stderr).toContain("Deploying the CloudTrail forwarder to us-west-2 failed")
		expect(stderr).toContain("Template error in us-west-2")
		expect(stderr).not.toContain("eu-central-1")
	})

	it("skips a region an organization policy denies, and stops when the trails cannot be listed", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, audit))
		const denied = run(setup, { stacksIn: [], deployDeniedIn: ["us-west-2"] })
		expect(denied.status).toBe(0)
		expect(denied.stdout).toContain(
			"Skipped regions this account may not deploy to (an organization policy denies them): us-west-2",
		)

		// Read as "no trails", a failed listing would add a second, billed trail.
		const unlisted = run(setup, { stacksIn: [], trailsFail: true })
		expect(unlisted.status).not.toBe(0)
		expect(deploys(unlisted.calls, target.auditStackName)).toEqual([])
	})

	it("a setup without the feed removes its stacks from every region that has them", () => {
		const setup = Effect.runSync(renderAwsSetupScript(target, "{}\n", null, null))
		const { status, calls } = run(setup, { stacksIn: [], auditIn: ["us-east-1", "eu-central-1"] })
		expect(status).toBe(0)
		expect(Arr.filter(calls, (call) => Str.startsWith("cloudformation delete-stack")(call))).toEqual([
			"cloudformation delete-stack --region us-east-1 --stack-name maple-audit-fwd-abc",
			"cloudformation delete-stack --region eu-central-1 --stack-name maple-audit-fwd-abc",
			"cloudformation delete-stack --region us-east-1 --stack-name maple-audit-abc",
			"cloudformation delete-stack --region eu-central-1 --stack-name maple-audit-abc",
		])
		expect(deploys(calls, target.auditStackName)).toEqual([])
	})

	it("the cleanup removes the feed before the role that trusts Maple", () => {
		const cleanup = Effect.runSync(renderAwsCleanupScript(target))
		const { status, calls } = run(cleanup, { stacksIn: [], auditIn: ["us-east-1"] })
		expect(status).toBe(0)
		const index = (needle: string) =>
			Option.getOrElse(
				Arr.findFirstIndex(calls, (call) => Str.includes(needle)(call)),
				() => -1,
			)
		const feedDeleted = index("delete-stack --region us-east-1 --stack-name maple-audit-abc")
		expect(feedDeleted).toBeGreaterThan(-1)
		expect(index(`delete-stack --region us-east-1 --stack-name ${target.stackName}`)).toBeGreaterThan(
			feedDeleted,
		)
	})

	it("forwards every other region's events to the bus whose rule sends the same events to Maple", () => {
		const home = renderAwsAuditCloudFormation(
			connectionId,
			{ streamName: "maple-audit-abc", trailName: "maple-abc" },
			audit.target.endpoint,
		)
		const forwarder = renderAwsAuditForwarderCloudFormation(connectionId, "maple-audit-abc")
		expect(ruleOf(home, "AuditRule")?.Targets).toEqual([
			{ Arn: { "Fn::GetAtt": ["DeliveryStream", "Arn"] } },
		])
		expect(ruleOf(forwarder, "ForwardRule")?.Targets).toEqual([
			{
				Arn: {
					"Fn::Sub": "arn:${AWS::Partition}:events:us-east-1:${AWS::AccountId}:event-bus/default",
				},
			},
		])
		// A forwarded event the home rule did not match would be dropped there.
		expect(ruleOf(forwarder, "ForwardRule")?.EventPattern).toEqual(
			ruleOf(home, "AuditRule")?.EventPattern,
		)
	})
})
