# Go reference

Pattern for `go.opentelemetry.io/otel` v1.46 (`sdk`, `exporters/otlp/otlptrace/otlptracehttp` v1.46). Not compiled in authoring; run `go vet ./...` after adding it.

```bash
go get go.opentelemetry.io/otel go.opentelemetry.io/otel/sdk go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
```

Wrap the project's existing client call in `Chat` and tool dispatch in `Tool`. Pass the `ctx` returned by `StartTurn` into both, or the spans become separate traces. Set `gen_ai.provider.name` to the API actually called. Copy cache/reasoning counts when the provider returns them (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.reasoning.output_tokens`).

```go
// genai.go
package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("support-agent")

// SetupTracing reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
// Call Shutdown on the returned provider before the process exits.
func SetupTracing(ctx context.Context) (*sdktrace.TracerProvider, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", "support-agent"),
			attribute.String("deployment.environment.name", "production"),
		)),
	)
	otel.SetTracerProvider(tp)
	return tp, nil
}

// Message is the GenAI semconv shape: {role, parts}.
type Message struct {
	Role         string           `json:"role"`
	Parts        []map[string]any `json:"parts"`
	FinishReason string           `json:"finish_reason,omitempty"`
}

// ChatResult holds what your provider returned, copied verbatim.
type ChatResult struct {
	ID, Model, FinishReason   string
	Output                    Message
	InputTokens, OutputTokens int64
	CostUSD                   float64 // 0 when the provider doesn't return a cost
}

func jsonAttr(key string, value any) attribute.KeyValue {
	b, _ := json.Marshal(value)
	return attribute.String(key, string(b))
}

func fail(span trace.Span, err error) {
	span.SetStatus(codes.Error, err.Error())
	span.SetAttributes(attribute.String("error.type", fmt.Sprintf("%T", err)))
}

// StartTurn opens the invoke_agent span for one user message. End it when the turn is done.
func StartTurn(ctx context.Context, agentName, conversationID string) (context.Context, trace.Span) {
	return tracer.Start(ctx, "invoke_agent "+agentName, trace.WithAttributes(
		attribute.String("gen_ai.operation.name", "invoke_agent"),
		attribute.String("gen_ai.agent.name", agentName),
		attribute.String("gen_ai.conversation.id", conversationID),
	))
}

// Chat wraps one model call (your existing client code goes in call).
func Chat(ctx context.Context, model string, input []Message, call func(context.Context) (ChatResult, error)) (ChatResult, error) {
	ctx, span := tracer.Start(ctx, "chat "+model, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("gen_ai.operation.name", "chat"),
		attribute.String("gen_ai.provider.name", "openai"),
		attribute.String("gen_ai.request.model", model),
		jsonAttr("gen_ai.input.messages", input),
	))
	defer span.End()
	res, err := call(ctx)
	if err != nil {
		fail(span, err)
		return res, err
	}
	res.Output.FinishReason = res.FinishReason
	span.SetAttributes(
		attribute.String("gen_ai.response.id", res.ID),
		attribute.String("gen_ai.response.model", res.Model),
		attribute.StringSlice("gen_ai.response.finish_reasons", []string{res.FinishReason}),
		attribute.Int64("gen_ai.usage.input_tokens", res.InputTokens),
		attribute.Int64("gen_ai.usage.output_tokens", res.OutputTokens),
		jsonAttr("gen_ai.output.messages", []Message{res.Output}),
	)
	if res.CostUSD > 0 {
		span.SetAttributes(attribute.Float64("gen_ai.usage.cost", res.CostUSD))
	}
	return res, nil
}

// Tool wraps one tool call. result must marshal to a JSON object or array.
func Tool(ctx context.Context, name, callID, arguments string, run func(context.Context) (any, error)) (string, error) {
	ctx, span := tracer.Start(ctx, "execute_tool "+name, trace.WithAttributes(
		attribute.String("gen_ai.operation.name", "execute_tool"),
		attribute.String("gen_ai.tool.name", name),
		attribute.String("gen_ai.tool.call.id", callID),
		attribute.String("gen_ai.tool.call.arguments", arguments),
	))
	defer span.End()
	result, err := run(ctx)
	if err != nil {
		fail(span, err)
		return "", err
	}
	b, _ := json.Marshal(result)
	span.SetAttributes(attribute.String("gen_ai.tool.call.result", string(b)))
	return string(b), nil
}
```

Usage:

```go
tp, err := agent.SetupTracing(ctx)
if err != nil {
	log.Fatal(err)
}
defer tp.Shutdown(context.Background())

ctx, turn := agent.StartTurn(ctx, "support", chatID)
defer turn.End()
res, err := agent.Chat(ctx, model, input, func(ctx context.Context) (agent.ChatResult, error) {
	return callModel(ctx, model, input) // your existing client code
})
```

Failure on the turn span: call the same `fail(turn, err)` pattern before returning an error.

## Other languages (Rust, Ruby, Elixir, Java, .NET)

Same three spans, same attribute keys and value types (string, int64, double, string array). Serialize every messages/tool payload to a JSON string before setting it. Register the SDK's context propagation so child spans nest (Rust: `Context::current_with_span` / `tracing-opentelemetry`; Ruby: `in_span`; Elixir: `OpenTelemetry.Tracer.with_span`).

