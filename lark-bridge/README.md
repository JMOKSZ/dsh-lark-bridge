# @dsh/lark-bridge

Feishu (Lark) entry point for DSH — a cordis bundle that connects a Feishu bot
to DSH agents over the official long-connection (WebSocket) event channel, so
users can drive DSH from Feishu chat without exposing any port.

## How it works

- Subscribes `im.message.receive_v1` through `@larksuiteoapi/node-sdk`'s
  `WSClient` (long connection — no public callback URL needed).
- Maps every Feishu chat (`chat_id`) to one durable DSH session; the mapping is
  persisted in `$DSH_HOME/lark-bridge-state.json` and resumed on restart.
- On a text message: replies an ack, submits the text as a user turn
  (`agents.create()/resume()` + `agent.followup()`), waits for quiescence,
  flushes the session, and replies the final assistant answer to the original
  message.
- Group chats respond only when the bot is @-mentioned (`replyToMentionOnly`,
  default `true`).
- `transport: "mock"` runs a local HTTP stub (POST `/incoming`, GET
  `/outgoing`) for offline end-to-end tests.

## Attachments (v2.0)

Image / file / video / audio messages are downloaded through the
message-resource API (`GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}`,
requires the `im:resource` permission) and:

- saved under the uploads directory (default `<workspace>/.lark-uploads`) with
  sanitized names; the absolute path is included in the user turn so the agent
  can process it with its tools (read_image, bash, ffmpeg/ffprobe, ...);
- images are additionally committed through the attachment service and attached
  as `ImageBlock`s when the current model declares `image` input
  (`imageMode: "attach"`, the default) — the same capability gate the
  `read_image` tool enforces; a text-only model falls back to save-only;
- `post` (rich text) messages are reduced to plain text; stickers and merged
  forwards are refused (the Feishu resource API itself does not serve them).

## Install

Installed into a DSH profile via `dsh plugin`; see the repository README for
the one-command setup (`scripts/setup-lark-profile.sh`) and the Feishu console
configuration steps.

## Config (profile `cordis.patch.yml`)

```yaml
- id: lark-bridge
  config:
    appId: !!js process.env.LARK_APP_ID      # or a literal
    appSecret: !!js process.env.LARK_APP_SECRET
    replyToMentionOnly: true
    workspace: !!js process.env.LARK_WORKSPACE  # agent cwd (default: launch dir)
    uploadsDir: /path/to/uploads               # default <workspace>/.lark-uploads
    imageMode: attach                          # attach | file
```

| Field | Default | Meaning |
|---|---|---|
| `appId` / `appSecret` | env fallback `LARK_APP_ID` / `LARK_APP_SECRET` | Feishu app credentials |
| `botOpenId` | auto-fetched | the bot's own open_id (mention filtering) |
| `replyToMentionOnly` | `true` | group chats respond only when @-mentioned |
| `workspace` | launch dir | agent working directory |
| `uploadsDir` | `<workspace>/.lark-uploads` | where downloaded attachments are saved |
| `imageMode` | `"attach"` | `"attach"`: attach images to image-capable models (and save); `"file"`: save only |
| `maxUploadBytes` | `104857600` | per-attachment size cap (Feishu limit is 100MB) |
| `maxReplyChars` | `20000` | truncation bound for replies |
| `stateFile` | `$DSH_HOME/lark-bridge-state.json` | chat→session mapping persistence |
| `transport` | `"lark"` | `"lark"` (SDK long connection) or `"mock"` (local stub) |
| `ackEnabled` | `true` | send the "processing" ack |
| `includeErrorDetails` | `true` | include error code/message in failure replies |

## Commands

`/new` (fresh session), `/status` (session/model/queue/cwd/uploads), `/whoami`
(open_id / chat_id), `/help`.
