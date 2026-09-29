---
name: maple-agent-tracing-spring-ai
description: "Trace Spring AI agents with Maple: wires Spring Boot's OpenTelemetry starter to Maple, samples every turn, and adds one configuration class so each ChatClient conversation is one Maple Agent Session with transcript, tool calls (failures marked), sub-agent lanes and tokens. Triggers on 'trace my spring ai agent', 'add Maple to spring ai', 'agent sessions for spring ai', 'OpenTelemetry for spring ai'."
---

# Maple agent tracing for Spring AI

Goal: every conversation with the Spring AI app shows up in Maple **Agent Sessions** as exactly one session, one turn per `ChatClient` call, with transcript, model calls, tool calls (failures marked), sub-agent lanes and tokens.

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/spring-ai

Mechanism: Spring AI's Micrometer Observations → `micrometer-tracing-bridge-otel` → OpenTelemetry SDK → OTLP/HTTP to Maple, all from `spring-boot-starter-opentelemetry`. Maple detects the spans as Spring AI by their `spring.ai.*` keys. Out of the box: sampling is 10%, prompts/replies never reach spans (`log-prompt`/`log-completion` only log to SLF4J), thrown tool errors end the span OK, and advisor spans inflate call counts. Steps 2-5 fix all four.

## Step 0: Detect versions and existing setup

1. Read `pom.xml` / `build.gradle(.kts)`: Spring Boot version, `spring-ai-bom` version, model starter (`spring-ai-starter-model-*`). Target Spring AI 2.0.x (verified 2.0.1) on Boot 4.x (verified 4.1.1), Java 17+. Spring AI 1.1.x on Boot 3.5: see Step 2d.
2. Grep for existing tracing: `micrometer-tracing-bridge`, `spring-boot-starter-opentelemetry`, `opentelemetry-exporter-otlp`, `management.otlp`, `management.opentelemetry`, `management.tracing`, `-javaagent`, `opentelemetry-javaagent`, `OTEL_EXPORTER_OTLP`, `ObservationFilter`, `ObservationPredicate`, `ToolExecutionExceptionProcessor`.
   - Existing Boot tracing to another backend: Boot has one OTLP span exporter. Ask the user whether to repoint it at Maple; to keep both, add a second exporter via an `OtlpHttpSpanExporter` bean only if they insist.
   - OTel Java agent attached (`-javaagent:...opentelemetry-javaagent.jar`): see Step 2c.
   - Existing `ToolExecutionExceptionProcessor` bean: patch it (Step 5) instead of adding the one in Step 3.
3. Find every `ChatClient` call site (`.prompt(`, `.call()`, `.stream()`) and where the conversation/thread id lives in the request. Find every `ChatClient.Builder` (each role/sub-agent).

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`. Protocol: OTLP/HTTP protobuf (Boot's default transport).
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from **Settings → Ingestion**.
- Private `maple_sk_` keys never go in browser code. Spring AI runs server-side; an ingest key is write-only.
- Follow the repo's existing secret/env convention (`${ENV_VAR}` placeholders, profile files, Vault/Config Server). If there is none, inline in `application.properties` is acceptable because ingest keys are write-only.

## Step 2: Install and export

### 2a. Dependencies (Boot 4, Spring AI 2.0)

Keep the existing `spring-ai-bom` import and model starter. If there is no BOM yet, import `org.springframework.ai:spring-ai-bom:2.0.1` (`<type>pom</type><scope>import</scope>` in `dependencyManagement`; Gradle `implementation(platform("org.springframework.ai:spring-ai-bom:2.0.1"))`). Add:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-opentelemetry</artifactId>
</dependency>
```

Gradle: `implementation("org.springframework.boot:spring-boot-starter-opentelemetry")`. Actuator is not needed on Boot 4 (verified); keep it if the app already has it.

### 2b. Properties

Add to `application.properties` (or the YAML equivalent):

```properties
spring.application.name=<service name, e.g. support-agent>

management.opentelemetry.tracing.export.otlp.endpoint=https://ingest.maple.dev/v1/traces
management.opentelemetry.tracing.export.otlp.headers.Authorization=Bearer ${MAPLE_INGEST_KEY}
management.tracing.sampling.probability=1.0
management.opentelemetry.resource-attributes.deployment.environment.name=<env>

management.otlp.metrics.export.url=https://ingest.maple.dev/v1/metrics
management.otlp.metrics.export.headers.Authorization=Bearer ${MAPLE_INGEST_KEY}

maple.ai.capture-content=true
```

