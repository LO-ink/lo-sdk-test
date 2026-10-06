package initdata_test

import (
	"encoding/json"
	"errors"
	"github.com/LO-ink/lo-miniapp-sdk/go/initdata"
	"os"
	"testing"
	"time"
)

func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/initdata.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name      string
		Raw       string
		AppKey    string
		AppID     string
		MaxAgeSec int64
		NowSec    int64
		Error     string
		Expected  *initdata.Data
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			got, err := initdata.Verify(v.Raw, initdata.Options{AppKey: v.AppKey, AppID: v.AppID, MaxAgeSec: v.MaxAgeSec, Now: time.Unix(v.NowSec, 0)})
			if v.Error != "" {
				var typed *initdata.Error
				if !errors.As(err, &typed) || typed.Code != v.Error {
					t.Fatalf("got %v, want %s", err, v.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			a, _ := json.Marshal(got)
			b, _ := json.Marshal(v.Expected)
			if string(a) != string(b) {
				t.Fatalf("got %s, want %s", a, b)
			}
		})
	}
}
