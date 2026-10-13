# Secretary integration

LO owns bot selection, chat scope, delegated permissions and exact-template
auto-replies with schedules. AI proposals and their approval belong to the bot
application. Verify replies in the owner's private bot chat and check delivery on
the peer device. Connecting another secretary can replace an existing connection;
use a dedicated test owner and peer.

The previous SDK Test native review workflow is retired. Its authenticated
`/api/secretary` route returns terminal HTTP 410 for the configured owner, with
no bot requests, polling, state reads or writes. A different owner is denied.
The page no longer creates or retries native drafts. The main SDK Test bot and
its ordinary checks are unchanged.

## Preserve existing results

Keep the `secretary-state` volume and any prior `secretary.json`, original request
IDs, proposal IDs, cursors, unknown outcomes and lock files. This release does not
delete, convert, replay or automatically reconcile them. A denial never proves
that a previously uncertain send did not commit. Reconcile historical outcomes
using the original receipt and recipient evidence; do not turn old jobs into
`sendText` calls or assign replacement keys. The same volume is also required
for bounded media uploads.

Legacy `LO_SECRETARY_TEST_*` values no longer enable the retired test. They are
not exposed to the browser. Credentials can be retired separately after an
operator verifies that no other authorized consumer uses them.

## Bot-owned verification

Use the [Bot SDK guide](https://github.com/LO-ink/lo-bot-sdk).
For a new flow, persist the exact proposal, authenticate the approving owner and
callback, atomically claim that proposal, then call the delegated send operation
with its original context and stable request ID. Connection access alone is not
approval. Recheck pause, revoke, source changes and policy changes; retain unknown
outcomes and retry only an already approved exact operation.

Native templates and schedules remain in LO. This retirement is not a deployment
PASS for a new bot: qualify incoming delivery, approval, discard, duplicate
callbacks, revoke and peer-device appearance separately.
