---
title: "Trace Spring AI agents with OpenTelemetry"
description: "Send Spring AI ChatClient, model and tool spans to Maple with every turn sampled, one session per chat memory conversation, the transcript on the spans and failed tools marked as failed."
group: "AI Agents"
order: 31
navLabel: "Spring AI"
icon: "spring"
---

Spring AI instruments itself with Micrometer Observations. Add Spring Boot's OpenTelemetry starter and every `ChatClient` call becomes a `spring_ai chat_client` span, with a `chat <model>` span per model call and an `execute_tool <name>` span per tool call. The model spans follow the OpenTelemetry GenAI conventions (model, token counts, cache tokens, finish reasons, response id), and Maple recognizes all of it as Spring AI without a separate instrumentation library.

Four defaults work against you. Spring Boot samples 10% of traces, so nine turns out of ten never arrive. Prompts and replies are never written to spans: `log-prompt` and `log-completion` send them to the application log. A tool that throws ends its span as a success, because Spring AI hands the error message back to the model. And the advisor spans (`tool _calling `, `message_chat_memory`) have names Maple reads as extra tool and model calls. This guide fixes all four with a handful of properties and one configuration class. It covers Spring AI 2.0 (tested on 2.0.1) on Spring Boot 4.1 (4.1.1) and Java 21, with notes for Spring AI 1.1 on Boot 3.5.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-spring-ai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Spring AI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-spring-ai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the OpenTelemetry starter and export to Maple

Spring AI 2.0 requires Spring Boot 4. Import the Spring AI BOM and add your model starter, Boot's OpenTelemetry starter and Actuator:

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>2.0.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-opentelemetry</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
  </dependency>
</dependencies>
```

`spring-boot-starter-opentelemetry` brings the Micrometer-to-OpenTelemetry tracing bridge, the OpenTelemetry SDK and the OTLP exporter. With Gradle, use the same three artifacts and `platform("org.springframework.ai:spring-ai-bom:2.0.1")`.

Then point the exporter at Maple in `application.properties`:

```properties
spring.application.name=support-agent

management.opentelemetry.tracing.export.otlp.endpoint=https://ingest.maple.dev/v1/traces
management.opentelemetry.tracing.export.otlp.headers.Authorization=Bearer ${MAPLE_INGEST_KEY}
management.tracing.sampling.probability=1.0
management.opentelemetry.resource-attributes.deployment.environment.name=production

# The starter also exports metrics, to localhost:4318 unless told otherwise
management.otlp.metrics.export.url=https://ingest.maple.dev/v1/metrics
management.otlp.metrics.export.headers.Authorization=Bearer ${MAPLE_INGEST_KEY}

# Read by the configuration class below
maple.ai.capture-content=true
# Token usage on streamed OpenAI calls
spring.ai.openai.chat.stream-options.include-usage=true
```

EU organizations use `https://ingest.eu.maple.dev`. Unlike the `OTEL_EXPORTER_OTLP_ENDPOINT` variable, this property takes the full URL, so keep `/v1/traces` on the end. The transport defaults to OTLP over HTTP with protobuf, which is what Maple ingest expects. `spring.application.name` becomes `service.name`.

`management.tracing.sampling.probability=1.0` is the line that matters most. Boot's default is `0.1`, and a sampled-out turn leaves a hole in the session with no error anywhere. If you'd rather not send metrics, replace the two metrics lines with `management.otlp.metrics.export.enabled=false`.

On Boot 4.1 you can configure the exporter with the standard variables instead: `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev` and `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer YOUR_INGEST_KEY` cover traces, metrics and logs, and Boot appends the signal path itself. Keep the sampling property either way.

## Add the attributes Maple reads

Spring AI's spans get you model calls and tokens. The transcript, tool names, failed tools and agent names need one configuration class. It uses three standard Micrometer and Spring AI extension points, so no Spring AI class is patched or replaced:

