# AI Moderator plugin

Checks each comment with NVIDIA Nemotron (on Nebius Token Factory) before it posts:

- **Clean** → allowed.
- **Rude** → not allowed. A plain reason, plus a better way to say the same thing that has already passed the check. The writer can use it, edit, or ask a moderator.
- **Severe** (threats, hate, doxxing, self-harm encouragement) → not allowed. An explanation of what's wrong and why — no suggestion, since we can't know what they meant. The writer rewrites it themselves; there's no AI rewrite. It is also sent to the moderator queue automatically, and a moderator can never approve it.
- **Unsure** → not allowed yet. A non-English comment the model can't read with confidence (or one that scores just under the line, 0.25–0.40) isn't guessed at; it goes to a moderator.
- **Model unavailable** → not allowed (fail closed), and the writer is told.

A comment waiting for a moderator (asked for, or unsure) stays unposted until they approve it. If nobody answers within 10 minutes it stays unposted, and the writer can edit it or ask again.

Your app has one rule: **post the comment only when `allowed` is true.**

Requires Node 20+. No npm dependencies.

## Engine only

```js
import { createModerator } from './plugin/src/index.mjs';

const moderator = createModerator();            // reads NEBIUS_API_KEY
const result = await moderator.moderate('i hate you', { replyingTo: 'Got invited to sing at a big event!' });
// { allowed: false, verdict: 'rude', reason: 'This tells another person you hate them.',
//   suggestion: "I'm not a fan of your singing.", score: 0.45, category: 'insult' }
```

`replyingTo` is optional. It only shapes the suggestion; the verdict always comes from the comment's own words.

## Server routes + widget

```js
import { createModeratorService, moderatorHandler } from './plugin/src/index.mjs';

const moderation = moderatorHandler(createModeratorService(), {
  base: '/api/plugin',
  secret: process.env.MODERATOR_KEY, // optional: require header x-moderator-key
  perMinute: 20,                     // checks per client IP per minute
});
// Express:    app.use(moderation);
// Plain http: http.createServer((req, res) => moderation(req, res, () => yourRoutes(req, res)));
```

This adds:

| Route | Body | Returns |
|---|---|---|
| `POST /preview` | `{ text }` | Instant typing hint (no model call; never allows anything) |
| `POST /check` | `{ text, replyingTo? }` | The verdict, with an `id`. `review` is set for unsure (`waiting`) and severe (`flagged`) |
| `POST /accept` | `{ id }` | The exact suggestion that was shown, `allowed: true` |
| `POST /ask` | `{ id }` | [Ask a moderator] for a rude comment → `{ status: 'waiting', allowed: false, reason, expires_at }` |
| `POST /status` | `{ id }` | Where a review stands: `waiting`, `flagged`, `approved` (`allowed: true`, `text` = the approved words), `upheld` or `expired` |
| `GET /decisions` | | Recent checks |

### Moderator queue

Open reviews (asked for, unsure and severe) come from `service.queue()`, and a moderator decides with `service.resolve(id, 'approve' | 'uphold')`. Call these from your own admin page, behind your own login.

Or pass `moderatorSecret` to `moderatorHandler` to mount `GET /queue` and `POST /resolve` (`{ id, decision }`). They need the header `x-moderator-admin: <moderatorSecret>`; without the option they don't exist, so a writer can never approve their own comment. Keep that secret on your server — don't put it in a page writers can open.

```html
<link rel="stylesheet" href="/moderator-widget.css">
<div id="moderator"></div>
<script src="/moderator-widget.js"></script>
<script>
  AIModerator.mount(document.querySelector('#moderator'), {
    endpoint: '/api/plugin',
    replyingTo: 'the post text',          // optional
    onAllowed: text => postYourComment(text),
  });
</script>
```

For a rude comment the widget shows **Use this**, **Edit it myself** and **Ask a moderator**. While a comment waits for a moderator it checks `/status` every 5 seconds (`pollEvery`) and calls `onAllowed` with the approved words if they approve. Editing the draft stops the wait; the new text is checked from the top.

Restyle the widget with the `--aim-*` CSS variables on `.aim`.

## Options

| Option / env | Default | Purpose |
|---|---|---|
| `NEBIUS_API_KEY` | none | Token Factory key. Server side only |
| `LLM_MODEL` | `nvidia/Nemotron-3-Ultra-550b-a55b` | Model name |
| `LLM_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | Any OpenAI-compatible endpoint |
| `createModerator({ call })` | Nemotron | Any `async (messages, maxTokens) => string`, to use another model |
| `createModerator({ cleanMax, severeMin })` | `0.40`, `0.85` | Verdict thresholds |
| `createModeratorService({ persist })` | memory only | `async (item, decisions) => 'storage label'`, to save decisions |
| `createModeratorService({ reviewTimeoutMs })` | 10 minutes | How long a comment waits for a moderator before it stays unposted |
| `moderatorHandler(service, { moderatorSecret })` | off | Mounts the `/queue` and `/resolve` moderator routes |

## Privacy

Emails, phone numbers and 12-digit ID numbers are masked before text is sent to the model. Nothing is posted without the host app's decision.

## Try it

```bash
npm test                              # stub model, no network
NEBIUS_API_KEY=your-key npm run demo  # widget + moderator panel on http://localhost:8790
```
