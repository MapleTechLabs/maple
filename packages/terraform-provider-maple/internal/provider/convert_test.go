package provider

import (
	"encoding/json"
	"math/big"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

func TestJSONCoversToleratesServerAdditions(t *testing.T) {
	cases := []struct {
		want, got string
		covers    bool
	}{
		{`{"type":"http","url":"u"}`, `{"type":"http","url":"u","method":"GET"}`, true},
		{`[{"id":"w1"}]`, `[{"id":"w1","layout":{"x":0}}]`, true},
		{`{"value":0.5}`, `{"value":0.50}`, true},
		{`{"section_id":null}`, `{}`, true},
		{`{"url":"a"}`, `{"url":"b"}`, false},
		{`[{"id":"w1"}]`, `[{"id":"w1"},{"id":"w2"}]`, false},
		{`{"headers":{"a":"1"}}`, `{"headers":{}}`, false},
	}
	for _, c := range cases {
		want, _ := parseJSON(c.want)
		got, _ := parseJSON(c.got)
		if jsonCovers(want, got) != c.covers {
			t.Errorf("jsonCovers(%s, %s) = %v", c.want, c.got, !c.covers)
		}
	}
}

func TestCanonicalJSONMatchesJsonencode(t *testing.T) {
	// jsonencode sorts object keys and writes no whitespace.
	v, _ := parseJSON(`{ "b": [1, 2.5, "x<y"], "a": {"d": true, "c": null} }`)
	got, err := canonicalJSON(v)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":{"c":null,"d":true},"b":[1,2.5,"x<y"]}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestNumbersReachTheWireAsPlainDecimals(t *testing.T) {
	for _, c := range []struct {
		in, want string
	}{{"1000000", "1000000"}, {"0.05", "0.05"}, {"86400", "86400"}} {
		f, _, _ := big.ParseFloat(c.in, 10, 512, big.ToNearestEven)
		got, err := toWire(tftypes.NewValue(tftypes.Number, f))
		if err != nil || got != json.Number(c.want) {
			t.Errorf("toWire(%s) = %v, %v; want %s", c.in, got, err, c.want)
		}
	}
}
