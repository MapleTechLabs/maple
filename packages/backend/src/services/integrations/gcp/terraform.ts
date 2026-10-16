import type { GcpLogRuntime } from "@maple/domain/primitives"
import { gcpLogFilter, type GcpScriptTarget } from "./setup-scripts"

/**
 * The module the configuration calls: `deploy/terraform-google-maple` in Maple's public repository,
 * pinned to a release tag so a plan never changes under an administrator's feet.
 */
export const GCP_TERRAFORM_MODULE_SOURCE =
	"github.com/MapleTechLabs/maple//deploy/terraform-google-maple?ref=terraform-google-maple-v1.0.0"
export const GCP_TERRAFORM_MODULE_URL =
	"https://github.com/MapleTechLabs/maple/tree/terraform-google-maple-v1.0.0/deploy/terraform-google-maple"

/** An HCL string literal: `${` and `%{` would start a template, a newline would end the line. */
const hcl = (value: string): string =>
	`"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		// A function: in a replacement string, `$$` is itself an escape for one `$`.
		.replaceAll("${", () => "$${")
		.replaceAll("%{", "%%{")}"`

export interface GcpTerraformInput extends Omit<GcpScriptTarget, "mapleUrl"> {
	/** The receiver URL without a secret: the push tokens' audience. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: the module leaves read-only access out. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	/** Terraform always sets the sink's filter: null is the filter a new sink gets. */
	readonly applicationLogs: ReadonlyArray<GcpLogRuntime> | null
}

/**
 * A module block for the administrator's own Terraform: the same resources the setup script
 * creates, named the same, with push requests signed by Google instead of carrying a secret. It
 * holds nothing private, so it can be committed.
 */
export const renderGcpTerraform = (input: GcpTerraformInput): string => {
	const attributes: ReadonlyArray<readonly [string, string]> = [
		["connector_id", hcl(input.connectorId)],
		["scope_type", hcl(input.scopeType)],
		["scope_id", hcl(input.scopeId)],
		["project_id", hcl(input.projectId)],
		["push_endpoint", hcl(input.pushEndpoint)],
		...(input.mapleServiceAccountEmail === undefined
			? []
			: [["maple_service_account", hcl(input.mapleServiceAccountEmail)] as const]),
		["logs_enabled", String(input.logsEnabled)],
		["log_filter", hcl(gcpLogFilter(input.applicationLogs ?? []))],
	]
	// `terraform fmt` aligns the equals signs of consecutive attributes.
	const width = Math.max(...attributes.map(([name]) => name.length))
	const label = `maple_gcp_${input.scopeId.replaceAll(/[^a-z0-9]/g, "_")}`
	return `# Maple connection for Google Cloud ${input.scopeType} ${input.scopeId}. It holds no secret.
# What it creates: ${GCP_TERRAFORM_MODULE_URL}
module "${label}" {
  source = ${hcl(GCP_TERRAFORM_MODULE_SOURCE)}

${attributes.map(([name, value]) => `  ${name.padEnd(width)} = ${value}`).join("\n")}
}
`
}
