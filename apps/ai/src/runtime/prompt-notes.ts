/** Shared instructions for tool naming and approval behavior. */
export const TOOL_PREFIX_NOTE = `## Tools
Maple's tools are exposed over MCP and named \`mcp__maple__<tool>\` (for example,
\`mcp__maple__find_errors\`). This document refers to them by their short names;
call them by their full \`mcp__maple__\` name.`

export const APPROVAL_NOTE = `## Mutating actions are approved before they take effect
Tools that create, update, delete, or transition state (dashboards, alert rules,
error issues, notification policies, comments, fix proposals) do not take effect
immediately — the Maple UI surfaces an approval step for the proposed action.

NEVER emit "[Approve]", "[Deny]", "Proceed with this fix?", "Confirm?", or any
prose that imitates a confirmation prompt — the UI handles it. Just call the tool
with the right arguments and stop. If the user denies, the tool result reflects
that; acknowledge briefly and stop. Do not retry a denied action without a new
directive.`
