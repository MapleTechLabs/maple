package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/client"
)

// collection mimics one v2 resource: server defaults, fields the API never
// echoes, and per-type quirks.
type collection struct {
	prefix    string
	defaults  map[string]any
	writeOnly []string
	onCreate  func(obj map[string]any)
}

type fakeRequest struct {
	Method string
	Path   string
	Body   map[string]any
}

// fakeAPI is an in-memory Maple v2 API.
type fakeAPI struct {
	mu          sync.Mutex
	collections map[string]collection
	objects     map[string]map[string]any // path → object
	next        int
	requests    []fakeRequest
	server      *httptest.Server
}

func newFakeAPI(t *testing.T) *fakeAPI {
	api := &fakeAPI{
		objects: map[string]map[string]any{},
		collections: map[string]collection{
			"/v2/dashboards": {prefix: "dash", defaults: map[string]any{
				"description": nil, "tags": []any{}, "widgets": []any{}, "sections": []any{}, "variables": []any{},
				"time_range":               map[string]any{"type": "relative", "value": "12h"},
				"refresh_interval_seconds": nil,
			}},
			"/v2/alerts/destinations": {
				prefix:    "dest",
				defaults:  map[string]any{"enabled": true, "member_user_ids": nil},
				writeOnly: []string{"integration_key", "url", "signing_secret", "webhook_url", "bot_token", "chat_id", "workspace_id", "channel_id"},
				onCreate: func(obj map[string]any) {
					obj["summary"] = fmt.Sprintf("%v destination", obj["type"])
					obj["channel_label"] = nil
				},
			},
			"/v2/alerts/rules": {prefix: "alrt", defaults: map[string]any{
				"enabled": true, "severity": "warning", "threshold": json.Number("0"), "threshold_upper": nil,
				"notes": nil, "notification_template": nil, "service_names": []any{}, "exclude_service_names": []any{},
				"environments": []any{}, "tags": []any{}, "group_by": nil, "evaluation_interval_minutes": nil,
				"minimum_sample_count": json.Number("0"), "consecutive_breaches_required": json.Number("2"),
				"breaches_out_of": nil, "consecutive_healthy_required": json.Number("2"),
				"renotify_interval_minutes": json.Number("120"), "apdex_threshold_ms": nil, "query_builder_draft": nil,
				"raw_query_sql": nil, "raw_query_reducer": nil, "destination_ids": []any{}, "alert_on_no_data": false,
				"no_data_behavior": "skip",
			}, onCreate: func(obj map[string]any) {
				obj["thresholds"] = []any{map[string]any{
					"severity": obj["severity"], "value": obj["threshold"], "upper": nil,
					"recovery_value": nil, "destination_ids": obj["destination_ids"],
				}}
			}},
			"/v2/api_keys": {prefix: "key", defaults: map[string]any{
				"description": nil, "kind": "standard", "scopes": nil, "revoked": false, "expires_at": nil,
			}, writeOnly: []string{"expires_in_seconds"}},
			"/v2/scrape_targets": {prefix: "scrp", defaults: map[string]any{
				"target_type": "prometheus", "organization": nil, "include_branches": []any{}, "exclude_branches": []any{},
				"scrape_interval_seconds": json.Number("15"), "labels_json": nil, "auth_type": "none",
				"service_name": nil, "enabled": true, "has_credentials": false,
			}, writeOnly: []string{"auth_credentials"}},
			"/v2/uptime_monitors": {prefix: "upm", defaults: map[string]any{
				"interval_seconds": json.Number("60"), "failures_to_down": json.Number("2"), "service_name": nil,
				"enabled": true, "destination_ids": []any{}, "heartbeat_url": nil, "alert_rule_id": nil,
			}, onCreate: func(obj map[string]any) {
				config := obj["config"].(map[string]any)
				if config["type"] == "http" {
					if _, ok := config["method"]; !ok {
						config["method"] = "GET"
					}
				}
				if config["type"] == "heartbeat" {
					obj["heartbeat_url"] = "https://api.maple.test/hb/" + fmt.Sprint(obj["id"])
				}
			}},
		},
	}
	api.server = httptest.NewServer(http.HandlerFunc(api.handle))
	t.Cleanup(api.server.Close)
	return api
}

