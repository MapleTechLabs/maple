import { Schema } from "effect"
import { type AwsAccountId, type AwsConnectionId, AwsModule } from "./primitives"

const isAwsModule = Schema.is(AwsModule)

/**
 * Bumped whenever the setup's IAM shape changes. The role carries it as a tag, so a connection
 * whose stack predates a change says "update the stack" instead of failing a read.
 */
export const AWS_TEMPLATE_VERSION = 1

/** Tag keys the stack puts on the role; the connection check reads them back. */
export const AWS_ROLE_TAGS = {
	templateVersion: "maple:template-version",
	connectionId: "maple:connection-id",
} as const

interface AwsModuleSpec {
	readonly title: string
	/** What the module lets Maple do, in one line for the connect card. */
	readonly summary: string
	/** Whether Maple reads anything with it yet. A planned module is not offered. */
	readonly available: boolean
	/** AWS managed policies attached when the module is on. Metadata only: never data reads. */
	readonly managedPolicies: ReadonlyArray<string>
	/** Actions of the module's own policy, beyond the managed ones. */
	readonly actions: ReadonlyArray<string>
}

/**
 * What each module grants. The setup is generated from this table, and the connection check reads
 * which module policies are attached, so a module and its permissions never drift apart.
 */
export const AWS_MODULE_SPECS = {
	observability: {
		title: "Metrics and logs",
		summary: "CloudWatch metrics and log groups of your AWS resources.",
		available: false,
		managedPolicies: [],
		actions: [
			"cloudwatch:GetMetricData",
			"cloudwatch:ListMetrics",
			"cloudwatch:DescribeAlarms",
			"logs:DescribeLogGroups",
			"tag:GetResources",
		],
	},
	inventory: {
		title: "Resource inventory",
		summary: "What runs in the account and how it connects, matched to your services.",
		available: false,
		managedPolicies: ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"],
		actions: ["resource-explorer-2:ListIndexes", "resource-explorer-2:Search", "tag:GetResources"],
	},
	security: {
		title: "Security scan",
		summary: "Misconfigurations and findings, ranked by the traffic they are exposed to.",
		available: false,
		managedPolicies: ["arn:aws:iam::aws:policy/SecurityAudit"],
		actions: [
			"securityhub:GetFindings",
			"guardduty:ListDetectors",
			"guardduty:ListFindings",
			"guardduty:GetFindings",
			"inspector2:ListFindings",
			"access-analyzer:ListFindingsV2",
		],
	},
	cost: {
		title: "Cost",
		summary: "Spend by service and resource, and what to cut.",
		available: false,
		managedPolicies: [],
		actions: [
			"ce:GetCostAndUsage",
			"ce:GetCostForecast",
			"compute-optimizer:GetEnrollmentStatus",
			"compute-optimizer:GetEC2InstanceRecommendations",
			"bcm-data-exports:ListExports",
			"bcm-data-exports:GetExport",
		],
	},
} as const satisfies Record<AwsModule, AwsModuleSpec>

export const isAwsModuleAvailable = (module: AwsModule) => AWS_MODULE_SPECS[module].available

/** Every connection's role starts with it; Maple's own identity may assume only these roles. */
export const AWS_ROLE_NAME_PREFIX = "MapleIntegration-"

/**
 * Names of what a connection's setup creates in the customer's account. Derived from the
 * connection id alone, so a caller can never pick the role Maple assumes.
 */
export const awsConnectionResourceNames = (connectionId: AwsConnectionId) => {
	const hex = connectionId.replaceAll("-", "").slice(0, 24)
	const name = `${AWS_ROLE_NAME_PREFIX}${hex}`
	return {
		roleName: name,
		stackName: `maple-integration-${hex}`,
		/** The customer managed policy of one module. */
		modulePolicyName: (module: AwsModule) => `${name}-${module}`,
		/** What Maple names its sessions on the role, as CloudTrail shows them. */
		sessionName: `maple-${hex}`,
	}
}

