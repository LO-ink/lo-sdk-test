.NOTPARALLEL:

NPM := npm

.PHONY: ci install format format-check lint check architecture test coverage security build package

ci: build format-check lint check architecture coverage package policy security secrets

install:
	$(NPM) ci --ignore-scripts
format:
	$(NPM) run format
format-check:
	$(NPM) run format:check
lint:
	$(NPM) run lint
check:
	$(NPM) run check
architecture:
	$(NPM) run architecture
test:
	$(NPM) test
coverage:
	$(NPM) run test:coverage
security:
	$(NPM) run security
build:
	$(NPM) run build
package:
	bash -n deploy/release.sh

policy:
	$(NPM) run policy
secrets:
	$(NPM) run secrets

GO_DIR := server/go
export GOTOOLCHAIN := go1.27.1

.PHONY: go-ci go-format go-lint go-test go-security
go-ci: go-format go-lint go-test go-security
go-format:
	test -z "$$(gofmt -l $(GO_DIR))"
go-lint:
	cd $(GO_DIR) && go vet ./...
	cd $(GO_DIR) && go run honnef.co/go/tools/cmd/staticcheck@v0.8.1 ./...
go-test:
	cd $(GO_DIR) && go test -race -covermode=atomic -coverprofile=../../coverage-go.out ./...
	cd $(GO_DIR) && go tool cover -func=../../coverage-go.out > ../../coverage-go.txt
	awk '/^total:/ {found=1; gsub(/%/, "", $$3); coverage=$$3} END {if (!found || coverage < 85) exit 1}' coverage-go.txt
go-security:
	cd $(GO_DIR) && go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...

container:
	docker build --platform linux/amd64 --build-arg BUILD_REVISION="$(BUILD_REVISION)" -t lo-sdk-test:ci .
	BUILD_REVISION="$(BUILD_REVISION)" node scripts/check-container.mjs lo-sdk-test:ci
