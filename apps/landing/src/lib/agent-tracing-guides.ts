// Cards on /docs/agent-tracing, one per framework or gateway guide, grouped by
// ecosystem. Every entry is a shipping page under content/docs/agent-tracing.
import type { GuideCard } from "./instrumentation-guides"
import type { BrandMarkId } from "./brand-marks"

const guide = (slug: string, name: string, hint: string, mark: BrandMarkId): GuideCard => ({
	name,
	hint,
	href: `/docs/agent-tracing/${slug}`,
	icon: { mark },
})

export interface AgentGuideSection {
	id: string
	title: string
	cards: readonly GuideCard[]
}

export const AGENT_GUIDE_SECTIONS: readonly AgentGuideSection[] = [
	{
		id: "typescript",
		title: "TypeScript & JavaScript",
		cards: [
			guide("vercel-ai-sdk", "Vercel AI SDK", "generateText, streamText and Agent", "vercel"),
			guide("mastra", "Mastra", "Agents, workflows and memory threads", "mastra"),
			guide("claude-agent-sdk", "Claude Agent SDK & Claude Code", "TypeScript, Python and the CLI", "claude"),
		],
	},
	{
		id: "python",
		title: "Python",
		cards: [
			guide("openai-agents", "OpenAI Agents SDK", "Handoffs and agents as tools", "openai"),
			guide("langchain", "LangChain & LangGraph", "Graphs, threads and interrupts", "langchain"),
			guide("pydantic-ai", "Pydantic AI", "Built-in GenAI instrumentation", "pydantic"),
			guide("crewai", "CrewAI", "Crews, flows and delegation", "crewai"),
			guide("google-adk", "Google ADK", "Runners, sub-agents and sessions", "googleadk"),
			guide("llamaindex", "LlamaIndex", "FunctionAgent and AgentWorkflow", "llamaindex"),
			guide("strands", "Strands Agents", "Swarms, graphs and agents as tools", "strands"),
			guide("smolagents", "smolagents", "CodeAgent and managed agents", "huggingface"),
			guide("agno", "Agno", "Agents and teams", "agno"),
			guide("dspy", "DSPy", "Modules, ReAct and optimizers", "python"),
			guide("haystack", "Haystack", "Agent component and pipelines", "haystack"),
		],
	},
	{
		id: "jvm-dotnet",
		title: "Java & .NET",
		cards: [
			guide("spring-ai", "Spring AI", "ChatClient, advisors and tools", "spring"),
			guide(
				"microsoft-agent-framework",
				"Microsoft Agent Framework",
				"And Semantic Kernel · Python and .NET",
				"dotnet",
			),
		],
	},
	{
		id: "gateways",
		title: "Gateways & provider SDKs",
		cards: [
			guide("openrouter", "OpenRouter", "Broadcast traces from the gateway", "openrouter"),
			guide("litellm", "LiteLLM", "SDK and proxy", "litellm"),
			guide("provider-sdks", "OpenAI, Anthropic & Gemini SDKs", "Your own agent loop", "openai"),
			guide("opentelemetry", "Any language", "Emit the OpenTelemetry GenAI conventions", "opentelemetry"),
		],
	},
]
