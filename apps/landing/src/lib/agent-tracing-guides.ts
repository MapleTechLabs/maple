// Cards on /docs/agent-tracing, one per framework or gateway guide, listed under
// each language the guide covers. Every entry is a page under
// content/docs/agent-tracing.
import type { GuideCard, GuideIcon } from "./instrumentation-guides"
import type { BrandMarkId } from "./brand-marks"

// The ids are also the tab ids on multi-language guide pages, so `?lang=` picks the matching tab.
export const AGENT_GUIDE_LANGUAGES = [
	{ id: "typescript", title: "TypeScript & JavaScript", label: "TypeScript" },
	{ id: "python", title: "Python", label: "Python" },
	{ id: "java", title: "Java", label: "Java" },
	{ id: "csharp", title: "C# / .NET", label: ".NET" },
	// Not a language tab: where readers look when their stack has no guide.
	{ id: "other", title: "Other languages and frameworks", label: "Other" },
] as const

export type AgentGuideLanguage = (typeof AGENT_GUIDE_LANGUAGES)[number]["id"]

export interface AgentGuide {
	slug: string
	name: string
	hint: string
	icon: GuideIcon
	languages: readonly AgentGuideLanguage[]
}

const guide = (
	slug: string,
	name: string,
	hint: string,
	mark: BrandMarkId,
	languages: readonly AgentGuideLanguage[],
): AgentGuide => ({ slug, name, hint, icon: { mark }, languages })

// Frameworks first, then gateways and provider SDKs; each language's list keeps this order.
export const AGENT_GUIDES: readonly AgentGuide[] = [
	guide("vercel-ai-sdk", "Vercel AI SDK", "generateText, streamText and Agent", "vercel", ["typescript"]),
	guide("mastra", "Mastra", "Agents, workflows and memory threads", "mastra", ["typescript"]),
	guide("cloudflare-agents", "Cloudflare Agents", "Agents in Durable Objects", "cloudflare", ["typescript"]),
	// No Genkit brand mark yet; Google's, as on the page itself.
	guide("genkit", "Genkit", "Flows, tools and sessions", "googleadk", ["typescript"]),
	guide("openai-agents", "OpenAI Agents SDK", "Handoffs and agents as tools", "openai", ["python", "typescript"]),
	guide("langchain", "LangChain & LangGraph", "Graphs, threads and interrupts", "langchain", ["python", "typescript"]),
	guide("claude-agent-sdk", "Claude Agent SDK & Claude Code", "TypeScript, Python and the CLI", "claude", [
		"typescript",
		"python",
	]),
	guide("google-adk", "Google ADK", "Runners, sub-agents and sessions", "googleadk", ["python", "typescript"]),
	guide("strands", "Strands Agents", "Swarms, graphs and agents as tools", "strands", ["python", "typescript"]),
	guide("pydantic-ai", "Pydantic AI", "Built-in GenAI instrumentation", "pydantic", ["python"]),
	guide("crewai", "CrewAI", "Crews, flows and delegation", "crewai", ["python"]),
	guide("llamaindex", "LlamaIndex", "FunctionAgent and AgentWorkflow", "llamaindex", ["python"]),
	guide("smolagents", "smolagents", "CodeAgent and managed agents", "huggingface", ["python"]),
	guide("agno", "Agno", "Agents and teams", "agno", ["python"]),
	guide("dspy", "DSPy", "Modules, ReAct and optimizers", "python", ["python"]),
	guide("haystack", "Haystack", "Agent component and pipelines", "haystack", ["python"]),
	guide("spring-ai", "Spring AI", "ChatClient, advisors and tools", "spring", ["java"]),
	guide("microsoft-agent-framework", "Microsoft Agent Framework", "And Semantic Kernel · Python and .NET", "dotnet", [
		"python",
		"csharp",
	]),
	guide("openrouter", "OpenRouter", "Broadcast traces from the gateway", "openrouter", ["typescript", "python"]),
	guide("litellm", "LiteLLM", "SDK and proxy", "litellm", ["python"]),
	guide("provider-sdks", "OpenAI, Anthropic & Gemini SDKs", "Your own agent loop", "openai", ["python", "typescript"]),
	guide(
		"opentelemetry",
		"Any language",
		"Emit the OpenTelemetry GenAI conventions",
		"opentelemetry",
		["other"],
	),
]

export interface AgentGuideCategory {
	id: AgentGuideLanguage
	title: string
	label: string
	cards: readonly GuideCard[]
}

// A card for a guide in several languages opens it on this category's language tab.
const cardFor = (g: AgentGuide, language: AgentGuideLanguage): GuideCard => ({
	name: g.name,
	hint: g.hint,
	href: `/docs/agent-tracing/${g.slug}${g.languages.length > 1 ? `?lang=${language}` : ""}`,
	icon: g.icon,
})

export const AGENT_GUIDE_CATEGORIES: readonly AgentGuideCategory[] = AGENT_GUIDE_LANGUAGES.map((l) => ({
	...l,
	cards: AGENT_GUIDES.filter((g) => g.languages.includes(l.id)).map((g) => cardFor(g, l.id)),
}))
