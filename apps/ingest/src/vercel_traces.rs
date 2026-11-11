//! Restates a Vercel trace drain's function spans under their project.
//!
//! Vercel sends every project's function spans as the one service
//! `vercel.serverless-runtime`, which merges all projects into one service map
//! node. The spans that are the project's own work (each `Invoke Function` and
//! its outbound Client/Producer calls) move to a resource named after the
//! project, the same service name its log drain uses. Platform phases
//! (`waitUntil`, cold-start steps) stay under `vercel.serverless-runtime`, so
//! they do not count as the project's requests.

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
use std::collections::HashMap;
use std::hash::BuildHasher;

/// The shared service Vercel sends every project's function spans as.
pub const RUNTIME_SERVICE: &str = "vercel.serverless-runtime";

/// Stamped on every runtime resource, renamed or not, so queries find Vercel's runtime spans.
pub const PLATFORM_SERVICE_ATTRIBUTE: &str = "maple_vercel.platform_service";

const INVOKE_FUNCTION_SPAN: &str = "Invoke Function";

/// Whether the request has a resource from Vercel's serverless runtime.
pub fn has_runtime_resources(request: &ExportTraceServiceRequest) -> bool {
    request.resource_spans.iter().any(is_runtime)
}

/// Marks every runtime resource and moves the project's own spans to a resource
/// named after the project. `project_names` maps a Vercel project id to its name;
/// a project missing from it keeps its spans where they are.
pub fn restate<S: BuildHasher>(
    request: &mut ExportTraceServiceRequest,
    project_names: &HashMap<String, String, S>,
) {
    let mut restated = Vec::with_capacity(request.resource_spans.len());
    for mut resource_spans in std::mem::take(&mut request.resource_spans) {
        if !is_runtime(&resource_spans) {
            restated.push(resource_spans);
            continue;
        }
        let project = split_project(&mut resource_spans, project_names);
        if !resource_spans.scope_spans.is_empty() {
            restated.push(resource_spans);
        }
        restated.extend(project);
    }
    request.resource_spans = restated;
}

/// Stamps the marker, then takes the project's spans into their own resource.
fn split_project<S: BuildHasher>(
    resource_spans: &mut ResourceSpans,
    project_names: &HashMap<String, String, S>,
) -> Option<ResourceSpans> {
    let resource = resource_spans.resource.as_mut()?;
    set_string(
        &mut resource.attributes,
        PLATFORM_SERVICE_ATTRIBUTE,
        RUNTIME_SERVICE,
    );
    let project_id = string_value(&resource.attributes, "vercel.projectId")
        .or_else(|| string_value(&resource.attributes, "vercel.project_id"))?;
    let name = project_names.get(project_id)?;

    let mut project_resource = resource.clone();
    set_string(&mut project_resource.attributes, "service.name", name);
    if string_value(&project_resource.attributes, "cloud.provider").is_none() {
        set_string(&mut project_resource.attributes, "cloud.provider", "vercel");
    }

    let mut project_scopes = Vec::new();
    for scope_spans in &mut resource_spans.scope_spans {
        let (moved, kept): (Vec<Span>, Vec<Span>) = std::mem::take(&mut scope_spans.spans)
            .into_iter()
            .partition(is_project_work);
        scope_spans.spans = kept;
        if !moved.is_empty() {
            project_scopes.push(ScopeSpans {
                scope: scope_spans.scope.clone(),
                spans: moved,
                schema_url: scope_spans.schema_url.clone(),
            });
        }
    }
    resource_spans
        .scope_spans
        .retain(|scope_spans| !scope_spans.spans.is_empty());
    if project_scopes.is_empty() {
        return None;
    }
    Some(ResourceSpans {
        resource: Some(project_resource),
        scope_spans: project_scopes,
        schema_url: resource_spans.schema_url.clone(),
    })
}

fn is_project_work(span: &Span) -> bool {
    span.kind == SpanKind::Client as i32
        || span.kind == SpanKind::Producer as i32
        || span.name == INVOKE_FUNCTION_SPAN
}