export const awsRoleArn = (accountId: AwsAccountId, roleName: string) =>
	`arn:aws:iam::${accountId}:role/${roleName}`

/** The IAM identity Maple assumes customer roles as: an ARN in Maple's own account. */
export interface AwsMaplePrincipal {
	readonly arn: string
	readonly accountId: string
}

/** `arn:aws:iam::123456789012:user/maple` as a principal, or undefined for anything else. */
export const parseAwsMaplePrincipal = (arn: string): AwsMaplePrincipal | undefined => {
	const accountId = /^arn:aws:iam::([0-9]{12}):(user|role)\/[\w+=,.@/-]+$/u.exec(arn)?.[1]
	return accountId === undefined ? undefined : { arn, accountId }
}

/** Which module a customer managed policy name stands for, given the connection's role name. */
export const awsModuleOfPolicyName = (roleName: string, policyName: string): AwsModule | undefined => {
	const prefix = `${roleName}-`
	if (!policyName.startsWith(prefix)) return undefined
	const rest = policyName.slice(prefix.length)
	return isAwsModule(rest) ? rest : undefined
}

export interface AwsSetupPlanInput {
	readonly connectionId: AwsConnectionId
	readonly accountId: AwsAccountId
	readonly externalId: string
	readonly maplePrincipal: AwsMaplePrincipal
	readonly modules: ReadonlyArray<AwsModule>
}

interface IamStatement {
	readonly Effect: "Allow"
	readonly Action: string | ReadonlyArray<string>
	readonly Resource?: string | ReadonlyArray<string>
	readonly Principal?: { readonly AWS: string }
	readonly Condition?: Record<string, Record<string, string>>
}

interface IamDocument {
	readonly Version: "2012-10-17"
	readonly Statement: ReadonlyArray<IamStatement>
}

export interface AwsSetupPlan {
	readonly roleName: string
	readonly stackName: string
	readonly roleArn: string
	readonly trustPolicy: IamDocument
	/** Lets the role read its own tags and attached policies: how Maple checks the setup. */
	readonly selfReadPolicy: IamDocument
	readonly modules: ReadonlyArray<{
		readonly module: AwsModule
		readonly policyName: string
		readonly managedPolicies: ReadonlyArray<string>
		readonly policy: IamDocument
	}>
	readonly tags: ReadonlyArray<{ readonly Key: string; readonly Value: string }>
}

/** Everything the setup creates, as data. The CloudFormation and Terraform renderings read it. */
export const awsSetupPlan = (input: AwsSetupPlanInput): AwsSetupPlan => {
	const names = awsConnectionResourceNames(input.connectionId)
	const roleArn = awsRoleArn(input.accountId, names.roleName)
	return {
		roleName: names.roleName,
		stackName: names.stackName,
		roleArn,
		// Maple's account is the principal and the condition names the exact identity: an IAM user
		// recreated under the same name still matches, which a principal ARN alone would not.
		trustPolicy: {
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Principal: { AWS: `arn:aws:iam::${input.maplePrincipal.accountId}:root` },
					Action: "sts:AssumeRole",
					Condition: {
						StringEquals: { "sts:ExternalId": input.externalId },
						ArnEquals: { "aws:PrincipalArn": input.maplePrincipal.arn },
					},
				},
			],
		},
		selfReadPolicy: {
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: ["iam:GetRole", "iam:ListAttachedRolePolicies"],
					Resource: roleArn,
				},
			],
		},
		modules: input.modules.map((module) => {
			const spec = AWS_MODULE_SPECS[module]
			return {
				module,
				policyName: names.modulePolicyName(module),
				managedPolicies: spec.managedPolicies,
				policy: {
					Version: "2012-10-17",
					Statement: [{ Effect: "Allow", Action: [...spec.actions].sort(), Resource: "*" }],
				},
			}
		}),
		tags: [
			{ Key: AWS_ROLE_TAGS.templateVersion, Value: String(AWS_TEMPLATE_VERSION) },
			{ Key: AWS_ROLE_TAGS.connectionId, Value: input.connectionId },
		],
	}
}
