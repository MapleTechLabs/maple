ARG OTEL_BUILDER_VERSION=v0.151.0
ARG GO_VERSION=1.25

# ---- builder ----
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS builder

ARG OTEL_BUILDER_VERSION
ARG TARGETOS
ARG TARGETARCH

RUN apk add --no-cache git ca-certificates

# Install ocb pinned to the same release as the exporter's go.mod.
RUN CGO_ENABLED=0 go install go.opentelemetry.io/collector/cmd/builder@${OTEL_BUILDER_VERSION}

WORKDIR /src

# Copy only what ocb needs to compile. Ordering preserves docker layer cache:
# the (rarely-changed) builder config + go.mod come first; sources last.
COPY otel/builder-config.yaml ./builder-config.yaml
COPY ../packages/otel-collector-maple-exporter/go.mod ./packages/otel-collector-maple-exporter/
COPY ../packages/otel-collector-maple-exporter/go.sum* ./packages/otel-collector-maple-exporter/
COPY ../packages/otel-collector-maple-exporter ./packages/otel-collector-maple-exporter

ENV CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH}

RUN /go/bin/builder --config=builder-config.yaml \
    && ls -lh ./bin/otel-collector-maple

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /src/bin/otel-collector-maple /otel-collector-maple

# 4317 = OTLP gRPC, 4318 = OTLP HTTP, 13133 = health_check.
EXPOSE 4317 4318 13133

ENTRYPOINT ["/otel-collector-maple"]
CMD ["--config=/etc/otel/config.yaml"]
