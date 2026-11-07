import type { SourcePlatform } from "@maple/domain/primitives"
import {
	type FrameworkId,
	fillSnippet,
	HTTP_PROTOCOL_LINE,
	type SdkSnippet,
	sdkSnippets,
} from "../../../components/quick-start/sdk-snippets"
import { ingestUrl } from "../../../lib/services/common/ingest-url"
import { dockerCommand, HOST_CONFIG, helmCommand, hostCommand } from "../../infra/kit/install-snippets"
import { Array as Arr, String as Str, Option } from "effect"

// `sourceSnippets`, `maskedToken`.

export interface SourceSnippet {
	readonly id: string
	readonly label: string
	readonly language: string
	readonly code: string
}

const envSnippet = (token: string, serviceName: string, needsHttp = false): SourceSnippet => ({
	id: "env",
	label: "Environment",
	language: "shell",
	code: Arr.join(
		[
			`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
			`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${token}"`,
			`export OTEL_SERVICE_NAME="${serviceName}"`,
			...(needsHttp ? [HTTP_PROTOCOL_LINE] : []),
		],
		"\n",
	),
})

const collectorSnippet = (token: string): SourceSnippet => ({
	id: "collector",
	label: "Collector",
	language: "yaml",
	code: `exporters:\n  otlphttp/maple:\n    endpoint: ${ingestUrl}\n    headers:\n      Authorization: "Bearer ${token}"`,
})

// Reuses the quick-start SDK setups for the languages that have one: install, then run. They read
// the env snippet above.
const sdkFramework = (platform: SourcePlatform): FrameworkId | null =>
	platform === "nodejs" || platform === "python" || platform === "go" ? platform : null

const sdkOf = (platform: SourcePlatform): SdkSnippet | null => {
	const framework = sdkFramework(platform)
	return framework === null
		? null
		: Option.getOrNull(Arr.findFirst(sdkSnippets, (entry) => entry.language === framework))
}

const setupSnippets = (snippet: SdkSnippet, token: string): ReadonlyArray<SourceSnippet> => [
	{
		id: "install",
		label: "Install",
		language: "shell",
		code:
			typeof snippet.install === "string"
				? snippet.install
				: `npm install ${Arr.join(snippet.install.packages, " ")}`,
	},
	{
		id: "sdk",
		label: snippet.code.label === "Run" ? `Run with the ${snippet.label} SDK` : snippet.code.label,
		language: snippet.code.lang,
		code: fillSnippet(snippet.code.code, ingestUrl, token),
	},
]

const browserSnippet = (token: string, serviceName: string): SourceSnippet => ({
	id: "browser",
	label: "Browser SDK",
	language: "typescript",
	code: `import { MapleBrowser } from "@maple-dev/browser"\n\nMapleBrowser.init({\n  ingestKey: "${token}",\n  endpoint: "${ingestUrl}",\n  serviceName: "${serviceName}",\n})`,
})

const claudeCodeSnippet = (token: string): SourceSnippet => ({
	id: "claude-code",
	label: "Claude Code",
	language: "shell",
	code: Arr.join(
		[
			"export CLAUDE_CODE_ENABLE_TELEMETRY=1",
			"export OTEL_LOGS_EXPORTER=otlp",
			"export OTEL_METRICS_EXPORTER=otlp",
			"export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
			`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
			`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${token}"`,
		],
		"\n",
	),
})

/** The service name the env snippet suggests: the source name, slugged. */
const serviceNameOf = (name: string): string =>
	Str.replace(/^-|-$/g, "")(Str.replace(/[^a-z0-9]+/g, "-")(Str.toLowerCase(Str.trim(name)))) ||
	"my-service"

/**
 * Setup snippets for a push platform, most specific first. `token` is the full token right
 * after create or roll, otherwise a masked placeholder built from the prefix.
 */
export const sourceSnippets = (
	platform: SourcePlatform,
	token: string,
	name: string,
): ReadonlyArray<SourceSnippet> => {
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
			return [browserSnippet(token, serviceName)]
		case "claude_code":
			return [claudeCodeSnippet(token)]
		case "opentelemetry":
		case "cloudflare_ai_gateway":
			return [envSnippet(token, serviceName), collectorSnippet(token)]
		default: {
			const sdk = sdkOf(platform)
			if (sdk === null) return [envSnippet(token, serviceName)]
			const needsHttp = sdk.env !== null && Str.includes(HTTP_PROTOCOL_LINE)(sdk.env.code)
			return [envSnippet(token, serviceName, needsHttp), ...setupSnippets(sdk, token)]
		}
	}
}

/** Stands in for the token once it can no longer be shown. */
export const maskedToken = (prefix: string | null): string =>
	`${prefix ?? "maple_src_"}${Str.repeat(16)("•")}`
