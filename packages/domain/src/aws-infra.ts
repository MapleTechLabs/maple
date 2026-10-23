/**
 * The Infrastructure -> AWS page: one tab per resource kind, a row per resource. Rows read the
 * `aws.*` metrics the CloudWatch metric stream sends (see `apps/ingest/src/aws_metric_stream.rs`):
 * a statistic's mean is a gauge named after the metric, its sum the `.sum` delta counter.
 */

export const AWS_INFRA_KIND_IDS = ["ecs", "ec2", "loadBalancers", "rds", "lambda", "sqs"] as const
export type AwsInfraKindId = (typeof AWS_INFRA_KIND_IDS)[number]

export interface AwsInfraMetric {
	/** What the page calls it. */
	readonly key: string
	readonly name: string
	/** `gauge`: read as the mean of its points. `sum`: added up over the window. */
	readonly table: "gauge" | "sum"
}

export interface AwsInfraKind {
	readonly title: string
	/** One resource, in the tab's count and copy. */
	readonly noun: string
	/** One resource, as a page names what it shows: "ECS service". */
	readonly label: string
	/**
	 * What identifies a row, as column label and dimension. CloudWatch reports a metric once per
	 * dimension set, so a row reads only points that carry these and none of `excluded`.
	 */
	readonly identity: ReadonlyArray<readonly [label: string, dimension: string]>
	readonly excluded: ReadonlyArray<string>
	readonly metrics: ReadonlyArray<AwsInfraMetric>
	/** The metric a row's sparkline draws. */
	readonly sparkline: string
}

const gauge = (key: string, name: string): AwsInfraMetric => ({ key, name, table: "gauge" })
const sum = (key: string, name: string): AwsInfraMetric => ({ key, name: `${name}.sum`, table: "sum" })

export const AWS_INFRA_KINDS = {
	ecs: {
		title: "ECS",
		noun: "service",
		label: "ECS service",
		identity: [
			["Service", "service_name"],
			["Cluster", "cluster_name"],
		],
		excluded: [],
		metrics: [gauge("cpu", "aws.ecs.cpu_utilization"), gauge("memory", "aws.ecs.memory_utilization")],
		sparkline: "cpu",
	},
	ec2: {
		title: "EC2",
		noun: "instance",
		label: "EC2 instance",
		identity: [["Instance", "instance_id"]],
		excluded: [],
		metrics: [
			gauge("cpu", "aws.ec2.cpu_utilization"),
			sum("networkIn", "aws.ec2.network_in"),
			sum("networkOut", "aws.ec2.network_out"),
			gauge("statusFailed", "aws.ec2.status_check_failed"),
		],
		sparkline: "cpu",
	},
	loadBalancers: {
		title: "Load balancers",
		noun: "load balancer",
		label: "Load balancer",
		identity: [["Load balancer", "load_balancer"]],
		excluded: ["target_group", "availability_zone"],
		metrics: [
			sum("requests", "aws.application_elb.request_count"),
			sum("target5xx", "aws.application_elb.http_code_target_5xx_count"),
			sum("elb5xx", "aws.application_elb.http_code_elb_5xx_count"),
			gauge("responseTime", "aws.application_elb.target_response_time"),
		],
		sparkline: "requests",
	},
	rds: {
		title: "RDS",
		noun: "database",
		label: "RDS database",
		identity: [["Instance", "db_instance_identifier"]],
		excluded: [],
		metrics: [
			gauge("cpu", "aws.rds.cpu_utilization"),
			gauge("connections", "aws.rds.database_connections"),
			gauge("freeStorage", "aws.rds.free_storage_space"),
			gauge("freeMemory", "aws.rds.freeable_memory"),
		],
		sparkline: "cpu",
	},
	lambda: {
		title: "Lambda",
		noun: "function",
		label: "Lambda function",
		identity: [["Function", "function_name"]],
		excluded: ["resource", "executed_version"],
		metrics: [
			sum("invocations", "aws.lambda.invocations"),
			sum("errors", "aws.lambda.errors"),
			sum("throttles", "aws.lambda.throttles"),
			gauge("duration", "aws.lambda.duration"),
		],
		sparkline: "invocations",
	},
	sqs: {
		title: "SQS",
		noun: "queue",
		label: "SQS queue",
		identity: [["Queue", "queue_name"]],
		excluded: [],
		metrics: [
			gauge("visible", "aws.sqs.approximate_number_of_messages_visible"),
			gauge("oldestAge", "aws.sqs.approximate_age_of_oldest_message"),
			sum("sent", "aws.sqs.number_of_messages_sent"),
		],
		sparkline: "visible",
	},
} satisfies Record<AwsInfraKindId, AwsInfraKind>

/** The point attribute a dimension is stored under. */
export const awsDimensionAttribute = (dimension: string) => `aws.dimension.${dimension}`

/** A row's keys: its identity values in order, then region and account. */
export const AWS_INFRA_RESOURCE_KEYS = ["cloud.region", "cloud.account.id"] as const

export const awsInfraMetric = (kind: AwsInfraKindId, key: string) =>
	AWS_INFRA_KINDS[kind].metrics.find((metric) => metric.key === key)

export const AWS_INFRA_ROW_LIMIT = 10_000