func (api *fakeAPI) handle(w http.ResponseWriter, r *http.Request) {
	api.mu.Lock()
	defer api.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer maple_ak_test" {
		writeError(w, http.StatusUnauthorized, "authentication_error", "bad key")
		return
	}
	var body map[string]any
	if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
		body, _ = client.Decode(raw)
	}
	api.requests = append(api.requests, fakeRequest{Method: r.Method, Path: r.URL.Path, Body: body})

	if r.URL.Path == "/v2/ingest_keys" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{
			"object": "ingest_keys", "public_key": "maple_pk_test", "private_key": "maple_sk_test",
			"public_rotated_at": "2026-10-01T00:00:00Z", "private_rotated_at": "2026-10-02T00:00:00Z",
		})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v2/api_keys/") && strings.HasSuffix(r.URL.Path, "/roll") && r.Method == http.MethodPost {
		old, ok := api.objects[strings.TrimSuffix(r.URL.Path, "/roll")]
		if !ok || old["revoked"] == true {
			writeError(w, http.StatusNotFound, "not_found_error", "no such key")
			return
		}
		// Like the real API: revoke, then issue a replacement under a new ID.
		old["revoked"] = true
		api.next++
		replacement := map[string]any{}
		for k, v := range old {
			replacement[k] = v
		}
		replacement["id"] = fmt.Sprintf("key_%d", api.next)
		replacement["revoked"] = false
		secret := fmt.Sprintf("maple_ak_rolled%d", api.next)
		replacement["key_prefix"] = secret[:14]
		api.objects["/v2/api_keys/"+replacement["id"].(string)] = replacement
		writeJSON(w, withSecret(replacement, secret))
		return
	}
	for base, col := range api.collections {
		switch {
		case r.URL.Path == base && r.Method == http.MethodPost:
			api.next++
			obj := map[string]any{"id": fmt.Sprintf("%s_%d", col.prefix, api.next)}
			for k, v := range col.defaults {
				obj[k] = v
			}
			for k, v := range body {
				obj[k] = v
			}
			if tags, ok := obj["tags"].([]any); ok {
				for i, tag := range tags {
					tags[i] = strings.ToLower(tag.(string))
				}
			}
			for _, k := range col.writeOnly {
				delete(obj, k)
			}
			if col.onCreate != nil {
				col.onCreate(obj)
			}
			api.objects[base+"/"+obj["id"].(string)] = obj
			if base == "/v2/api_keys" {
				secret := fmt.Sprintf("maple_ak_new%d", api.next)
				obj["key_prefix"] = secret[:12]
				writeJSON(w, withSecret(obj, secret))
				return
			}
			writeJSON(w, obj)
			return
		case strings.HasPrefix(r.URL.Path, base+"/") && !strings.Contains(strings.TrimPrefix(r.URL.Path, base+"/"), "/"):
			obj, ok := api.objects[r.URL.Path]
			if !ok {
				writeError(w, http.StatusNotFound, "not_found_error", "not found")
				return
			}
			switch r.Method {
			case http.MethodGet:
				writeJSON(w, obj)
			case http.MethodPatch:
				for k, v := range body {
					obj[k] = v
				}
				for _, k := range col.writeOnly {
					delete(obj, k)
				}
				writeJSON(w, obj)
			case http.MethodDelete:
				if base == "/v2/api_keys" {
					obj["revoked"] = true
				} else {
					delete(api.objects, r.URL.Path)
				}
				w.WriteHeader(http.StatusNoContent)
			}
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found_error", "no route")
}

func withSecret(obj map[string]any, secret string) map[string]any {
	out := map[string]any{"secret": secret}
	for k, v := range obj {
		out[k] = v
	}
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, errType, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"type": errType, "message": message, "retryable": false, "recovery": "fix_request",
	}})
}

// lastBody returns the body of the most recent request matching method and path prefix.
func (api *fakeAPI) lastBody(method, pathPrefix string) map[string]any {
	api.mu.Lock()
	defer api.mu.Unlock()
	for i := len(api.requests) - 1; i >= 0; i-- {
		req := api.requests[i]
		if req.Method == method && strings.HasPrefix(req.Path, pathPrefix) {
			return req.Body
		}
	}
	return nil
}

func (api *fakeAPI) count(method, pathPrefix string) int {
	api.mu.Lock()
	defer api.mu.Unlock()
	n := 0
	for _, req := range api.requests {
		if req.Method == method && strings.HasPrefix(req.Path, pathPrefix) {
			n++
		}
	}
	return n
}

// mutate edits a stored object out of band, as a change made in the Maple UI.
func (api *fakeAPI) mutate(path string, edit func(obj map[string]any)) {
	api.mu.Lock()
	defer api.mu.Unlock()
	if obj, ok := api.objects[path]; ok {
		edit(obj)
	}
}