```java
package com.example.agent;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import io.micrometer.common.KeyValue;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationFilter;
import io.micrometer.observation.ObservationPredicate;
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

	// Advisor spans carry nothing Maple reads, and their names ("tool _calling ",
	// "message_chat_memory") would be counted as extra tool and LLM calls.
	@Bean
	ObservationPredicate skipAdvisorObservations() {
		return (name, context) -> !(context instanceof AdvisorObservationContext);
	}

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

What each bean does:

- **`ObservationPredicate`** drops the advisor observations. Their spans hold only an advisor name and order, and Maple classifies spans without a known operation by name: `tool _calling ` would count as a tool call and `message_chat_memory` as a model call on every turn. Child spans still attach to the `chat_client` span, because Micrometer keeps the scope of a skipped observation.
- **`ObservationFilter`** runs when each observation stops, after Spring AI's own conventions. It relabels the `chat_client` span as `invoke_agent` (Spring AI calls it `framework`, which Maple would otherwise count as a model call because the span name contains "chat"), copies the tool name and call id to the `gen_ai.tool.*` keys, and writes the conversation as `gen_ai.input.messages` and `gen_ai.output.messages`.
- **`ToolExecutionExceptionProcessor`** marks the running tool span as failed before Spring AI turns the exception into a message for the model. See [Tools, errors and sub-agents](#tools-errors-and-sub-agents).

Boot applies `ObservationPredicate` and `ObservationFilter` beans to the observation registry by itself; there is nothing else to register. The class works the same in Kotlin; for example, the predicate is `ObservationPredicate { _, context -> context !is AdvisorObservationContext }`.

### Spring AI 1.1 on Spring Boot 3.5

The same approach works, with these differences:

| | Spring AI 2.0, Boot 4 | Spring AI 1.1, Boot 3.5 |
|---|---|---|
| Tracing dependencies | `spring-boot-starter-opentelemetry` | `io.micrometer:micrometer-tracing-bridge-otel` and `io.opentelemetry:opentelemetry-exporter-otlp` |
| Endpoint property | `management.opentelemetry.tracing.export.otlp.endpoint` | `management.otlp.tracing.endpoint` |
| Header property | `management.opentelemetry.tracing.export.otlp.headers.*` | `management.otlp.tracing.headers.*` |
| JSON in the filter | Jackson 3 `JsonMapper.shared()` | Jackson 2 `ObjectMapper` (checked exception) |
| Tool call id | `getToolCallId()` | not available, drop those lines |
| OpenAI model property | `spring.ai.openai.chat.model` | `spring.ai.openai.chat.options.model` |

Boot 4 still accepts the Boot 3 property names but marks them deprecated.

## Group turns into one session

A chat backend handles one request per user message, and each `ChatClient` call is its own trace. Maple joins those traces into one session by the `spring.ai.chat.client.conversation.id` attribute on the `chat_client` span. Spring AI sets it from the `ChatMemory.CONVERSATION_ID` advisor parameter, the same parameter that selects the chat memory history:

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.stereotype.Service;

@Service
public class ChatService {

	private final ChatClient chatClient;

	public ChatService(ChatClient.Builder builder, ChatMemory chatMemory, SupportTools tools) {
		this.chatClient = builder
			.defaultSystem("You are a concise support assistant.")
			.defaultTools(tools)
			.defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
			.defaultAdvisors(a -> a.param(MapleAiObservationConfig.AGENT_NAME, "support_agent"))
			.build();
	}

	public String reply(String conversationId, String userMessage) {
		return chatClient.prompt()
			.user(userMessage)
			.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
			.call()
			.content();
	}

}
```

Without the parameter, the attribute is missing and Maple shows every message as its own one-turn session, named after its trace id. Things to get right:

- **Pass the id on every call.** It belongs on the request (`.advisors(...)` on `prompt()`), not on the builder. A constant set with `defaultAdvisors` puts every user into one session.
- **Use the conversation id your app already stores**, not a fresh UUID per request.
- **The id works without chat memory.** If your app sends the history itself, pass the parameter anyway; Spring AI records it from the request whether or not a memory advisor reads it.
- **Sub-agents don't need it.** Maple groups a whole trace by any span in it that carries the id, so the top-level `ChatClient` call is enough.

Maple reads only `spring.ai.chat.client.conversation.id` for Spring AI spans. Adding `gen_ai.conversation.id` or `session.id` does nothing here.

## Record prompts, responses and tool calls

Spring AI has content switches, but none of them put the conversation where Maple reads it:

- `spring.ai.chat.observations.log-prompt` and `log-completion` (and the `spring.ai.chat.client.observations.*` pair) write the prompt and reply to SLF4J at INFO level, with the trace id for correlation. They never add span attributes, and Maple's session views read span attributes only.
- `spring.ai.tools.observations.include-content` puts tool arguments and results on the span, but under `spring.ai.tool.call.arguments` and `spring.ai.tool.call.result`, which Maple doesn't read.

With `maple.ai.capture-content=true`, the filter above writes the attributes Maple does read:

| Span | Attributes | Contents |
|---|---|---|
| `chat <model>` | `gen_ai.input.messages` | everything sent to the model: system prompt, the history chat memory added, tool calls and tool results |
| `chat <model>` | `gen_ai.output.messages` | the reply, including tool calls the model asked for |
| `execute_tool <name>` | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | the JSON arguments and the string returned to the model |