- The endpoint property takes the FULL URL including `/v1/traces` (Boot does not append it).
- `management.tracing.sampling.probability=1.0` is REQUIRED. Default is `0.1`: 90% of turns silently missing.
- The starter also exports metrics, to `localhost:4318` by default. Either point them at Maple (above) or set `management.otlp.metrics.export.enabled=false`. Never leave the default.
- Streamed tokens: Spring AI 2.0's OpenAI model requests usage on streams by default. If the app sets ANY `spring.ai.openai.chat.stream-options.*` property, also set `spring.ai.openai.chat.stream-options.include-usage=true` (once stream options exist, unset means false and streamed turns report no tokens).
- Boot 4.1+ also maps `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, Boot appends `/v1/traces`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`. Use them if the repo configures via env; keep the sampling property.
- Do NOT set `management.opentelemetry.tracing.limits.max-attribute-value-length`: truncated JSON content no longer parses and Maple drops it.
- Leave `spring.ai.chat.observations.log-prompt/log-completion` and `spring.ai.chat.client.observations.*` as they are. They only log; they never put content on spans.
- `@SpringBootTest` disables tracing export; add `@AutoConfigureTracing` only if the user wants spans from tests.

### 2c. OTel Java agent present

The agent does not turn Micrometer Observations into spans, so Steps 2a-2b and 3 are still required. But agent + starter as-is is BROKEN: Boot's SDK and the agent don't share context, so every Spring AI span becomes its own trace (no hierarchy, model calls split from their session). Verified with agent 2.31.1. Either remove the agent for this service, or hand Micrometer the agent's `OpenTelemetry` (add ONLY while the agent is attached; without it `GlobalOpenTelemetry.get()` is a no-op and nothing is traced):

```java
@Bean
io.opentelemetry.api.OpenTelemetry openTelemetry() {
	return io.opentelemetry.api.GlobalOpenTelemetry.get();
}
```

Then the agent exports everything: set `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>` for the agent. Boot's `management.opentelemetry.*` export and sampling properties no longer apply (agent default sampler records everything). Also add `-Dotel.instrumentation.openai-java.enabled=false` as a precaution (no duplicate `chat` spans seen with Spring AI 2.0.1, but the agent ships OpenAI SDK instrumentation). HTTP client spans appear twice (Boot + agent); they are not AI spans and don't affect sessions.

### 2d. Spring AI 1.1 on Boot 3.5

- Deps: `io.micrometer:micrometer-tracing-bridge-otel` + `io.opentelemetry:opentelemetry-exporter-otlp` + `spring-boot-starter-actuator` (required on Boot 3.5; no `spring-boot-starter-opentelemetry`).
- Properties: `management.otlp.tracing.endpoint=https://ingest.maple.dev/v1/traces`, `management.otlp.tracing.headers.Authorization=Bearer ...`; sampling property unchanged. Stream usage: `spring.ai.openai.chat.options.stream-usage=true`.
- Step 3 class: replace `tools.jackson.databind.json.JsonMapper.shared().writeValueAsString(...)` with a Jackson 2 `com.fasterxml.jackson.databind.ObjectMapper` (wrap the checked `JsonProcessingException`), and delete the two `getToolCallId()` lines (not in 1.1).
- OpenAI model property: `spring.ai.openai.chat.options.model` on 1.1 (2.0: `spring.ai.openai.chat.model`).
- Boot 4 still accepts the Boot 3 `management.otlp.tracing.*` names but marks them deprecated.

## Step 3: Add the configuration class

Create it in a package the app's `@SpringBootApplication` scans (same package or below). Copy verbatim; change only the package:

