# pi-openrig

A [pi](https://pi.dev) extension that makes a pi conversation a participant in an [OpenRig](https://github.com/mvschwarz/openrig) rig.

The human talks to one pi conversation. That conversation hands work to a rig seat (for example a lead that splits it across other seats), and the seats report back into the same conversation. No server or web app is needed: the extension listens to the OpenRig daemon's event stream and writes through the `rig` CLI.

```
human ⇄ pi conversation  (orch-pi@<rig>, attached by this extension)
           │ rig_send_work → rig queue create
           ▼
        lead seat ──► other seats
           │ rig queue create --destination orch-pi@<rig>
           ▼
        message in the conversation, or a selector for a decision
```

## Install

```bash
pi install git:github.com/tagg-lee/pi-openrig
```

Needs the `rig` CLI on `PATH` and a running OpenRig daemon. Tested with OpenRig 0.6.13 and pi 1.3.0.

## Use

| Command | What it does |
|---|---|
| `/rig attach <rig> [pod=orch] [member=pi]` | Gives this conversation the address `<pod>-<member>@<rig>` (`rig attach --self`). Attaching again to the same address re-claims it. |
| `/rig status` | Address, event stream connection, items received and waiting |
| `/rig seats` | Seats of the rig and their activity |
| `/rig peek <seat> [lines]` | Last lines of a seat's pane (`rig capture`). `<seat>` may be `lead`, `orch.lead` or the full session name |
| `/rig detach` | Releases the address (`rig unclaim`) and stops listening |

The binding is stored in the session, so `pi -c` reconnects. `PI_OPENRIG_ADDR=<address>` binds at start to an address that is already attached.

While attached:

- **Receive.** A queue item sent to the address arrives as a user message (after the current turn if pi is busy), with the commands to claim and close it. Items that arrived while pi was closed or disconnected are delivered on reconnect.
- **Decide.** If the item body has a ` ```decision ` block, a selector opens instead. The answers go back to the sender with `rig queue handoff`, tagged `decision-answer`. "나중에" hands the item to the conversation instead.
- **Send.** The `rig_send_work` tool lets the model hand work to a seat (`rig queue create --body-file`). The system prompt tells the model the address, the other seats and these rules.
- **Watch.** The status line shows each seat (`●` running, `○` idle, `!` needs input). A seat that needs input or fails to launch raises a notification, also through `cmux notify` when running inside cmux.
- `OPENRIG_SESSION_NAME` is set for the conversation's shell commands, so `rig queue claim` etc. need no `--source`.

## Asking the human for a decision (for seats)

OpenRig's `--human-intent decision` requires a registered human destination. To ask through the pi conversation instead, send an ordinary queue item whose body has a fenced block in the same schema as `--human-questions-file` (1-4 questions, 2-4 options, at most one `recommended`):

````markdown
Subtitle font for the preview.

```decision
[{"id":"font","question":"자막 폰트?","options":[
  {"id":"pretendard","label":"Pretendard","recommended":true},
  {"id":"line","label":"LINE Seed"}]}]
```
````

```bash
rig queue create --destination orch-pi@<rig> --summary "자막 폰트 결정" --body-file ask.md
```

The reply item contains a readable list and a ` ```decision-answers ` block:

```json
[{"id":"font","kind":"option","optionId":"line","label":"LINE Seed"}]
```

A typed answer is `{"id":"font","kind":"typed","text":"..."}`.

Put this in the lead seat's role guidance so it knows where to report:

> Report results and ask decisions by `rig queue create --destination orch-pi@<rig> --body-file <file>`. For a decision, include a ```decision block.

## Limits

- One conversation per address. Two conversations attached to the same address both receive each item.
- Attaching from inside tmux records the tmux session name as the claim; the address still routes.
- Seat activity for external (attached) nodes shows as `unknown` in `rig ps`.

## Develop

```bash
pi -e ./            # load from the checkout
npm test            # unit tests (SSE parser, decision schema)
npx -p typescript tsc --noEmit -p .
```
