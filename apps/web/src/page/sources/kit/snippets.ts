import type { SourcePlatform } from "@maple/domain/primitives"
import { type FrameworkId, sdkSnippets } from "../../../components/quick-start/sdk-snippets"
import { ingestUrl } from "../../../lib/services/common/ingest-url"
import { dockerCommand, HOST_CONFIG, helmCommand, hostCommand } from "../../infra/kit/install-snippets"

// `sourceSnippets`, `maskedToken`.

export interface SourceSnippet {
	readonly id: string
	readonly label: string
	readonly language: string
	readonly code: string
}

const envSnippet = (token: string, serviceName: string): SourceSnippet => ({
	id: "env",
	label: "Environment",
	language: "shell",
	code: [
		`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
		`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${token}"`,
		`export OTEL_SERVICE_NAME="${serviceName}"`,
	].join("\n"),
})

const collectorSnippet = (token: string): SourceSnippet => ({
	id: "collector",
	label: "Collector",
	language: "yaml",
	code: `exporters:\n  otlphttp/maple:\n    endpoint: ${ingestUrl}\n    headers:\n      Authorization: "Bearer ${token}"`,
})

// Reuses the quick-start SDK snippets for the languages that have one.
const sdkFramework = (platform: SourcePlatform): FrameworkId | null =>
	platform === "nodejs" || platform === "python" || platform === "go" ? platform : null

const sdkSnippet = (platform: SourcePlatform, token: string): SourceSnippet | null => {
	const framework = sdkFramework(platform)
	const snippet = sdkSnippets.find((entry) => entry.language === framework)
	if (framework === null || snippet === undefined) return null
	return {
		id: "sdk",
		label: `${snippet.label} SDK`,
		language: framework === "python" ? "python" : framework === "go" ? "go" : "typescript",
		code: snippet.instrument.replace(/\{\{INGEST_URL\}\}/g, ingestUrl).replace(/\{\{API_KEY\}\}/g, token),
	}
}

const browserSnippet = (token: string): SourceSnippet => ({
	id: "browser",
	label: "Browser SDK",
	language: "typescript",
	code: `import { MapleBrowser } from "@maple-dev/browser"\n\nMapleBrowser.init({\n  ingestKey: "${token}",\n  endpoint: "${ingestUrl}",\n})`,
})

const claudeCodeSnippet = (token: string): SourceSnippet => ({
	id: "claude-code",
	label: "Claude Code",
	language: "shell",
	code: [
		"export CLAUDE_CODE_ENABLE_TELEMETRY=1",
		"export OTEL_LOGS_EXPORTER=otlp",
		"export OTEL_METRICS_EXPORTER=otlp",
		"export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
		`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${token}"`,
	].join("\n"),
})

/** The service name the env snippet suggests: the source name, slugged. */
const serviceNameOf = (name: string): string =>
	name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "my-service"

/**
 * Setup snippets for a push platform, most specific first. `token` is the full token right
 * after create or roll, otherwise a masked placeholder built from the prefix.
 */
export const sourceSnippets = (platform: SourcePlatform, token: string, name: string): ReadonlyArray<SourceSnippet> => {
	const serviceName = serviceNameOf(name)
	switch (platform) {
		case "kubernetes":
			return [{ id: "helm", label: "Helm", language: "shell", code: helmCommand(token) }]
		case "docker":
			return [{ id: "docker", label: "docker run", language: "shell", code: dockerCommand(token) }]
		case "host":
			return [
				{ id: "host-config", label: "config.yaml", language: "yaml", code: HOST_CONFIG },
				{ id: "host-run", label: "Run", language: "shell", code: hostCommand(token) },
			]
		case "browser":
			return [browserSnippet(token)]
		case "claude_code":
			return [claudeCodeSnippet(token)]
		case "opentelemetry":
		case "cloudflare_ai_gateway":
			return [envSnippet(token, serviceName), collectorSnippet(token)]
		default: {
			const sdk = sdkSnippet(platform, token)
			return sdk === null ? [envSnippet(token, serviceName)] : [envSnippet(token, serviceName), sdk]
		}
	}
}

/** Stands in for the token once it can no longer be shown. */
export const maskedToken = (prefix: string | null): string => `${prefix ?? "maple_src_"}${"•".repeat(16)}`
