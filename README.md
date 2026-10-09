# LO SDK Test

A mini-app for checking LO SDKs, the native host and the Bot API. Hosted at [sdk-test.zay.media](https://sdk-test.zay.media).

Start the guided run. Automatic checks finish before permissions and device confirmations begin. All host checks use LO’s native SDK connection. Download the resulting report after restoration. Audio, vibration, colors and gestures require confirmation of the observed device effect. A successful API response alone does not establish that effect. Skipped checks remain unverified. The manual tab runs individual methods. The UI tab shows all seventeen published UI primitives, including disabled, loading, validation, icon and typography states. Its examples work locally without bridge or Bot API calls; the theme selector applies to the whole application.

A stopped run offers Continue and a separate Start over action. Completed results, run identity and progress stay intact, including after reopening. Continuation verifies a fresh session and requests fresh bot consent in the assisted phase when unfinished bot writes need it; it never restores permission from browser storage. Run-owned cleanup state is saved before mutations so interrupted storage and screen changes can be restored before continuing. An unresolved restoration is shown explicitly and cannot be discarded by starting another run.

Progress is retained for 24 hours and is bound to the SDK dependency set, the exact check plan and the same LO app/user. Interrupted bot writes require a specific retry choice because a lost response does not prove that no message was sent. Missing server-owned file/message references remain unverified instead of repeating completed sends. Reports from a different SDK dependency set require a fresh run. Deferred delivery tickets remain bound to their original build.

A valid debt-free report outside the continuation window or from an older SDK set remains available as a separate historical export. It keeps recorded execution attribution (or explicit unknown provenance for legacy results), dates and result states, explicitly marked `historical: true` and `currentEvidence: false`. Viewing diagnostic details uses read-only `/api/verify-launch` (no session cookie, bot consent or server-owned resource changes) and requires a server-verified launch from the same registered LO app and account; reopen from LO if the launch signature has expired. Unknown properties and labelled authentication values are excluded from exports, but arbitrary unlabelled legacy prose cannot be guaranteed secret-free.

Starting fresh preserves the exact previous snapshot privately before replacing the active run or starting host effects. Retained reports use separate immutable local keys, bounded to 20 records and 8 MiB; this preservation is never a cleanup attestation. The compact history surface exposes the most recent retained report. To free space, explicitly export your oldest archived report and confirm removal of that archive only. Current results and foreign-owner archives are not removed. Full, foreign-only, invalid or unavailable storage fails closed; use the previous account to export/remove its records or ask the device owner to repair site storage. Current eligible continuation does not depend on unrelated archive capacity. Storage comparisons detect observed concurrent changes but are not atomic cross-tab transactions.

The main application uses only LO’s native connection. Older reports may retain cleanup obligations for a removed compatibility route. These remain explicitly unresolved, with the original storage key and settings shown for manual cleanup in the original app/account; they are never replayed through the native connection or silently discarded. Valid old cleanup records without an app/user identity are also retained for manual resolution, with automatic cleanup blocked.

If browser storage access or a checkpoint write fails, the app remains usable for SDK browsing and manual checks, but automatic runs and recovery stop. In-memory results are not presented as durably saved cleanup. Restore storage permission and reopen the app before continuing.

## Local development

Use Node.js 24 and Go. The build pins Go 1.27.2; Go downloads that toolchain when needed.

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

SDKs are installed from npm at exact versions. package-lock.json records archive integrity; sdk-build.json records their source revisions. Tests compare this manifest with the installed packages.

Node and Go independently verify each signed launch before issuing a session. A rejection or disagreement prevents authentication. The Go SDK is installed from its published module version and checked by go.sum. App keys and launch data reach the verifier over stdin and stay out of reports.

```sh
make ci
npx playwright install chromium
make browser
docker build --platform linux/amd64 -t lo-sdk-test:local .
make container IMAGE=lo-sdk-test:local
```

The container runs as node with a read-only filesystem and a private disk-backed
upload directory. Its smoke test checks startup, the Go verifier, build identity
and the 256 MiB memory limit. Bot controls use small JSON bodies; media is uploaded
as binary data, one file at a time, up to 50 MiB. Temporary files are removed after
sending or cancellation. Reports have bounded depth, size and total retention.

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

The application uses the published `@lo-ink/ui` primitives for controls,
typography, surfaces, dialogs and progress, and `@lo-ink/design-tokens` through the UI stylesheet. Host theme colors map to
the SDK semantic tokens; run controls, consent dialogs and search share those
components. The version panel checks both UI packages against their own sources.

`make browser` verifies both themes at 320 px, navigation hover/focus, control
geometry and typography, local interactions, validation, and isolated gallery
themes. Deployment waits for this browser gate as well as code checks.
The native palette keeps its brand accent; white-label default controls use the
UI package's accessible web fill. Explicit custom host action/actionText pairs
are preserved; the host controls their contrast.

Gallery image examples use the canonical LOOriginalWhiteAppIcon artwork from
LO's native application. Text avatars are separate examples with size-aware type.
Application CSS owns report layout and safe-area/test-observation geometry;
control appearance belongs to the UI package.

Search fields retain the native filled shape and 38px height with a 16px input
font. This web adaptation prevents automatic iOS focus zoom; browser pinch zoom
remains available.

LO Pro UI, Display and Mono are loaded from the design-tokens package. The
application does not provide its own font or control appearance. ESLint requires
SDK primitives for controls and typography; native semantic markup is retained
for report disclosures, tables, file timestamps and page structure.

## Secretary integration check

The [dedicated Secretary flow](docs/secretary.md) verifies owner-scoped incoming,
review draft and server sending evidence without sharing a working bot consumer.

LO uses `createLoClient` from Mini App SDK and the HTTP transport from Bot SDK. The application has no platform-adapter dependencies. Resume remains scoped to the recorded dependency set; SDK version changes do not relabel old results as newly tested.

The architecture gate parses application CSS and rejects direct typography,
control appearance and shared SDK selector overrides. Layout, host tokens and
tabular report numbers remain application responsibilities.

## Navigation and launch metadata

The main sections support horizontal touch/pen swipes and shared UI SDK tabs. Swipes leave text fields, actions and horizontally scrolling tab/filter rows alone; they do not leave an active guided run. Manual section selection is retained when returning from the gallery. Whole filter labels scroll horizontally on narrow screens.

Launch details show every typed SDK field without raw launch strings or signature credentials. LO interface language comes only from the optional native host snapshot; signed user language is displayed separately. Missing interface language on an older LO host requires a client update. An absent start parameter is normal for launches without one. Signature status changes only after server verification.

## External manual cleanup

Old unsupported-route or unknown-owner cleanup records remain blocked until their
obligations are completed. The recovery panel exposes a copyable full JSON ticket,
including the original owner, storage keys, affected buttons and original settings.
Only explicit cleanup fields are exported; unrelated legacy fields and raw stored
snapshots remain private to the local archive.
A user who has completed every listed obligation in the original context can
explicitly attest to external manual cleanup. This is unverified user testimony,
never an automatic cleanup pass or evidence for the current SDK build. Mixed
records with owned native obligations must complete native recovery first.

An immutable local archive retains the exact original snapshot before the app
logically retires it. The active snapshot is not removed; only an exact archived
match permits a new run. Changed records, failed persistence, archive collisions,
or exhausted archive limits leave new runs blocked. Archives are capped at 20
records and 8 MiB without eviction. Local storage uses optimistic snapshot checks,
not atomic cross-tab transactions; use one active SDK Test tab.

## Result provenance

Exports separate `exportContext` (the current exporting browser build) from
`automatedRun.provenance.builds` and each check's `execution` reference.
A receipt records the evaluating browser app version, validated Git revision
(or `local` for an unstamped build), exact configured npm receipts, and the
configured Go verifier contract. It is local diagnostic metadata, not a signed
attestation or an independently observed backend/native binary identity.
`configuredGoVerifier` must not be interpreted as a measurement of a responding
server. `executionAttribution` counts known, unknown and unevaluated results;
aggregate outcomes may span builds and are not current-build certification.

Compatible resume preserves completed results and their execution references.
New evaluations and deferred confirmations use the current build. A deferred
confirmation retains the earlier measured duration with a separate
`durationExecution` reference; the detail view labels it as the original
evaluation duration. A genuine re-execution measures a new duration and clears
that separate reference. The latest
resume preparation records its own dates and server/signature outcomes without
replacing the earlier signature check. Earlier preparation attempts are not an
audit log. Skipped checks can identify the build evaluating a skip condition;
scope-excluded or untouched steps have no execution timestamp.

Old snapshots without execution receipts remain explicitly `unknown: legacy`.
The storage wrapper's app version records its last serializer, not necessarily
the original execution build. No compiler, source revision or SDK receipt is
inferred from that wrapper. Missing or malformed provenance cannot discard valid
results or cleanup debt. Receipts deduplicate full allowlisted content and retain
only referenced builds plus the latest preparation, bounded to 64 builds and
128 KiB of serialized receipt metadata. If capacity is reached, new attribution
is explicitly unknown (`receipt-capacity`); cleanup remains available and existing
references remain intact. Historical archives still preserve exact original
snapshot bytes; their exports project validated provenance separately.