fn is_runtime(resource_spans: &ResourceSpans) -> bool {
    resource_spans
        .resource
        .as_ref()
        .and_then(|resource| string_value(&resource.attributes, "service.name"))
        == Some(RUNTIME_SERVICE)
}

fn string_value<'a>(attributes: &'a [KeyValue], key: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|attribute| attribute.key == key)
        .and_then(
            |attribute| match attribute.value.as_ref()?.value.as_ref()? {
                any_value::Value::StringValue(value) => Some(value.as_str()),
                _ => None,
            },
        )
}

fn set_string(attributes: &mut Vec<KeyValue>, key: &str, value: &str) {
    let value = Some(AnyValue {
        value: Some(any_value::Value::StringValue(value.to_owned())),
    });
    match attributes.iter_mut().find(|attribute| attribute.key == key) {
        Some(attribute) => attribute.value = value,
        None => attributes.push(KeyValue {
            key: key.to_owned(),
            value,
            ..Default::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use opentelemetry_proto::tonic::resource::v1::Resource;

    fn attribute(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_owned())),
            }),
            ..Default::default()
        }
    }

    fn span(name: &str, kind: SpanKind) -> Span {
        Span {
            name: name.to_owned(),
            kind: kind as i32,
            ..Default::default()
        }
    }

    fn resource_spans(attributes: Vec<KeyValue>, spans: Vec<Span>) -> ResourceSpans {
        ResourceSpans {
            resource: Some(Resource {
                attributes,
                ..Default::default()
            }),
            scope_spans: vec![ScopeSpans {
                scope: Some(InstrumentationScope {
                    name: "vercel".to_owned(),
                    ..Default::default()
                }),
                spans,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn runtime_attributes(project_id_key: &str) -> Vec<KeyValue> {
        vec![
            attribute("service.name", RUNTIME_SERVICE),
            attribute(project_id_key, "prj_1"),
            attribute("deployment.environment.name", "production"),
        ]
    }

    fn names() -> HashMap<String, String> {
        HashMap::from([("prj_1".to_owned(), "docs-verify-eve".to_owned())])
    }

    fn resource_value<'a>(resource_spans: &'a ResourceSpans, key: &str) -> Option<&'a str> {
        string_value(&resource_spans.resource.as_ref()?.attributes, key)
    }

    fn span_names(resource_spans: &ResourceSpans) -> Vec<&str> {
        resource_spans
            .scope_spans
            .iter()
            .flat_map(|scope_spans| &scope_spans.spans)
            .map(|span| span.name.as_str())
            .collect()
    }

    fn request(resource_spans: Vec<ResourceSpans>) -> ExportTraceServiceRequest {
        ExportTraceServiceRequest { resource_spans }
    }

    #[test]
    fn moves_invocations_and_outbound_calls_to_the_project_service() {
        let mut request = request(vec![resource_spans(
            runtime_attributes("vercel.projectId"),
            vec![
                span("Invoke Function", SpanKind::Server),
                span("waitUntil", SpanKind::Server),
                span("Start VM", SpanKind::Server),
                span(
                    "POST ai-gateway.vercel.sh/v4/ai/language-model",
                    SpanKind::Client,
                ),
                span("enqueue", SpanKind::Producer),
            ],
        )]);

        assert!(has_runtime_resources(&request));
        restate(&mut request, &names());

        let [runtime, project] = request.resource_spans.as_slice() else {
            panic!("expected the runtime and the project resource");
        };
        assert_eq!(
            resource_value(runtime, "service.name"),
            Some(RUNTIME_SERVICE)
        );
        assert_eq!(span_names(runtime), ["waitUntil", "Start VM"]);
        assert_eq!(
            resource_value(project, "service.name"),
            Some("docs-verify-eve")
        );
        assert_eq!(
            span_names(project),
            [
                "Invoke Function",
                "POST ai-gateway.vercel.sh/v4/ai/language-model",
                "enqueue"
            ]
        );
        assert_eq!(project.scope_spans[0].scope, runtime.scope_spans[0].scope);
        assert_eq!(
            resource_value(project, "deployment.environment.name"),
            Some("production")
        );
        for resource in [runtime, project] {
            assert_eq!(
                resource_value(resource, PLATFORM_SERVICE_ATTRIBUTE),
                Some(RUNTIME_SERVICE)
            );
        }
        assert_eq!(resource_value(project, "cloud.provider"), Some("vercel"));
        assert_eq!(resource_value(runtime, "cloud.provider"), None);
    }

    #[test]
    fn falls_back_to_the_snake_case_project_id() {
        let mut request = request(vec![resource_spans(
            runtime_attributes("vercel.project_id"),
            vec![span("Invoke Function", SpanKind::Server)],
        )]);

        restate(&mut request, &names());

        let [project] = request.resource_spans.as_slice() else {
            panic!("expected only the project resource");
        };
        assert_eq!(
            resource_value(project, "service.name"),
            Some("docs-verify-eve")
        );
    }

    #[test]
    fn keeps_a_cloud_provider_the_sender_set() {
        let mut attributes = runtime_attributes("vercel.projectId");
        attributes.push(attribute("cloud.provider", "aws"));
        let mut request = request(vec![resource_spans(
            attributes,
            vec![span("Invoke Function", SpanKind::Server)],
        )]);

        restate(&mut request, &names());

        assert_eq!(
            resource_value(&request.resource_spans[0], "cloud.provider"),
            Some("aws")
        );
    }

    #[test]
    fn drops_a_runtime_resource_left_empty() {
        let mut runtime = resource_spans(
            runtime_attributes("vercel.projectId"),
            vec![span("Invoke Function", SpanKind::Server)],
        );
        runtime.scope_spans.push(ScopeSpans {
            spans: vec![span("waitUntil", SpanKind::Server)],
            ..Default::default()
        });
        let mut request = request(vec![runtime]);

        restate(&mut request, &names());

        let [runtime, project] = request.resource_spans.as_slice() else {
            panic!("expected the runtime and the project resource");
        };
        assert_eq!(runtime.scope_spans.len(), 1);
        assert_eq!(span_names(runtime), ["waitUntil"]);
        assert_eq!(project.scope_spans.len(), 1);
        assert_eq!(span_names(project), ["Invoke Function"]);
    }

    #[test]
    fn marks_but_keeps_spans_of_an_unknown_project() {
        let original = resource_spans(
            runtime_attributes("vercel.projectId"),
            vec![
                span("Invoke Function", SpanKind::Server),
                span("GET example.com/", SpanKind::Client),
            ],
        );
        let mut request = request(vec![original.clone()]);

        restate(&mut request, &HashMap::new());

        let [runtime] = request.resource_spans.as_slice() else {
            panic!("expected the runtime resource alone");
        };
        assert_eq!(runtime.scope_spans, original.scope_spans);
        assert_eq!(
            resource_value(runtime, "service.name"),
            Some(RUNTIME_SERVICE)
        );
        assert_eq!(
            resource_value(runtime, PLATFORM_SERVICE_ATTRIBUTE),
            Some(RUNTIME_SERVICE)
        );
    }

    #[test]
    fn leaves_other_services_untouched() {
        let edge = resource_spans(
            vec![
                attribute("service.name", "vercel.edge-network"),
                attribute("vercel.projectId", "prj_1"),
            ],
            vec![span("GET /", SpanKind::Server)],
        );
        let app = resource_spans(
            vec![attribute("service.name", "checkout")],
            vec![span("GET /", SpanKind::Client)],
        );
        let mut request = request(vec![edge.clone(), app.clone()]);

        assert!(!has_runtime_resources(&request));
        restate(&mut request, &names());

        assert_eq!(request.resource_spans, [edge, app]);
    }
}
