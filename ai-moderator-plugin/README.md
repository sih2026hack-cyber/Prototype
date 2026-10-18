# AI Moderator plugin

A writing assistant you can drop into any Node project. As someone types a comment it:

1. **Checks instantly, with no network call.** Local rules catch direct threats ("I will kill him") and hostile wording. Quotes, denials and fiction ("the character said…", "I will not…") are not flagged as threats.
2. **Reviews with AI after a short pause.** MiniMax scores the draft with the AI Moderator prompts and writes a safer or clearer rewrite. The rewrite is **scored again** before it is shown, and threats only ever get a de-escalated rewording. A direct-threat warning cannot be removed by an optimistic model answer.
3. **Lets the writer accept the suggestion**, and keeps a history of decisions.

If MiniMax is unavailable, the local check still works and the box says so.

## Folder

| Path | What it is |
|---|---|
| `src/moderator.mjs` | The engine: `inspectDraft()` (local rules), `createModerator()` (AI review plus rewrite), `redact()` |
| `src/service.mjs` | Server side: `createModeratorService()` (preview / check / accept / history) and `moderatorHandler()` (HTTP routes) |
| `src/minimax.mjs` | Small MiniMax client. You can swap in any model function. |
| `prompts/prompts.ts` | The AI Moderator prompts (scoring and rewrite), read as text, so no TypeScript is needed |
| `widget/` | The drop-in UI: `moderator-widget.js` and `moderator-widget.css`, with no build step |
| `demo/` | A runnable example page and server |
| `test/test.mjs` | Tests that use a stubbed model (no network) |

The only requirement is Node 20 or newer. There are no npm dependencies.

## Try it

```bash
cd ai-moderator-plugin
MINIMAX_API_KEY=your-key npm run demo
```

Then open http://localhost:8790. Without a key, only the local check runs. Run `npm test` for the tests.

## Add it to another project

Copy the `ai-moderator-plugin` folder into the project.

**1. Server routes.** These work with plain `http`, Express or Connect:

```js
import { createModeratorService, moderatorHandler } from './ai-moderator-plugin/src/index.mjs';

const moderation = moderatorHandler(createModeratorService(), { base: '/api/plugin' });

// Express:     app.use(moderation);
// Plain http:  http.createServer((req, res) => moderation(req, res, () => yourOtherRoutes(req, res)));
```

This adds `POST /api/plugin/preview`, `POST /api/plugin/check`, `POST /api/plugin/accept` and `GET /api/plugin/decisions`. Each POST takes JSON `{ "text": "..." }`; `accept` takes `{ "id": "..." }`.

**2. The UI box:**

```html
<link rel="stylesheet" href="/moderator-widget.css">
<div id="moderator"></div>
<script src="/moderator-widget.js"></script>
<script>
  AIModerator.mount(document.querySelector('#moderator'), {
    endpoint: '/api/plugin',
    onAccept: text => console.log('Writer accepted:', text),
  });
</script>
```

Serve the two files in `widget/` from your app. The box uses your page's `--bg`, `--text`, `--line`, `--muted`, `--teal`, `--red` and `--yellow` CSS variables if they exist; otherwise it uses its own dark theme. To restyle it, set the `--aim-*` variables on `.aim`.

**3. Optional: just the engine, no HTTP:**

```js
import { createModerator, inspectDraft } from './ai-moderator-plugin/src/index.mjs';

inspectDraft('I will kill him');                // instant, local
const moderator = createModerator();            // reads MINIMAX_API_KEY
const result = await moderator.moderate('This show is so stupid, you idiot');
// { verdict: 'safe' | 'review' | 'high_risk', reason, corrected_text, note, complete, ... }
```

## Configuration

| Option / env | Default | Purpose |
|---|---|---|
| `MINIMAX_API_KEY` | none | Needed for the AI review. Keep it on the server only. |
| `MINIMAX_MODEL` | `MiniMax-Text-01` | Model name |
| `MINIMAX_BASE_URL` | `https://api.minimax.io/v1/text/chatcompletion_v2` | API endpoint |
| `createModerator({ call })` | MiniMax | Any `async (messages, maxTokens) => string` function, to use another LLM |
| `createModerator({ promptsFile })` | `prompts/prompts.ts` | Use a newer copy of the AI Moderator prompts |
| `createModeratorService({ persist })` | memory only | `async (item, decisions) => 'storage label'`, to save decisions to a database |

## Privacy

- Before a draft is sent to the model, emails, phone numbers and 12-digit ID numbers are masked.
- Nothing is posted or changed without the writer clicking **Use suggestion**.
- Decision history is kept in memory unless you pass `persist`.
