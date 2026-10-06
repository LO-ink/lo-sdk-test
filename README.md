# LO SDK Test

A mini-app for checking LO SDKs, native bridges and the Bot API. Hosted at [sdk-test.zay.media](https://sdk-test.zay.media).

Run the guided checks to see progress, respond to permissions and confirmations, and download a report. Audio, vibration, colors and gestures require confirmation of the observed device effect. A successful API response alone does not establish that effect. Skipped checks remain unverified. The manual tab runs individual methods. The UI tab shows all twelve published UI primitives, including disabled, loading, validation, icon and typography states. Its examples work locally without bridge or Bot API calls; the theme selector applies only to the gallery.

A stopped run offers Continue and a separate Start over action. Completed results, run identity and progress stay intact, including after reopening. Continuation verifies a fresh session and requests fresh bot consent; it never restores permission from browser storage. Run-owned cleanup state is saved before mutations so interrupted storage and screen changes can be restored before continuing. An unresolved restoration is shown explicitly and cannot be discarded by starting another run.

Progress is retained for 24 hours and is bound to the SDK dependency set, the exact check plan and the same LO app/user. Interrupted bot writes require a specific retry choice because a lost response does not prove that no message was sent. Missing server-owned file/message references remain unverified instead of repeating completed sends. A compatible, cleanly stopped 0.4.21 report can be continued. The reviewed UI-only 0.4.22 → 0.4.23 upgrade also preserves reports because the bridge packages and check plan are unchanged; other dependency changes still reject continuation. Deferred delivery tickets remain bound to their original build.

Native and compatibility bridges are tested independently. The report records platform limitations.

## Local development

Use Node.js 24 and Go. The build pins Go 1.27.1; Go downloads that toolchain when needed.

```sh
make install
cp .env.example .env
chmod 600 .env
make ci
npm start
```

Open http://127.0.0.1:5407. For UI development, run npm run dev with the server in a separate terminal. Live checks require an app and bot registered in LO, the server settings from .env.example, and an HTTPS app URL.

Without LO credentials, the interface and checks independent of a signed LO launch remain available. Empty environment fields are never replaced with fake keys. Keep secrets out of VITE_* variables, which are exposed to the browser.

## Verification

SDKs are installed from npm at exact versions. package-lock.json records archive integrity; public/sdk-build.json records their source revisions. Tests compare this manifest with the installed packages.

Node and Go independently verify each signed launch before issuing a session. A rejection or disagreement prevents authentication. The Go SDK is installed from its published module version and checked by go.sum. App keys and launch data reach the verifier over stdin and stay out of reports.

```sh
make ci
npx playwright install chromium
make browser
docker build --platform linux/amd64 -t lo-sdk-test:local .
make container IMAGE=lo-sdk-test:local
```

The container runs as node with a read-only filesystem. Its smoke test verifies server startup, the Go verifier and the build identity.

## Deployment

After a merge into main, GitHub Actions verifies code, builds and runs the container, publishes that exact image to GHCR, and deploys by digest. Health and public /release.json checks establish the installed revision. Failed deployment restores the previous image.

Pull-request checks have no server access. LO credentials stay on the server. A restricted SSH command handles deployment, using an ephemeral GHCR credential. See [deployment and recovery](deploy/README.md).

License: [MIT](LICENSE).

## Quality checks

Run `make install` and `make ci` with Node.js 22.13 or newer. The same targets run
in GitHub Actions. CI checks formatting, ESLint (including typed promises),
TypeScript, dependency cycles and package boundaries, tests, published package
contents, vulnerable dependencies and secrets. English documentation and comments
are enforced; unfinished development notes and retired repository URLs fail CI.

Coverage includes unimported production files and fails below 70% lines and
statements, 70% functions, or 70% branches. Reports are uploaded as CI artifacts.

`make go-ci` checks the launch verifier with race tests, static analysis, at least
85% statement coverage and vulnerability scanning. `make container` verifies the
release image using `BUILD_REVISION` from the commit being deployed.

Repository policy checks require Python 3 for Python comment tokenization. YAML
comments are parsed as YAML; embedded scripts and localized scalar values retain
their own language. LO credentials are checked by the root Gitleaks configuration
and a synthetic scanner regression before each repository scan.

The application uses the published `@lo-ink/ui` Button and TextField components
and `@lo-ink/design-tokens` through the UI stylesheet. Host theme colors map to
the SDK semantic tokens; run controls, consent dialogs and search share those
components. The version panel checks both UI packages against their own sources.

`make browser` verifies both themes at 320 px, navigation hover/focus, control
geometry and typography, local interactions, validation, and isolated gallery
themes. Deployment waits for this browser gate as well as code checks.
The native palette keeps its brand accent; white-label default controls use the
UI package's accessible web fill. Explicit custom host action/actionText pairs
are preserved; the host controls their contrast.

## Secretary integration check

The [dedicated Secretary flow](docs/secretary.md) verifies owner-scoped incoming,
review draft and server sending evidence without sharing a working bot consumer.
