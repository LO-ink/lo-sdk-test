# LO SDK Test

A mini-app for checking LO SDKs, native bridges and the Bot API. Hosted at [sdk-test.zay.media](https://sdk-test.zay.media).

Run the guided checks to see progress, respond to permissions and confirmations, and download a report. Audio, vibration, colors and gestures require confirmation of the observed device effect. A successful API response alone does not establish that effect. Skipped checks remain unverified. The manual tab runs individual methods.

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
