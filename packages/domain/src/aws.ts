import { Schema } from "effect"
import {
	type AwsAccountId,
	type AwsConnectionId,
	AwsMetricNamespace,
	AwsModule,
	AwsRegion,
} from "./primitives"

const isAwsModule = Schema.is(AwsModule)

/**
 * Bumped whenever the setup's IAM shape changes. The role carries it as a tag, so a connection
 * whose stack predates a change says "update the stack" instead of failing a read.
 */
export const AWS_TEMPLATE_VERSION = 2

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

/** Every connection's role starts with it. The cleanup keeps the OIDC provider while one is left. */
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
		/** The stack of one region's metric stream; the same name in every region it runs in. */
		metricsStackName: `maple-metrics-${hex}`,
		metricStreamName: `maple-${hex}`,
	}
}

/**
 * A connection's CloudWatch metric stream. Streams are regional, so the setup deploys one stack
 * per region, each sending these namespaces to Maple through Firehose.
 */
export const AwsMetricStream = Schema.Struct({
	regions: Schema.Array(AwsRegion).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
	namespaces: Schema.Array(AwsMetricNamespace).check(Schema.isMinLength(1)),
})
export type AwsMetricStream = Schema.Schema.Type<typeof AwsMetricStream>

export const awsRoleArn = (accountId: AwsAccountId, roleName: string) =>
	`arn:aws:iam::${accountId}:role/${roleName}`

/** The audience of Maple's tokens: what the customer's OIDC provider lists as its client id. */
export const AWS_OIDC_AUDIENCE = "sts.amazonaws.com"

/** The issuer customer accounts trust: `{api}/oidc/aws`. It is permanent once an account trusts it. */
export const awsOidcIssuer = (apiBaseUrl: string) => {
	// A scan, not a `/\/+$/` regex: that one backtracks on a long run of slashes.
	let end = apiBaseUrl.length
	while (end > 0 && apiBaseUrl[end - 1] === "/") end--
	return `${apiBaseUrl.slice(0, end)}/oidc/aws`
}

/** The `sub` of a connection's tokens, the one value its role's trust policy accepts. */
export const awsOidcSubject = (connectionId: AwsConnectionId) => `aws-connection:${connectionId}`

/** The issuer as IAM names it: without its scheme, in provider ARNs and condition keys. */
const issuerHostPath = (issuer: string) => issuer.replace(/^https:\/\//u, "")

export const awsOidcProviderArn = (accountId: AwsAccountId, issuer: string) =>
	`arn:aws:iam::${accountId}:oidc-provider/${issuerHostPath(issuer)}`

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
	/** Maple's OIDC issuer, from {@link awsOidcIssuer}. */
	readonly issuer: string
	readonly modules: ReadonlyArray<AwsModule>
}

interface IamStatement {
	readonly Effect: "Allow"
	readonly Action: string | ReadonlyArray<string>
	readonly Resource?: string | ReadonlyArray<string>
	readonly Principal?: { readonly Federated: string }
	readonly Condition?: Record<string, Record<string, string>>
}

interface IamDocument {
	readonly Version: "2012-10-17"
	readonly Statement: ReadonlyArray<IamStatement>
}

export interface AwsSetupPlan {
	readonly roleName: string
	readonly stackName: string
	readonly metricsStackName: string
	readonly metricStreamName: string
	readonly roleArn: string
	/** The account's IAM OIDC provider for Maple's issuer, shared by every connection to it. */
	readonly oidcProvider: { readonly arn: string; readonly url: string; readonly audience: string }
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
	const providerArn = awsOidcProviderArn(input.accountId, input.issuer)
	const issuer = issuerHostPath(input.issuer)
	return {
		roleName: names.roleName,
		stackName: names.stackName,
		metricsStackName: names.metricsStackName,
		metricStreamName: names.metricStreamName,
		roleArn,
		oidcProvider: { arn: providerArn, url: input.issuer, audience: AWS_OIDC_AUDIENCE },
		// Only a token Maple signed for this connection: the audience every Maple token carries,
		// and the subject no other connection's token has.
		trustPolicy: {
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Principal: { Federated: providerArn },
					Action: "sts:AssumeRoleWithWebIdentity",
					Condition: {
						StringEquals: {
							[`${issuer}:aud`]: AWS_OIDC_AUDIENCE,
							[`${issuer}:sub`]: awsOidcSubject(input.connectionId),
						},
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
