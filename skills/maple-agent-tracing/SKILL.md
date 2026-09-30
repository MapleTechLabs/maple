---
name: maple-agent-tracing
description: "Trace an AI agent or LLM app with Maple so each conversation shows up as one Agent Session with its transcript, model calls, tool calls, tokens, cost and failures. Detects the agent framework (Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain/LangGraph, Claude Agent SDK, Pydantic AI, LlamaIndex, CrewAI, Google ADK, Strands, smolagents, Agno, DSPy, Haystack, Microsoft Agent Framework, Spring AI, LiteLLM, OpenRouter, raw provider SDKs) and installs the matching per-framework skill. Triggers on 'trace my agent', 'add agent observability', 'LLM tracing with Maple', 'set up Maple agent sessions', 'OpenTelemetry for my AI agent'."
---

# Maple agent tracing (router)

This skill only picks the right per-framework skill.

## Step 1: Find every agent in the repo

Look for LLM and agent dependencies in every app and service: `package.json`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `pom.xml`, `build.gradle*`, `*.csproj`, `go.mod`. A repo can have more than one; handle each one.

## Step 2: Install the matching skill and follow it

Pick the first row that matches the service's dependencies. Install the skill with:

```bash
npx skills add MapleTechLabs/maple/skills --skill <skill> -y
```

Then read the installed `SKILL.md` and follow it. If `npx skills` is unavailable, read the file directly from `https://raw.githubusercontent.com/MapleTechLabs/maple/main/skills/<skill>/SKILL.md`.

| Dependency | Skill |
| --- | --- |
| `@mastra/core` | `maple-agent-tracing-mastra` |
| `@openai/agents`, `openai-agents` | `maple-agent-tracing-openai-agents` |
| `langchain`, `langgraph`, `langchain-core` (Python) | `maple-agent-tracing-langchain` |
| LangChain.js / LangGraph.js (`langchain`, `@langchain/core`, `@langchain/langgraph`) | `maple-agent-tracing-langchain` (TypeScript: `references/typescript.md`) |
| `@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk`, or the `claude` CLI itself | `maple-agent-tracing-claude-agent-sdk` |
| `agents`, `@cloudflare/ai-chat` (Cloudflare Agents SDK, or the AI SDK inside a Worker / Durable Object) | `maple-agent-tracing-cloudflare-agents` |
| `ai` (Vercel AI SDK) | `maple-agent-tracing-vercel-ai-sdk` |
| `genkit`, `@genkit-ai/*` (TypeScript) | `maple-agent-tracing-genkit` |
| `pydantic-ai`, `pydantic-ai-slim` | `maple-agent-tracing-pydantic-ai` |
| `crewai` | `maple-agent-tracing-crewai` |
| `google-adk`, `@google/adk` | `maple-agent-tracing-google-adk` |
| `llama-index`, `llama-index-core` | `maple-agent-tracing-llamaindex` |
| `strands-agents`, `@strands-agents/sdk` | `maple-agent-tracing-strands` |
| `smolagents` | `maple-agent-tracing-smolagents` |
| `agno` | `maple-agent-tracing-agno` |
| `dspy` | `maple-agent-tracing-dspy` |
| `haystack-ai` | `maple-agent-tracing-haystack` |
| `agent-framework`, `agent-framework-core`, `Microsoft.Agents.AI`, `semantic-kernel`, `Microsoft.SemanticKernel` | `maple-agent-tracing-microsoft-agent-framework` |
| `spring-ai-*` (Maven/Gradle) | `maple-agent-tracing-spring-ai` |
| `litellm` (SDK or proxy) | `maple-agent-tracing-litellm` |
| Requests go through OpenRouter (`openrouter.ai` base URL) and the user wants gateway-side traces | `maple-agent-tracing-openrouter` |
| Only a provider SDK: `openai`, `@anthropic-ai/sdk`, `anthropic`, `google-genai`, `@google/genai` | `maple-agent-tracing-provider-sdks` |
| Anything else, a hand-rolled agent loop, or another language | `maple-agent-tracing-opentelemetry` |

Order matters: a framework row wins over the provider-SDK row, because frameworks depend on provider SDKs and instrumenting both records every model call twice. Mastra depends on `ai` and LangChain.js on `openai` too; match the framework first, and don't route a LangChain.js service to the provider-SDK skill.

## Step 3: Hand-off

After the per-framework skill's own checks pass, tell the user:

- which services you instrumented and with which skill;
- that each conversation appears in Maple under **Agent Sessions** (`https://app.maple.dev/agent-sessions`, or `app.eu.maple.dev` for EU organizations) once one conversation has run;
- anything the per-framework skill said is not captured for that framework (for example, cost or message content), so the gap is expected rather than a bug.
