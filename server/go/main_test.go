package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
)

func signedLaunch(withUser bool) string {
	values := url.Values{"app_id": {"test-app"}, "auth_date": {"1800000000"}}
	if withUser {
		values.Set("user", `{"id":"9007199254740993","first_name":"Anna"}`)
	}
	rows := []string{}
	for _, key := range []string{"app_id", "auth_date", "user"} {
		if value := values.Get(key); value != "" {
			rows = append(rows, key+"="+value)
		}
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte("fixture-app-key"))
	signature := hmac.New(sha256.New, secret.Sum(nil))
	signature.Write([]byte(strings.Join(rows, "\n")))
	values.Set("hash", hex.EncodeToString(signature.Sum(nil)))
	return values.Encode()
}

func TestVerify(t *testing.T) {
	for _, withUser := range []bool{false, true} {
		data, err := json.Marshal(request{Raw: signedLaunch(withUser), AppKey: "fixture-app-key", AppID: "test-app", MaxAgeSec: 3600, NowSec: 1800000000})
		if err != nil {
			t.Fatal(err)
		}
		result := verify(bytes.NewReader(data))
		if !result.Verified || result.AppID != "test-app" || result.AuthDate != 1800000000 {
			t.Fatalf("unexpected result: %+v", result)
		}
		if withUser && result.UserID != "9007199254740993" {
			t.Fatalf("user ID lost precision: %q", result.UserID)
		}
		if !withUser && result.UserID != "" {
			t.Fatal("fabricated user identity")
		}
	}
}

func TestRejectInvalidInput(t *testing.T) {
	cases := []string{"", "not JSON", `{}`, `{"unexpected":true}`, `{} {}`, `{"raw":"tampered","appKey":"fixture-app-key","appId":"test-app","maxAgeSec":3600,"nowSec":1800000000}`}
	for _, input := range cases {
		t.Run(input, func(t *testing.T) {
			result := verify(strings.NewReader(input))
			if result.Verified || result.Code == "" || result.UserID != "" {
				t.Fatalf("accepted invalid input: %+v", result)
			}
		})
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("closed output") }

func TestRun(t *testing.T) {
	var output bytes.Buffer
	if err := run(strings.NewReader(`{}`), &output); err != nil {
		t.Fatal(err)
	}
	var result response
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.Code == "" {
		t.Fatalf("invalid response: %q, %v", output.String(), err)
	}
	if strings.Contains(output.String(), "fixture-app-key") {
		t.Fatal("credential leaked")
	}
	if err := run(strings.NewReader(`{}`), brokenWriter{}); err == nil {
		t.Fatal("write failure was ignored")
	}
}
