package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"github.com/LO-ink/lo-miniapp-sdk/go/initdata"
)

type request struct {
	Raw       string `json:"raw"`
	AppKey    string `json:"appKey"`
	AppID     string `json:"appId"`
	MaxAgeSec int64  `json:"maxAgeSec"`
	NowSec    int64  `json:"nowSec"`
}

type response struct {
	Verified bool   `json:"verified"`
	Code     string `json:"code,omitempty"`
	UserID   string `json:"userId,omitempty"`
	AppID    string `json:"appId,omitempty"`
	AuthDate int64  `json:"authDate,omitempty"`
}

func verify(reader io.Reader) response {
	var input request
	decoder := json.NewDecoder(io.LimitReader(reader, 80001))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil {
		return response{Code: "invalid-data"}
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return response{Code: "invalid-data"}
	}
	launch, err := initdata.Verify(input.Raw, initdata.Options{
		AppKey: input.AppKey, AppID: input.AppID,
		MaxAgeSec: input.MaxAgeSec, Now: time.Unix(input.NowSec, 0),
	})
	if err != nil {
		var invalid *initdata.Error
		if errors.As(err, &invalid) {
			return response{Code: invalid.Code}
		}
		return response{Code: "invalid-data"}
	}
	result := response{Verified: true, AppID: launch.AppID, AuthDate: launch.AuthDate}
	if launch.User != nil {
		result.UserID = launch.User.ID
	}
	return result
}

func run(reader io.Reader, writer io.Writer) error {
	return json.NewEncoder(writer).Encode(verify(reader))
}

func main() {
	// Credentials enter through stdin and never appear in output or argv.
	if run(os.Stdin, os.Stdout) != nil {
		os.Exit(1)
	}
}
