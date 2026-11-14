import { describe, expect, it } from "vitest"
import { Array as Arr, Schema } from "effect"
import { awsOidcSubject, awsSetupPlan } from "@maple/domain/aws"
import { AWS_MODULES, AwsAccountId, AwsConnectionId } from "@maple/primitives"

const accountId = Schema.decodeSync(AwsAccountId)("123456789012")
const connectionId = Schema.decodeSync(AwsConnectionId)("8f14e45f-ceea-467a-9a3c-2b1f5e8d6c01")
const issuer = "https://api.maple.test/oidc/aws"

// Every module on: the widest role a customer can deploy.
const plan = awsSetupPlan({ connectionId, accountId, issuer, modules: AWS_MODULES })

const actionsOf = (statement: { readonly Action: string | ReadonlyArray<string> }) =>
	typeof statement.Action === "string" ? [statement.Action] : statement.Action

const granted = [
	...Arr.flatMap(plan.selfReadPolicy.Statement, actionsOf),
	...Arr.flatMap(plan.modules, (module) => Arr.flatMap(module.policy.Statement, actionsOf)),
]

// AWS names reads with these verbs; any other verb (Put, Create, Pass, Invoke...) can change the account.
const READ_VERB = /^[a-z0-9-]+:(Get|List|Describe|Search|BatchGet)[A-Za-z0-9]*$/

describe("the role Maple assumes in a customer account", () => {
	it("grants only read actions, none of them wildcards, with every module on", () => {
		expect(Arr.filter(granted, (action) => !READ_VERB.test(action))).toEqual([])
	})

	it("attaches only AWS managed policies that are read-only by design", () => {
		const managed = Arr.flatMap(plan.modules, (module) => module.managedPolicies)
		expect(
			Arr.filter(
				managed,
				(arn) =>
					!/^arn:aws:iam::aws:policy\/(.+\/)?(ViewOnlyAccess|SecurityAudit|[A-Za-z]*ReadOnly[A-Za-z]*)$/.test(
						arn,
					),
			),
		).toEqual([])
	})

	it("trusts only web identity tokens for this one connection", () => {
		expect(plan.trustPolicy.Statement).toHaveLength(1)
		for (const statement of plan.trustPolicy.Statement) {
			expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity")
			expect(statement.Principal?.Federated).toBe(plan.oidcProvider.arn)
			expect(statement.Condition?.StringEquals).toEqual({
				"api.maple.test/oidc/aws:aud": "sts.amazonaws.com",
				"api.maple.test/oidc/aws:sub": awsOidcSubject(connectionId),
			})
		}
	})
})