```java
package com.example.agent;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import io.micrometer.common.KeyValue;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationFilter;
import io.micrometer.observation.ObservationRegistry;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.ai.chat.client.advisor.observation.AdvisorObservationContext;
import org.springframework.ai.chat.client.observation.ChatClientObservationContext;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.observation.ChatModelObservationContext;
import org.springframework.ai.tool.execution.DefaultToolExecutionExceptionProcessor;
import org.springframework.ai.tool.execution.ToolExecutionExceptionProcessor;
import org.springframework.ai.tool.observation.ToolCallingObservationContext;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Adds the gen_ai.* attributes Maple reads on top of Spring AI's own observations. */
@Configuration(proxyBeanMethods = false)
public class MapleAiObservationConfig {

	/** Agent name for a ChatClient: `.defaultAdvisors(a -> a.param(AGENT_NAME, "support_agent"))`. */
	public static final String AGENT_NAME = "gen_ai.agent.name";

	@Bean
	ObservationFilter mapleGenAiAttributes(@Value("${maple.ai.capture-content:false}") boolean captureContent) {
		return context -> {
			if (context instanceof ChatClientObservationContext client) {
				// One ChatClient call is one agent turn; Spring AI labels it "framework".
				client.addLowCardinalityKeyValue(KeyValue.of("gen_ai.operation.name", "invoke_agent"));
				if (client.getRequest().context().get(AGENT_NAME) instanceof String agent) {
					client.addLowCardinalityKeyValue(KeyValue.of("gen_ai.agent.name", agent));
				}
			}
			else if (context instanceof AdvisorObservationContext advisor) {
				// Advisor span names ("tool _calling ", "message_chat_memory") would be
				// counted as extra tool and LLM calls. A neutral name keeps them as plumbing.
				advisor.setContextualName("spring_ai advisor");
			}
			else if (context instanceof ToolCallingObservationContext tool) {
				tool.addLowCardinalityKeyValue(KeyValue.of("gen_ai.tool.name", tool.getToolDefinition().name()));
				if (tool.getToolCallId() != null) {
					tool.addHighCardinalityKeyValue(KeyValue.of("gen_ai.tool.call.id", tool.getToolCallId()));
				}
				if (captureContent) {
					tool.addHighCardinalityKeyValue(KeyValue.of("gen_ai.tool.call.arguments", tool.getToolCallArguments()));
					if (tool.getToolCallResult() != null) {
						tool.addHighCardinalityKeyValue(KeyValue.of("gen_ai.tool.call.result", tool.getToolCallResult()));
					}
				}
			}
			else if (captureContent && context instanceof ChatModelObservationContext chat) {
				chat.addHighCardinalityKeyValue(KeyValue.of("gen_ai.input.messages",
						JsonMapper.shared().writeValueAsString(chat.getRequest().getInstructions().stream().map(MapleAiObservationConfig::message).toList())));
				if (chat.getResponse() != null) {
					chat.addHighCardinalityKeyValue(KeyValue.of("gen_ai.output.messages",
							JsonMapper.shared().writeValueAsString(chat.getResponse().getResults().stream().map(g -> message(g.getOutput())).toList())));
				}
			}
			return context;
		};
	}

	// Spring AI hands a failing tool's message back to the model and ends the tool span OK.
	// Mark the span failed first, then keep the default behaviour.
	@Bean
	ToolExecutionExceptionProcessor toolExecutionExceptionProcessor(ObservationRegistry registry) {
		ToolExecutionExceptionProcessor fallback = DefaultToolExecutionExceptionProcessor.builder().build();
		return exception -> {
			Observation toolCall = registry.getCurrentObservation();
			if (toolCall != null) {
				toolCall.error(exception);
			}
			return fallback.process(exception);
		};
	}

	/** One message in the OpenTelemetry GenAI shape: {role, parts: [...]}. */
	private static Map<String, Object> message(Message message) {
		List<Map<String, Object>> parts = new ArrayList<>();
		if (message instanceof ToolResponseMessage toolResponse) {
			toolResponse.getResponses().forEach(r -> parts.add(
					Map.of("type", "tool_call_response", "id", r.id(), "response", r.responseData())));
		}
		else {
			if (message.getText() != null && !message.getText().isEmpty()) {
				parts.add(Map.of("type", "text", "content", message.getText()));
			}
			if (message instanceof AssistantMessage assistant) {
				assistant.getToolCalls().forEach(call -> parts.add(
						Map.of("type", "tool_call", "id", call.id(), "name", call.name(), "arguments", call.arguments())));
			}
		}
		return Map.of("role", message.getMessageType().getValue(), "parts", parts);
	}

}
```

Boot applies `ObservationFilter` beans to the registry automatically; nothing else to register. The filter runs when each observation stops, after Spring AI's own conventions. Why each part exists: the `chat_client` span is labeled `framework` by Spring AI and its name contains "chat", so without `invoke_agent` Maple counts it as a model call; Maple classifies spans without a known operation by name, so unrenamed advisor spans count `tool _calling ` as a tool call and `message_chat_memory` as a model call on every turn. `spring.ai.tools.observations.include-content` writes `spring.ai.tool.call.arguments/result`, which Maple does not read; the filter's `gen_ai.tool.call.*` keys are the ones read.

