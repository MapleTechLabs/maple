---
title: "Trace Spring AI agents with OpenTelemetry"
description: "Send Spring AI ChatClient, model and tool spans to Maple, with one session per chat memory conversation."
group: "AI Agents"
order: 31
navLabel: "Spring AI"
icon: "spring"
---

Spring AI already emits a `spring_ai chat_client` span per `ChatClient` call, a `chat <model>` span per model call and an `execute_tool <name>` span per tool call, with model and token counts. You add Spring Boot's OpenTelemetry starter, set sampling to 100%, and add one configuration class that writes the transcript, tool names and failed tools where Maple reads them. The thing to get right is passing the conversation id on every call.

Tested with Spring AI 2.0.1 on Spring Boot 4.1.1 and Java 21. Spring AI 1.1 on Boot 3.5 works too, with different dependencies and property names listed in the [skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai).

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-spring-ai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Spring AI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-spring-ai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**.

## Install the OpenTelemetry starter

Next to the `spring-ai-bom` import (2.0.1) and your model starter, such as `spring-ai-starter-model-openai`, add Boot's OpenTelemetry starter:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-opentelemetry</artifactId>
</dependency>
```

It brings the Micrometer tracing bridge, the OpenTelemetry SDK and the OTLP exporter. Boot 4 doesn't need Actuator for tracing.

## Export to Maple

Add to `application.properties`:

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
```

For an EU organization, use `https://ingest.eu.maple.dev`. This property takes the full URL, so keep `/v1/traces` on the end. To skip metrics, replace the two metrics lines with `management.otlp.metrics.export.enabled=false`.

Keep `management.tracing.sampling.probability=1.0`. Boot's default is `0.1`, which drops nine turns out of ten without any error.

## Add the attributes Maple reads

Add this class in a package your application scans. Boot registers both beans by itself:

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

The `ObservationFilter` marks each `ChatClient` call as an agent turn, copies tool names and call ids to the `gen_ai.tool.*` keys, and, with `maple.ai.capture-content=true`, writes the messages and tool arguments and results to the spans. Spring AI's own `log-prompt` and `log-completion` settings only write to the application log. The filter also renames the advisor spans, which Maple would otherwise count as extra model and tool calls.

The `ToolExecutionExceptionProcessor` marks a tool span as failed when the tool throws, then hands the error to the model as before. If your app already defines one, add the `error()` call to it instead of adding a second bean.

Set `maple.ai.capture-content=false` to keep message and tool content out of Maple. Sessions, tokens, tool names and failures still show up, with an empty transcript.

## Group turns into one session

Maple joins the traces of one conversation by the `spring.ai.chat.client.conversation.id` attribute. Spring AI sets it from the `ChatMemory.CONVERSATION_ID` advisor parameter, so pass that parameter on every request:

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

Use the conversation id your app already stores. Set it on the request, as above, and never with `defaultAdvisors` on the builder, which puts every user in one session. The parameter works without a chat memory advisor. Sub-agent calls inside tools don't need it, because they run in the same trace.

## Exit command-line apps explicitly

A web app needs nothing extra: Boot flushes pending spans on shutdown. In a `CommandLineRunner` app, exit explicitly, or the OpenAI client's threads keep the JVM (and the unsent spans) waiting about 60 seconds:

```java
public static void main(String[] args) {
	System.exit(SpringApplication.exit(SpringApplication.run(Application.class, args)));
}
```

On serverless platforms, inject `SdkTracerProvider` and call `tracerProvider.forceFlush().join(10, TimeUnit.SECONDS)` at the end of each invocation.

## Check that it works

Send two or three messages with the same conversation id, including one that calls a tool. After about a minute, **Agent Sessions** in Maple shows one session for that id with framework **Spring AI**, one turn per `ChatClient` call, the transcript, and tokens on every model call. Cost shows as unpriced, because Spring AI doesn't emit one.

## Troubleshooting

- **Only some turns arrive.** Sampling is at Boot's default of 10%. Set `management.tracing.sampling.probability=1.0`.
- **Every message is its own session.** Pass `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, id))` on every `prompt()` call.
- **The transcript is empty.** `maple.ai.capture-content` isn't `true`, or `MapleAiObservationConfig` isn't in a scanned package.
- **Model calls are doubled and a tool named `tool _calling ` appears.** The `ObservationFilter` bean isn't loaded.
- **Every span is its own trace.** The OpenTelemetry Java agent is attached next to the starter. Remove it, or follow the Java agent steps in the [skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai).

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Any language: the OpenTelemetry GenAI conventions](/docs/agent-tracing/opentelemetry), also for LangChain4j
- [Spring AI observability reference](https://docs.spring.io/spring-ai/reference/observability/index.html)
- [Spring AI tool calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Spring Boot tracing reference](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