Maple builds the transcript from these and labels each turn with the first line of the user's message. You can leave the Spring AI switches off; they only add log lines.

Every `chat` span carries the whole conversation so far, so spans grow with long chats. Don't set `management.opentelemetry.tracing.limits.max-attribute-value-length`: a cut JSON value no longer parses, and Maple drops it.

### Privacy: turn content off or redact it

Set `maple.ai.capture-content=false` (the default in the class) and no message or tool content leaves the process. Sessions, turns, model names, tokens, tool names and failures still show up; the transcript is empty. To redact instead, change `message(...)` to mask what you don't want sent, for example email addresses in text parts. Keep personal data out of the conversation id and agent names; they are sent regardless of the setting.

## Tools, errors and sub-agents

Every tool call gets an `execute_tool <tool name>` span. Spring AI puts the name in `spring.ai.tool.definition.name`; the filter copies it to `gen_ai.tool.name`, which Maple reads for the tool pages.

### Failed tools

When a `@Tool` method throws, Spring AI's default `ToolExecutionExceptionProcessor` returns the exception message to the model as the tool result, and the `execute_tool` span ends with status OK. The model usually recovers gracefully, which is good for users and bad for debugging: Maple would count the call as a success.

The processor bean in the configuration class calls `error()` on the running tool observation first. The span gets status `Error` with the exception message and an `exception` event, Maple counts it as a failed tool call, and the model still gets the message. Successful calls are untouched.

Two things to know:

- Defining the bean replaces Spring AI's, so `spring.ai.tools.throw-exception-on-error` no longer applies. To fail the whole call instead, build the fallback with `.alwaysThrow(true)`.
- If your app already defines a `ToolExecutionExceptionProcessor`, add the `error()` call to it instead of adding a second bean.

A tool that returns an error string instead of throwing is a success as far as any tracer can tell. Throw if you want the failure counted.

### Sub-agents as tools

Spring AI has no agent class. The idiomatic multi-agent setup is one `ChatClient` per role, with the orchestrator calling the others through `@Tool` methods. Give each client its own agent name:

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

In Maple, `execute_tool weather_worker` with the worker's `chat_client` span under it shows up as a delegation into a `weather_worker` lane, with the task as its input and the worker's answer as its output. A client without an agent name gets no lane; its model and tool calls are drawn in the caller's lane.

Spring AI runs the tool calls of one model response one after another, on the calling thread, so context flows without help. If you fan work out to your own executor, propagate the current observation to the worker threads with Micrometer's `context-propagation` library (`ContextSnapshot`, or a wrapped executor). Otherwise each worker starts a new trace, and since it carries no conversation id, Maple shows it as a separate session.

## Tokens and cost

Every `chat` span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` when the provider reports them. Maple reads all four. The `chat_client` spans carry no usage, so nothing is counted twice.

Streaming has one catch. OpenAI (and OpenAI-compatible gateways such as OpenRouter) only return usage on a stream when the request asks for it. Without `spring.ai.openai.chat.stream-options.include-usage=true`, or `OpenAiChatOptions.builder().streamUsage(true)` per call, streamed turns show zero tokens.

Spring AI records the provider as `gen_ai.system`, derived from the client class rather than the model. Behind OpenRouter, a Claude model called through the OpenAI starter is labeled `openai`. Maple uses the provider only to decide whether cached tokens are included in the input count, so this matters only for cache figures.

Spring AI emits no cost attribute, and Maple never prices tokens itself, so sessions show as unpriced.

## Short-lived processes

Spring Boot owns the `SdkTracerProvider` and shuts it down when the application context closes, which flushes the batch of pending spans. A web app needs nothing extra. For other shapes:

- **`CommandLineRunner` apps and batch jobs.** Let `run()` return, or exit through `SpringApplication.exit(context)`. `System.exit()` still runs Boot's shutdown hook; `kill -9` and `Runtime.halt()` lose the last batch.
- **Serverless (Spring Cloud Function on AWS Lambda and similar).** The runtime freezes the process between invocations, so flush before returning from each one. Don't shut the provider down.

```java
import java.util.concurrent.TimeUnit;

import io.opentelemetry.sdk.trace.SdkTracerProvider;