Content notes: every `chat` span carries the whole conversation so far, so spans grow with long chats (don't cap them; see 2b). With `maple.ai.capture-content=false` no message/tool content leaves the process; to redact instead, mask values inside `message(...)`. The conversation id and agent names are sent regardless: keep personal data out of them.

Kotlin project: translate one to one (e.g. `ObservationFilter { context -> ...; context }`), same beans, same keys.

Do NOT drop advisor observations with an `ObservationPredicate` instead of renaming them: on `.stream()` calls Spring AI takes the model span's parent from the Reactor context, which then holds the skipped (no-op) advisor observation, so the streamed `chat` span becomes its own trace outside the session (verified).

## Step 4: Session id (one conversation = one session)

Maple reads ONLY `spring.ai.chat.client.conversation.id` for Spring AI, on the `chat_client` span. Spring AI sets it from the `ChatMemory.CONVERSATION_ID` advisor param.

- On EVERY top-level call: `chatClient.prompt().user(msg).advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))...`. Use the id the app already stores for the chat/thread.
- If the app already passes this param for `MessageChatMemoryAdvisor`/`PromptChatMemoryAdvisor`/`VectorStoreChatMemoryAdvisor`, nothing to add. If it has no chat memory, add the param anyway; it works without a memory advisor.
- Never set the conversation id via `defaultAdvisors(...)` on a shared builder/client (constant id = all users in one session). Never mint a UUID per request.
- Sub-agent `ChatClient` calls inside tools need no id: Maple groups the whole trace by any span carrying it. Don't pass a different id to sub-agents.
- Do not add `gen_ai.conversation.id` or `session.id`; Maple ignores them on Spring AI spans.
- Give every `ChatClient` an agent name: `builder.defaultAdvisors(a -> a.param(MapleAiObservationConfig.AGENT_NAME, "<snake_case_role>"))`.

## Step 5: Tools, errors, sub-agents

- Tool spans are `execute_tool <name>`; Step 3 adds `gen_ai.tool.name`, `gen_ai.tool.call.id` and (with content on) arguments/result.
- Failures: Step 3's `ToolExecutionExceptionProcessor` marks the tool span ERROR (exception message + `exception` event) and still returns the message to the model. If the app has its own processor bean, do not add a second one: insert `Observation current = registry.getCurrentObservation(); if (current != null) current.error(exception);` at the top of its `process(...)`. If the app relied on `spring.ai.tools.throw-exception-on-error=true`, build the fallback with `.alwaysThrow(true)` (the property no longer applies once the bean is replaced).
- Tools that return error strings instead of throwing count as success. Point it out; don't change behavior unasked.
- Sub-agents: one `ChatClient` per role, exposed to the orchestrator as a `@Tool(name = "<role>", description = ...)` method that calls it. Build each from `builder.clone()` with its own `AGENT_NAME` param. Maple shows `execute_tool <role>` → worker `chat_client` as a delegation lane.
- Own thread pools / `CompletableFuture` fan-out: propagate the observation to worker threads (Micrometer `context-propagation`: `ContextSnapshot`, a wrapped executor, or build the worker observation with `.parentObservation(parent)`). Otherwise each worker starts a new trace and becomes its own `trace:<id>` session.
- Spring AI runs the tool calls of one model response sequentially on the calling thread, so context flows without help unless the app fans out itself.
- A `ChatClient` without an agent name gets no lane; its model and tool calls are drawn in the caller's lane.
- Spring AI 2.0 has no native tool-approval/HITL mechanism; don't invent one.

Sub-agent example:

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.stereotype.Component;

@Component
public class Workers {

	private final ChatClient weather;

	public Workers(ChatClient.Builder builder, WeatherTools weatherTools) {
		this.weather = builder.clone()
			.defaultSystem("You answer weather questions using your tools.")
			.defaultTools(weatherTools)
			.defaultAdvisors(a -> a.param(MapleAiObservationConfig.AGENT_NAME, "weather_worker"))
			.build();
	}

	@Tool(name = "weather_worker", description = "Ask the weather specialist about a city")
	public String weatherWorker(String task) {
		return weather.prompt().user(task).call().content();
	}

}
```

## Step 5b: Tokens and cost (no action needed, explain if asked)

- `chat` spans carry `gen_ai.usage.input_tokens`, `output_tokens`, and `cache_read.input_tokens` / `cache_creation.input_tokens` when the provider reports them; Maple reads all four. `chat_client` spans carry no usage, so nothing is double counted.
- Spring AI records the provider as `gen_ai.system`, derived from the client class, not the model: a Claude model behind OpenRouter via the OpenAI starter is labeled `openai`. Maple uses the provider only to decide whether input includes cached tokens, so only cache figures can be affected.
- No cost attribute is emitted; sessions show as unpriced (Maple never prices tokens).
- With model starters other than OpenAI, a `chat` span for a call without tools may carry no Spring AI marker, so Maple files it as a generic GenAI span (framework "Unidentified" on that span). Session, transcript and tokens are unaffected.

## Step 6: Flush

- Web app: nothing. Boot shuts down the `SdkTracerProvider` on context close, which flushes.
- `CommandLineRunner` / batch: exit explicitly with `System.exit(SpringApplication.exit(SpringApplication.run(App.class, args)))` in `main`. If `main` just returns, the OpenAI starter's HTTP client keeps non-daemon threads alive ~60 s; the context (and the final span flush) only closes after that (verified). `Runtime.halt()` / SIGKILL lose the last batch.
- Serverless (Spring Cloud Function on Lambda etc.): inject `io.opentelemetry.sdk.trace.SdkTracerProvider` and call `tracerProvider.forceFlush().join(10, TimeUnit.SECONDS)` at the end of EVERY invocation; never shut it down.
- Batch delay is 5 s; wait before checking Maple.

## Step 7: Verify

Run one real conversation: 2-3 turns with the same conversation id including one tool call (one streamed turn if the app streams), plus a second conversation with a different id. Exit cleanly. Wait ~1 minute. In Maple **Agent Sessions**, filtered by the service name (or via the Maple MCP `list_agent_sessions` + `get_agent_session`), check:

- [ ] Exactly one session per conversation id; none named `trace:<id>` (that means a top-level call lacked the `CONVERSATION_ID` param, or a sub-agent ran on a thread without context).
- [ ] The two conversations are two different sessions.
- [ ] Framework shows **Spring AI**.
- [ ] Every turn arrived (count = number of top-level `ChatClient` calls). Missing turns = sampling property not applied.
- [ ] Spans: `spring_ai chat_client` (agent, with your agent name), `chat <model>`, `execute_tool <tool>`. Advisor spans are named `spring_ai advisor`; NO spans named `tool _calling `, `call`, `stream`, `message_chat_memory` (else the filter isn't loaded).
- [ ] LLM call count = number of `chat <model>` spans (not doubled); tool call count = number of real tool invocations.
- [ ] Transcript shows user messages, replies, tool calls with arguments and results (else `maple.ai.capture-content` isn't `true` or the class isn't scanned).
- [ ] Input and output tokens on every model call, including the streamed one.
- [ ] A tool that threw is counted as failed, with its message; successful tools are not.
- [ ] Sub-agents appear as lanes under their agent names.
- [ ] Cost shows as unpriced (Spring AI emits no cost; expected).
- [ ] App logs have no `Failed to publish metrics` / OTLP export errors, no `401` (`401` = wrong key, key from the other region, or the header property not reading `...headers.Authorization=Bearer <key>`).

## Do not

- Do not leave `management.tracing.sampling.probability` at the default `0.1`.
- Do not rely on `log-prompt`/`log-completion`/`include-content` for the transcript; Maple reads `gen_ai.input.messages`/`gen_ai.output.messages`/`gen_ai.tool.call.*` span attributes only.
- Do not stamp `maple_ai.session.id` on Spring AI spans; the conversation id param is the supported path.
- Do not put a constant or per-request conversation id on calls.
- Do not register a second `ToolExecutionExceptionProcessor` next to an existing one (ambiguous bean).
- Do not attach the OTel Java agent next to the starter without the `GlobalOpenTelemetry` bean from Step 2c (every span becomes its own trace).
- Do not set an attribute length limit (breaks content JSON).
- Do not use an `ObservationPredicate` to drop Spring AI observations (breaks the streamed turn's trace).
- Do not use this skill for LangChain4j; use the generic OpenTelemetry GenAI guide: https://maple.dev/docs/agent-tracing/opentelemetry

## Feedback on this skill

When a step in this skill was wrong, missing or misleading (or something worked noticeably well), send the Maple team feedback once you're done. Show the user what you'll send and send it only with their OK.

Keep it about the skill, never about the user's project:

- Include: `maple-agent-tracing-spring-ai`, the step that failed, the framework and package versions, what you expected versus what happened, and the fix you used.
- Leave out: keys and tokens of any kind, hostnames, URLs, file paths, repo or service names, code from the project, prompts, model replies, span or log contents, and anything that identifies the user or their customers. Replace a value with a placeholder like `<redacted>` if the error message contains one.

Send it:

- **Maple MCP connected:** call `send_maple_feedback` with `kind` (`bug`, `documentation`, `improvement`, `feature_request`, `praise` or `other`), `summary` (one line), `reason` (what you were doing and what got in the way), optional `details`, `related_to: "maple-agent-tracing-spring-ai"`, `agent_type: "coding_agent"` and your `agent_name` and `model`.
- **No MCP:** give the user the drafted feedback so they can send it themselves.
