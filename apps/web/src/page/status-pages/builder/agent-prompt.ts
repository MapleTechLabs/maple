import { Array as Arr } from "effect"
import { claudeCodeCommand } from "../../kit/mcp-client-config"

// `/status-pages/new?setup=agent`: the prompt a coding agent follows to set a status page up
// through the Maple MCP, or in the repo's Terraform or Alchemy code.

/**
 * The setup prompt for `mcpEndpoint` (the org's region). The agent asks before anything public:
 * which way to manage the page, the monitors, the domain, and the publish.
 */
export const statusPageAgentPrompt = (mcpEndpoint: string): string =>
	Arr.join(
		[
			"Set up a status page for this project on Maple (maple.dev). Work through the steps in order and ask me before creating anything.",
			"",
			"1. Connect the Maple MCP server",
			`Check whether a Maple MCP server is connected (it has a get_status_page tool). If not, add it as an HTTP MCP server named "maple" at ${mcpEndpoint}. In Claude Code: ${claudeCodeCommand(mcpEndpoint)}. In other clients add the same URL to their MCP config. Sign in to Maple in the browser when it asks, then continue. Call get_status_page to see the pages that exist already.`,
			"",
			"2. Choose how the page is managed",
			"Look at how this repo manages infrastructure. If it uses Terraform, offer to manage the page in code with the mapletechlabs/maple provider (maple_uptime_monitor, maple_status_page; maple.dev/docs/iac/terraform-resources). If it uses Alchemy, offer @maple-dev/alchemy (Maple.UptimeMonitor, Maple.StatusPage; maple.dev/docs/iac/alchemy-resources). Both need a Maple API key with the uptime_monitors:write and status_pages:write scopes, kept in the repo's existing secret store, never committed. Otherwise, or if I prefer, set everything up directly with the MCP tools. Ask me which.",
			"",
			"3. Uptime monitors",
			"Find what customers depend on: public URLs, API base URLs and health endpoints in the repo's routes, deploy and DNS config. Check list_uptime_monitors for monitors that already exist. Propose one monitor per endpoint (URL, method, expected status, interval) and one page component per customer-facing service, grouped under headings when there are more than a few. Prefer a health endpoint over a page that renders. After I confirm, create them (create_uptime_monitor, or the IaC resources).",
			"",
			"4. Create the page and its look",
			"Through the MCP: create the page as a draft (create_status_page), so nothing is public until it is published, read its config with get_status_page include_config=true, then set the components (each with its monitor_id), the description and links (website, support, privacy, terms) and the theme with apply_status_page_config. In Terraform or Alchemy: declare the same in the status page resource instead, with each component's monitor_id from the monitor resources, show me the plan, and apply only after I approve it; do not create or edit the page through the MCP. Either way, match the product's brand: take the accent, background and font from the repo's CSS variables or Tailwind theme, start from the closest preset, and use the logo and favicon at their public HTTPS URLs. Show me what you chose.",
			"",
			"5. Domain",
			"Ask me who the page is for. If it is for customers, ask which subdomain to serve it on (like status.example.com; a bare domain cannot point at Maple), set it with set_status_page_domain (or the IaC resource's custom domain), and give me the DNS records it returns: a CNAME to Maple and a TXT record proving ownership. If this repo manages that DNS zone, offer to add them there. If the page is only for the team, skip the domain and set its visibility to internal (members only), or protect it with a password if I ask.",
			"",
			"6. Publish",
			"Give me the draft's link and a summary of the monitors, components, look and domain. Publish (publish_status_page, or the IaC resource) only after I approve. Afterwards, check get_status_page shows every component with a fresh status.",
		],
		"\n",
	)
