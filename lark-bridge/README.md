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
```

| Field | Default | Meaning |
|---|---|---|
| `appId` / `appSecret` | env fallback `LARK_APP_ID` / `LARK_APP_SECRET` | Feishu app credentials |
| `botOpenId` | auto-fetched | the bot's own open_id (mention filtering) |
| `replyToMentionOnly` | `true` | group chats respond only when @-mentioned |
| `workspace` | launch dir | agent working directory |
| `maxReplyChars` | `20000` | truncation bound for replies |
| `stateFile` | `$DSH_HOME/lark-bridge-state.json` | chat→session mapping persistence |
| `transport` | `"lark"` | `"lark"` (SDK long connection) or `"mock"` (local stub) |
| `ackEnabled` | `true` | send the "processing" ack |
| `includeErrorDetails` | `true` | include error code/message in failure replies |

## Commands

`/new` (fresh session), `/status` (session/model/queue/cwd), `/whoami`
(open_id / chat_id), `/help`.
