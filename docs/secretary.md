# Secretary test flow

The manual **Secretary** section uses a separate test bot and two synthetic human
accounts. It stays disabled until all server settings are present. It does not
share the ordinary SDK Test bot or Duck's updates, change webhooks, create consent,
call owner approval APIs or send directly. Use a separate owner account: connecting
another secretary can replace an existing connection.

## Configuration

Enable the dedicated bot's secretary capability in LO. Connect it through the
owner's Secretary settings and grant receive/send for one private test chat.
Put these values in the protected runtime environment, never Git or the browser:

- `LO_SECRETARY_TEST_TOKEN`: dedicated bot token. Its identity must differ from
  `LO_BOT_TOKEN`, including after rotation.
- `LO_SECRETARY_TEST_OWNER_ID`, `LO_SECRETARY_TEST_PEER_ID`: fixed test humans.
- `LO_SECRETARY_TEST_CONNECTION_ID`: exact connection saved in LO.
- `LO_SECRETARY_TEST_STATE=/var/lib/lo-sdk-test/secretary.json`: private durable file.
- `LO_SECRETARY_TEST_EXCLUSIVE_POLL=true`: confirm this server is the only receiver
  for this dedicated bot. Do not run another poller or webhook consumer.

VPS compose mounts `secretary-state` at `/var/lib/lo-sdk-test`, owned by the
unprivileged image user. Preserve that volume across deploys. Other deployments
must supply a private writable directory owned by the service user. Run one
service process. The server never switches update delivery modes automatically.

## Live check

1. Open SDK Test in LO, verify the signed launch, then select **Manual → Secretary**.
   Only the fixed owner may run the flow; the browser cannot substitute scoped IDs.
2. Select **Check connection**. A real `getConnection` verifies enabled access,
   owner and receive/send rights. Public capabilities have no separate secretary flag.
3. Ask the fixed test peer to send the displayed random challenge exactly, then
   **Check incoming**. Only a native event from the configured peer/connection,
   current policy and exact challenge is accepted. Edits/echoes are not accepted.
4. Review the proposed reply, then **Create draft for review in LO**. The exact
   request is stored durably before `proposeDraft`; reason is `manual_review`.
5. Approve that draft in the regular LO owner UI.
6. Immediately **Check result**. The same proposal key/context/body is replayed.
   Only `sent` + `review` + message ID proves server approval and sending. Check
   appearance on the recipient device separately.

Connection access alone is not end-to-end PASS. A newer incoming message, source
edit, pause/revoke or expiry may prevent replay even after approval committed.
The UI shows an unavailable result and never treats denial as proof of no send.
There is no public bot `getDraft`/owner approval API; inspect the owner UI then.

## Restart and lifecycle

The complete proposal and cursor are saved before network side effects or later
poll acknowledgement. Resume uses the same request identity; browser state grants
no authority. After restart, verify a fresh signed session as the same test owner.
State stores synthetic challenge/reply, scoped IDs and outcomes, with no token,
initData or unrelated private text. Files use mode 0600, fsync and atomic rename.

An exclusive filesystem lock prevents competing receivers/actions. A crash can
leave an orphan `.lock`: stop all state-file users, confirm no owner process is
running, remove only that lock, then restart. Retain the JSON state and original
request ID. There is no automatic takeover or destructive reset. A run lasts
24 hours. Before archiving expired/uncertain state and starting a new check, an
operator must reconcile the result in LO; never delete an unknown outcome during
deploy. Apply your test-data retention policy to the private synthetic archive.

Synthetic tests cover owner/context substitution, exact challenge, lossless cursor,
review evidence, lost committed response and same-key recovery after restart.
They do not prove deployed permissions or recipient-device visibility. Use the
[developer guide](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/secretary.md)
for the full excluded-chat, revoke and media-denial staging matrix.
