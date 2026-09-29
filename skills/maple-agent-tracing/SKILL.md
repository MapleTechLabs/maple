---
name: maple-agent-tracing
description: "Trace an AI agent or LLM app with Maple so each conversation shows up as one Agent Session with its transcript, model calls, tool calls, tokens, cost and failures. Detects the agent framework (Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain/LangGraph, Claude Agent SDK, Pydantic AI, LlamaIndex, CrewAI, Google ADK, Strands, smolagents, Agno, DSPy, Haystack, Microsoft Agent Framework, Spring AI, LiteLLM, OpenRouter, raw provider SDKs) and installs the matching per-framework skill. Triggers on 'trace my agent', 'add agent observability', 'LLM tracing with Maple', 'set up Maple agent sessions', 'OpenTelemetry for my AI agent'."
---

# Maple agent tracing (router)

This skill only picks the right per-framework skill. Each framework has its own skill so you load the steps for your stack and nothing else. The human-readable overview is https://maple.dev/docs/agent-tracing.

## Step 1: Find every agent in the repo

Look for LLM and agent dependencies in every app and service: `package.json`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `pom.xml`, `build.gradle*`, `*.csproj`, `go.mod`. A repo can have more than one (a TypeScript chat backend and a Python worker, for example). Handle each one.

## Step 2: Install the matching skill and follow it

Pick the first row that matches the service's dependencies. Install the skill with:

```bash
npx skills add MapleTechLabs/maple/skills --skill <skill> -y
```

Then read the installed `SKILL.md` and follow it. If `npx skills` is unavailable, read the file directly from `https://github.com/MapleTechLabs/maple/tree/main/skills/<skill>/SKILL.md`.

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

## Feedback on this skill

When a step in this skill was wrong, missing or misleading (or something worked noticeably well), send the Maple team feedback once you're done. Show the user what you'll send and send it only with their OK.

Keep it about the skill, never about the user's project:

- Include: `maple-agent-tracing`, the step that failed, the framework and package versions, what you expected versus what happened, and the fix you used.
- Leave out: keys and tokens of any kind, hostnames, URLs, file paths, repo or service names, code from the project, prompts, model replies, span or log contents, and anything that identifies the user or their customers. Replace a value with a placeholder like `<redacted>` if the error message contains one.

Send it one way:

- **Maple MCP connected:** call `send_maple_feedback` with `kind` (`bug`, `documentation`, `improvement`, `feature_request`, `praise` or `other`), `summary` (one line), `reason` (what you were doing and what got in the way), optional `details`, `related_to: "maple-agent-tracing"`, `agent_type: "coding_agent"` and your `agent_name` and `model`.
- **No MCP:** `POST https://api.maple.dev/v2/agent_feedback` (EU: `https://api.eu.maple.dev/v2/agent_feedback`) with `Authorization: Bearer <maple_ak_ API key>` and the same fields as JSON, the agent under `"agent": {"type": "coding_agent", "name": ..., "model": ...}`. The ingest key (`maple_pk_`) doesn't work here; ask the user for an API key from **Settings → API Keys**, and never write it to a file.
- **Neither available:** give the user the drafted feedback so they can send it themselves.
