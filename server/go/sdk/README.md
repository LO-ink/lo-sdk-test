# Registered LO mini-app initData verification

Public Go module, standard library only, maintained in the SDK repository:
`github.com/LO-ink/lo-miniapp-sdk/go` (release tags use `go/vX.Y.Z`).

```go
import "github.com/LO-ink/lo-miniapp-sdk/go/initdata"

launch, err := initdata.Verify(raw, initdata.Options{
    AppKey: appKey, AppID: appID, MaxAgeSec: 3600,
})
if err != nil { /* reject authentication */ }
if launch.User != nil {
    chatID := launch.User.ID // exact decimal string, never a float
    _ = chatID
}
```

Use the LO Connect app key exactly as supplied, without base64 decoding. Never
expose it to a browser. `*initdata.Error` has a stable `Code`, shared with Node's
`InitDataError`. Hashes compare with `hmac.Equal`; duplicate decoded parameters,
wrong app IDs, expired data and timestamps more than five minutes ahead fail.

Run `go test -race ./...` and `go vet ./...` from this directory. Tests use the
same synthetic JSON vectors as Node at `initdata/testdata/initdata.json`; run tests
from a checkout of the full repository. No real credentials occur in the vectors.
The module can be used with a local `replace` before its first tagged release.
