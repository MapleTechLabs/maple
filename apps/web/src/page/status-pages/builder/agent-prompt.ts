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
			`Check whether a Maple MCP server at ${mcpEndpoint} is connected (it has a get_status_page tool). A Maple server at another URL belongs to another region, so do not use it here. If none is connected at that URL, add it as an HTTP MCP server named "maple" at ${mcpEndpoint}, or under another name such as "maple-2" when a server named "maple" already exists. In Claude Code: ${claudeCodeCommand(mcpEndpoint)} (change the name there too). In other clients add the same URL to their MCP config. Sign in to Maple in the browser when it asks, then continue. A connection is signed in to one Maple organization, the one picked at Maple sign-in: before calling any Maple tool, ask me to confirm it is the organization this page is for, and stop if I cannot. Then call get_status_page to see the pages that exist already.`,
			"",
			"2. Choose how the page is managed",
			"Look at how this repo manages infrastructure. If it uses Terraform, offer to manage the page in code with the mapletechlabs/maple provider (maple_uptime_monitor, maple_status_page; maple.dev/docs/iac/terraform-resources). If it uses Alchemy, offer @maple-dev/alchemy (Maple.UptimeMonitor, Maple.StatusPage; maple.dev/docs/iac/alchemy-resources). Both need a Maple API key with the uptime_monitors:write and status_pages:write scopes, kept in the repo's existing secret store, never committed. Otherwise, or if I prefer, set everything up directly with the MCP tools. Ask me which.",
			"",
			"3. Uptime monitors",
			"Find what customers depend on: public URLs, API base URLs and health endpoints in the repo's routes, deploy and DNS config. Check list_uptime_monitors for monitors that already exist. Propose one monitor per endpoint (URL, method, expected status, interval) and one page component per customer-facing service, grouped under headings when there are more than a few. Prefer a health endpoint over a page that renders. After I confirm, create them (create_uptime_monitor, or the IaC resources).",
			"",
			"4. Create the page and its look",
			"Through the MCP: create the page as a draft (create_status_page), so nothing is public until it is published, read its config with get_status_page include_config=true, then set the components (each with its monitor_id), the description and links (website, support, privacy, terms) and the theme with apply_status_page_config. In Terraform or Alchemy: declare the same in the status page resource instead, with each component's monitor_id from the monitor resources, and do not apply it yet: applying publishes the page, so that waits for step 6; on that path, never create or edit the page through the MCP. Either way, match the product's brand: take the accent, background and font from the repo's CSS variables or Tailwind theme, start from the closest preset, and use the logo and favicon at their public HTTPS URLs. Show me what you chose.",
			"",
			"5. Domain",
			"Ask me who the page is for. If it is for customers, ask which subdomain to serve it on (like status.example.com; a bare domain cannot point at Maple), and set it. Through the MCP: set_status_page_domain, then give me the DNS records it returns, a CNAME to Maple and a TXT record proving ownership. In Terraform or Alchemy: declare the domain on the status page resource; the records only exist once step 6 applies it, so read them from the resource's outputs then and give them to me (the page stays on its Maple address until they resolve). If this repo manages that DNS zone, offer to add the records there. If the page is only for the team, skip the domain and set its visibility to internal (members only; apply_status_page_config, or the resource's visibility). If I want a password instead, set it with the resource's password in Terraform or Alchemy; through the MCP, tell me to set it in Maple under the page's Settings > Who can view, since no tool sets it.",
			"",
			"6. Publish",
			"Summarize the monitors, components, look and domain, and publish only after I approve. Through the MCP, give me the draft's link with the summary and publish with publish_status_page. In Terraform or Alchemy there is no draft to show: give me the plan with the summary, and since applying the resource publishes the page, the approval is the apply; after it, give me the page's link and the domain's DNS records from the outputs. Never call publish_status_page on a page the code manages. Afterwards, check get_status_page shows every component with a fresh status.",
		],
		"\n",
	)