// inject SdkTracerProvider, then at the end of each invocation:
tracerProvider.forceFlush().join(10, TimeUnit.SECONDS);
```

The exporter sends a batch every 5 seconds by default, so allow a few seconds after a conversation before looking for it in Maple.

## Running the OpenTelemetry Java agent too

Use one tracing setup per service. The OpenTelemetry Java agent does not turn Micrometer Observations into spans, so with the agent alone you get the HTTP spans but no `chat_client`, `chat` or `execute_tool` span. You still need the starter from this guide.

If the agent has to stay (it also instruments JDBC, Kafka and other libraries), three things change:

- **Model calls appear twice.** The agent instruments the OpenAI Java SDK, which Spring AI 2.0's OpenAI starter uses underneath, and adds its own `chat <model>` span to every call. Turn it off with `-Dotel.instrumentation.openai-java.enabled=false`.
- **HTTP requests appear twice**, once from the agent and once from Boot's `http.server.requests` observation. Set `management.observations.enable.http.server.requests=false`.
- **Two exporters run.** Point the agent (`OTEL_EXPORTER_OTLP_*`) and Boot (the properties above) at Maple, or traces arrive with gaps.

We tested the starter setup end to end; the agent combination above is not covered by our tests.

## Check that it works

Run one conversation of two or three messages with the same conversation id, including one that calls a tool, plus a message with a second id. Wait about a minute, then open **Agent Sessions** in Maple. You should see:

- **One session per conversation id**, with the framework shown as Spring AI and one turn per `ChatClient` call. A list of one-turn sessions named after trace ids means the `ChatMemory.CONVERSATION_ID` parameter is missing.
- **Spans named** `spring_ai chat_client` (as an agent span named after your `gen_ai.agent.name`), `chat openai/gpt-4o-mini` (your model id) and `execute_tool get_weather`. HTTP `POST` spans to the model provider appear muted next to them.
- **No spans named** `tool _calling `, `call` or `message_chat_memory`. If they show up, the `ObservationPredicate` bean isn't loaded.
- **The transcript**: each user message, the assistant's replies, and the tool calls with their arguments and results.
- **Tokens** on every model call, including streamed ones.
- **Sub-agents** as lanes named after each client's agent name, and a tool that threw counted as a failed tool call under its own name.
- **Cost** shown as unpriced.

## Troubleshooting

- **Only some turns arrive, or sessions have gaps.** Sampling is at Boot's default of 10%. Set `management.tracing.sampling.probability=1.0`.
- **Every message is its own session.** The `chat_client` span has no `spring.ai.chat.client.conversation.id`. Pass `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, id))` on every `prompt()` call.
- **All users land in one session.** The conversation id is a constant, usually set once with `defaultAdvisors` on the builder. Pass it per request.
- **Transcript is empty, but tokens and tools show up.** `maple.ai.capture-content` isn't `true`, or `MapleAiObservationConfig` isn't in a package Spring scans. `log-prompt` and `log-completion` don't help; they write to the log.
- **Twice as many model calls as expected, and a tool called `tool _calling ` in the tool list.** The advisor and `chat_client` spans are being counted. Make sure the `ObservationPredicate` and `ObservationFilter` beans are loaded.
- **A tool that threw shows as successful.** The custom `ToolExecutionExceptionProcessor` isn't active, or the app defines its own. Add the `registry.getCurrentObservation().error(exception)` call to the one that runs.
- **Streamed turns show zero tokens.** Add `spring.ai.openai.chat.stream-options.include-usage=true`.
- **A sub-agent shows up as its own session.** It ran on a thread without the caller's trace context. Propagate the observation to the executor, or run the sub-agent on the calling thread.
- **Tool names are missing on the tool pages.** The `ObservationFilter` isn't running; Spring AI alone emits only `spring.ai.tool.definition.name`.
- **Framework shows as Unidentified on some model spans.** With starters other than OpenAI, a `chat` span for a call without tools has no Spring AI marker, so Maple files it as a generic GenAI span. The session, transcript and tokens are unaffected.
- **Nothing arrives from tests.** `@SpringBootTest` turns tracing export off. Add `@AutoConfigureTracing` to the test class if you want spans from tests.
- **`Failed to publish metrics` warnings every minute.** The starter's metrics exporter is still pointed at `localhost:4318`. Set the two `management.otlp.metrics.export.*` lines or disable metrics export.
- **`401` from ingest.** The key is wrong or from the other region. The property must read `...headers.Authorization=Bearer YOUR_INGEST_KEY`.
- **Using LangChain4j instead of Spring AI.** This guide doesn't apply. Follow the [OpenTelemetry GenAI guide](/docs/agent-tracing/opentelemetry).

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Any language: the OpenTelemetry GenAI conventions](/docs/agent-tracing/opentelemetry)
- [Spring AI observability reference](https://docs.spring.io/spring-ai/reference/observability/index.html)
- [Spring AI tool calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Spring Boot tracing reference](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
