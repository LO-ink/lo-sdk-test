# Go analyzer tools

This private tool module keeps verification dependencies separate from the launch verifier. Staticcheck v0.8.1 needs golang.org/x/tools v0.51.0 to read Go 1.27.2 export data. Both versions and their transitive checksums are pinned; `make go-lint` builds with `-mod=readonly` and runs every default Staticcheck check against `server/go`.

The launch verifier module and its SDK dependency remain unchanged. This module is not deployed or published.
