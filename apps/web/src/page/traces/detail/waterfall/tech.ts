import { dbSystemAccentClass } from "@maple/ui/lib/cloud-platforms/accents"
import { getDbStyle } from "@maple/ui/components/service-map/service-map-db-style"
import { pickAttr } from "../../../../service-map/trace-flow/cloud-platforms"
import { DB_ICON } from "../../../../service-map/map/node-card"
import { resolveRuntimeGlyph } from "../../../../service-map/map/runtime"
import type { IconName } from "../../../../ui/icon"
import { modelVendorIcon } from "../../../agent-sessions/kit/vendor"

// The marks a waterfall row carries: what the span called (gen_ai, then db, messaging, rpc,
// the order Jaeger and Uptrace settle on) and what runs the service it enters.

export interface Mark {
	readonly icon: IconName
	readonly label: string
	/** Tint for single-colour glyphs; empty for brand marks that carry their own colours. */
	readonly className: string
}

const MUTED = "text-muted-foreground"

/** `pickAttr`, trimmed and lowercased for the lookups below. */
const systemOf = (attrs: Record<string, string>, ...keys: ReadonlyArray<string>): string | null =>
	pickAttr(attrs, ...keys)
		?.trim()
		.toLowerCase() ?? null

const titleCase = (system: string): string =>
	system
		.split(/[._\s-]+/)
		.filter((word) => word !== "")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")

// `gen_ai.provider.name` values (and the older `gen_ai.system`): the `modelVendorIcon` slug and
// the name a reader knows. Anything else keeps its own value as the slug.
const GEN_AI_PROVIDERS = new Map<string, Readonly<{ vendor: string; label: string }>>([
	["anthropic", { vendor: "anthropic", label: "Anthropic" }],
	["openai", { vendor: "openai", label: "OpenAI" }],
	["openrouter", { vendor: "openrouter", label: "OpenRouter" }],
	["cohere", { vendor: "cohere", label: "Cohere" }],
	["deepseek", { vendor: "deepseek", label: "DeepSeek" }],
	["perplexity", { vendor: "perplexity", label: "Perplexity" }],
	["groq", { vendor: "groq", label: "Groq" }],
	["mistral_ai", { vendor: "mistralai", label: "Mistral" }],
	["x_ai", { vendor: "x-ai", label: "xAI" }],
	["xai", { vendor: "x-ai", label: "xAI" }],
	["aws.bedrock", { vendor: "amazon", label: "AWS Bedrock" }],
	["azure.ai.inference", { vendor: "microsoft", label: "Azure AI" }],
	["az.ai.inference", { vendor: "microsoft", label: "Azure AI" }],
	["azure.ai.openai", { vendor: "microsoft", label: "Azure OpenAI" }],
	["az.ai.openai", { vendor: "microsoft", label: "Azure OpenAI" }],
	["gcp.gemini", { vendor: "google", label: "Gemini" }],
	["gemini", { vendor: "google", label: "Gemini" }],
	["gcp.gen_ai", { vendor: "google", label: "Google Gen AI" }],
	["gcp.vertex_ai", { vendor: "google", label: "Vertex AI" }],
	["vertex_ai", { vendor: "google", label: "Vertex AI" }],
	["ibm.watsonx.ai", { vendor: "ibm-granite", label: "watsonx" }],
])

const genAi = (attrs: Record<string, string>): Mark | null => {
	const provider = systemOf(attrs, "gen_ai.provider.name", "gen_ai.system")
	if (provider === null) return null
	const known = GEN_AI_PROVIDERS.get(provider)
	return {
		icon: modelVendorIcon({ vendorSlug: known?.vendor ?? provider, family: null }),
		label: `LLM call · ${known?.label ?? titleCase(provider)}`,
		className: MUTED,
	}
}

const database = (attrs: Record<string, string>): Mark | null => {
	const system = systemOf(attrs, "db.system.name", "db.system")
	if (system === null) return null
	const style = getDbStyle(system)
	return {
		icon: DB_ICON[style.icon],
		label: style.label,
		className: style.branded ? "" : dbSystemAccentClass(system),
	}
}

const MESSAGING_ICONS = new Map<string, IconName>([
	["kafka", "KafkaIcon"],
	["nats", "NatsIcon"],
	["rabbitmq", "RabbitmqIcon"],
	["gcp_pubsub", "GooglePubSubIcon"],
	["aws_sqs", "AwsIcon"],
	["aws.sqs", "AwsIcon"],
	["aws_sns", "AwsIcon"],
	["aws.sns", "AwsIcon"],
	["cloudflare_queues", "CloudflareBrandIcon"],
])

const MESSAGING_LABELS = new Map([
	["kafka", "Kafka"],
	["nats", "NATS"],
	["rabbitmq", "RabbitMQ"],
	["gcp_pubsub", "Pub/Sub"],
	["aws_sqs", "SQS"],
	["aws.sqs", "SQS"],
	["aws_sns", "SNS"],
	["aws.sns", "SNS"],
	["cloudflare_queues", "Cloudflare Queues"],
])

const messaging = (attrs: Record<string, string>): Mark | null => {
	const system = systemOf(attrs, "messaging.system")
	if (system === null) return null
	const icon = MESSAGING_ICONS.get(system)
	return {
		icon: icon ?? "PaperPlaneIcon",
		label: MESSAGING_LABELS.get(system) ?? titleCase(system),
		className: icon === undefined || icon === "KafkaIcon" ? MUTED : "",
	}
}

const RPC_LABELS = new Map([
	["grpc", "gRPC"],
	["connect_rpc", "Connect RPC"],
	["jsonrpc", "JSON-RPC"],
	["java_rmi", "Java RMI"],
	["dotnet_wcf", "WCF"],
	["apache_dubbo", "Dubbo"],
	["aws-api", "AWS API"],
])

const rpc = (attrs: Record<string, string>): Mark | null => {
	const system = systemOf(attrs, "rpc.system")
	if (system === null) return null
	const isAws = system === "aws-api"
	return {
		icon: isAws ? "AwsIcon" : "ConnectionIcon",
		label: RPC_LABELS.get(system) ?? titleCase(system),
		className: isAws ? "" : MUTED,
	}
}

/** What this span called, from its own attributes; null when it names no system. */
export const spanTech = (attrs: Record<string, string>): Mark | null =>
	genAi(attrs) ?? database(attrs) ?? messaging(attrs) ?? rpc(attrs)

const EFFECT_SDKS = new Set(["effect", "@maple-dev/effect-sdk"])

const glyphOf = (resource: Record<string, string>, key: string) => {
	const name = pickAttr(resource, key)
	return name === null ? null : resolveRuntimeGlyph(name)
}

/**
 * What runs the service, from its resource: the Effect mark when the Effect SDK reported the
 * span, else the runtime (`process.runtime.name`, then `telemetry.sdk.language` when the
 * runtime is missing or has no glyph); null when neither has one.
 */
export const serviceRuntime = (resource: Record<string, string>): Mark | null => {
	const named = glyphOf(resource, "process.runtime.name")
	const runtime =
		named === null || named.icon === null ? (glyphOf(resource, "telemetry.sdk.language") ?? named) : named
	const sdk = systemOf(resource, "telemetry.sdk.name")
	if (sdk !== null && EFFECT_SDKS.has(sdk))
		return {
			icon: "EffectIcon",
			label: runtime === null ? "Effect" : `Effect on ${runtime.full}`,
			className: "text-foreground",
		}
	if (runtime === null || runtime.icon === null) return null
	return { icon: runtime.icon, label: runtime.full, className: MUTED }
}
