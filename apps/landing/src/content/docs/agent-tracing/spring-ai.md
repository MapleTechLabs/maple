---
title: "Trace Spring AI agents with OpenTelemetry"
description: "Send Spring AI ChatClient, model and tool spans to Maple, with one session per chat memory conversation."
group: "AI Agents"
order: 31
navLabel: "Spring AI"
icon: "spring"
---

Spring AI already emits spans for `ChatClient`, model and tool calls, with token counts. You add Spring Boot's OpenTelemetry starter, set sampling to 100%, add one configuration class for the transcript, tool names and failed tools, and pass the conversation id on every call.

Tested with Spring AI 2.0.1 on Spring Boot 4.1.1 and Java 21. Spring AI 1.1 on Boot 3.5 works too, with different dependencies and property names listed in the [skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai).

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-spring-ai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai) skill and follows it.

```text
Set up Maple agent tracing for Spring AI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-spring-ai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the OpenTelemetry starter

Next to the `spring-ai-bom` import (2.0.1) and your model starter, such as `spring-ai-starter-model-openai`, add Boot's OpenTelemetry starter:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-opentelemetry</artifactId>
</dependency>
```

## Export to Maple

Add to `application.properties`:

```properties
spring.application.name=support-agent

management.opentelemetry.tracing.export.otlp.endpoint=https://ingest.maple.dev/v1/traces
management.opentelemetry.tracing.export.otlp.headers.Authorization=Bearer ${MAPLE_INGEST_KEY:}
management.tracing.sampling.probability=1.0
management.opentelemetry.resource-attributes.deployment.environment.name=production

# The starter also exports metrics, to localhost:4318 unless told otherwise
management.otlp.metrics.export.url=https://ingest.maple.dev/v1/metrics
management.otlp.metrics.export.headers.Authorization=Bearer ${MAPLE_INGEST_KEY:}

# Read by the configuration class below
maple.ai.capture-content=true
```

The empty default in `${MAPLE_INGEST_KEY:}` keeps the app starting when the key is missing. To avoid sending requests without a key, turn export off at the top of `main` in that case:

```java
public static void main(String[] args) {
	// A missing key disables export; it never stops the app.
	var mapleKey = System.getenv("MAPLE_INGEST_KEY");
	if (mapleKey == null || mapleKey.isEmpty()) {
		System.err.println("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled");
		System.setProperty("management.tracing.export.enabled", "false");
		System.setProperty("management.otlp.metrics.export.enabled", "false");
	}
	SpringApplication.run(Application.class, args);
}
```

Spring Boot doesn't read `.env` files, so set `MAPLE_INGEST_KEY` in the environment that starts the JVM.

For an EU organization, use `https://ingest.eu.maple.dev`. This property takes the full URL, so keep `/v1/traces` on the end. To skip metrics, replace the two metrics lines with `management.otlp.metrics.export.enabled=false`.

Keep `management.tracing.sampling.probability=1.0`. Boot's default of `0.1` silently drops nine turns out of ten.

## Add the attributes Maple reads

Add this class in a package your application scans:

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

@Configuration(proxyBeanMethods = false)
public class MapleAiObservationConfig {

	/** Agent name for a ChatClient: `.defaultAdvisors(a -> a.param(AGENT_NAME, "support_agent"))`. */
	public static final String AGENT_NAME = "gen_ai.agent.name";

	@Bean
	ObservationFilter mapleGenAiAttributes(@Value("${maple.ai.capture-content:false}") boolean captureContent) {
		return context -> {
			if (context instanceof ChatClientObservationContext client) {
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

If your app already defines a `ToolExecutionExceptionProcessor`, add the `error()` call to it instead of adding a second bean.

The transcript comes from `maple.ai.capture-content=true`. Spring AI's own `log-prompt` and `log-completion` settings only write to the application log. Set it to `false` to keep message and tool content out of Maple; everything else still shows up, with an empty transcript. A failed tool's exception message is still sent.

## Group turns into one session

Pass the `ChatMemory.CONVERSATION_ID` advisor parameter on every request. Spring AI writes it to the `spring.ai.chat.client.conversation.id` attribute, which Maple groups sessions by:

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

Use the conversation id your app already stores. Set it on the request, as above, and never with `defaultAdvisors` on the builder, which puts every user in one session. The parameter works without a chat memory advisor. Sub-agent calls inside tools don't need it.

## Exit command-line apps explicitly

A web app needs nothing extra: Boot flushes pending spans on shutdown. In a `CommandLineRunner` app, exit explicitly, or the OpenAI client's threads hold the JVM and the unsent spans for about 60 seconds:

```java
public static void main(String[] args) {
	System.exit(SpringApplication.exit(SpringApplication.run(Application.class, args)));
}
```

On serverless platforms, inject `SdkTracerProvider` and call `tracerProvider.forceFlush().join(10, TimeUnit.SECONDS)` at the end of each invocation.

## Check that it works

Send two or three messages with the same conversation id, including one that calls a tool. After about a minute, **Agent Sessions** in Maple shows one session for that id with framework **Spring AI**, one turn per `ChatClient` call, the transcript, and tokens on every model call. Cost shows as unpriced, because Spring AI doesn't report it.

## Troubleshooting

- **Only some turns arrive.** Sampling is at Boot's default of 10%. Set `management.tracing.sampling.probability=1.0`.
- **Every message is its own session.** Pass `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, id))` on every `prompt()` call.
- **The transcript is empty.** `maple.ai.capture-content` isn't `true`, or `MapleAiObservationConfig` isn't in a scanned package.
- **Every span is its own trace.** The OpenTelemetry Java agent is attached next to the starter. Remove it, or follow the Java agent steps in the [skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-spring-ai).

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Spring AI observability reference](https://docs.spring.io/spring-ai/reference/observability/index.html)
- [Spring Boot tracing reference](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
