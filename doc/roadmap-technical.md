# Dissent — Technical Implementation Roadmap
### For the technical co-founder
### Ordered by implementation priority, not calendar

---

## How to read this document

Each item has:
- **Effort** — realistic hours for a developer familiar with the codebase
- **Files** — which files change
- **Dependency** — what must exist first
- **Risk** — what could go wrong

Items marked 🔴 are high priority per the business roadmap.

---

## Tier 1 — Ship immediately (Week 1–4)

### T1.1 — Stripe integration
**Effort:** 8–12 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** None
**Risk:** Low — Stripe is well-documented

Steps:
1. `npm install stripe`
2. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to `.env`
3. Add `/api/create-checkout-session` endpoint — creates a Stripe Checkout session with `price_id` for pay-per-use ($49) or subscription ($49/$149/month)
4. Add `/api/webhook` endpoint — handles `checkout.session.completed`, sets a session cookie granting analysis access
5. Add a payment wall in `/api/analyse`: check for valid session cookie before proceeding
6. Frontend: add pricing page as a new stage between landing and gap-loading when the user has no valid session

Price IDs to create in Stripe dashboard:
- `price_pay_per_use` — one-time $49
- `price_pro_monthly` — recurring $49/month
- `price_team_monthly` — recurring $149/month

---

### T1.2 — Word-by-word streaming for role outputs
**Effort:** 4–6 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** None
**Risk:** Medium — SSE chunking needs careful buffering

Current state: each role result arrives as one event when the full response completes.

Target state: tokens stream into the tab as they are generated, first content appears within 2–3 seconds.

Implementation:
1. In `server.js`, replace `anthropic.messages.create()` with `anthropic.messages.stream()` for role calls
2. Instead of `send("role_complete", { output })`, send `send("role_token", { id, token })` per chunk, then `send("role_complete", { id })` when done
3. In `public/index.html`, maintain a `roleBuffers` object keyed by role ID; append tokens to the correct tab's `.mdc` div as they arrive
4. The synthesis call stays non-streaming (it needs to parse structure)

Note: streaming and `Promise.all` are compatible — each role has its own event channel.

---

## Tier 2 — First month post-launch

### 🔴 T2.1 — Structured synthesis output
**Effort:** 6–10 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** None — can ship independently
**Risk:** Medium — JSON reliability from LLMs requires fallback handling

**The change:**

In `server.js`, update `SYNTHESIS_SYSTEM` to return structured JSON:

```
Return ONLY a valid JSON object with this exact structure:
{
  "high_confidence_objections": [
    {
      "objection": "string",
      "roles": ["A", "C"],
      "severity": "critical" | "significant" | "minor",
      "category": "assumption" | "execution" | "competitive" | "first-principles",
      "recommended_action": "string"
    }
  ],
  "unique_objections": [...same shape, "roles" will be single-element array],
  "contradictions": [
    { "summary": "string", "role_a": "string", "role_a_claim": "string", "role_b": "string", "role_b_claim": "string" }
  ],
  "alternatives": [
    { "name": "string", "proposed_by": ["A", "D"], "problem_solved": "string", "tradeoff": "string", "type": "cosmetic" | "strategic" | "pivot" }
  ],
  "verdict": "string",
  "next_action": "string"
}
```

In the frontend, add a `renderStructuredSynthesis(data)` function that builds:
- A red/amber/green severity dashboard for high-confidence objections
- A contradiction panel
- An alternatives comparison table
- The verdict + next action in a prominent box

Always keep the raw prose synthesis as a fallback — if JSON parse fails, fall back to the current prose renderer.

---

### T2.2 — localStorage analysis history
**Effort:** 3–4 hours
**Files:** `public/index.html` only
**Dependency:** None
**Risk:** Low

```js
// Schema
const HISTORY_KEY = "dissent_history";
const MAX_HISTORY = 10;

function saveToHistory(session) {
  // session: { id, date, mode, docSummary, roleOutputs, synthesis }
  const history = getHistory();
  history.unshift({ ...session, id: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
  catch { return []; }
}
```

Call `saveToHistory()` in the `done` SSE event handler.

Add a "Recent analyses" collapsible section on the landing page — clicking an item restores the full result view without re-running the analysis.

---

### T2.3 — PDF export
**Effort:** 5–8 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** T2.1 (structured synthesis) recommended but not required
**Risk:** Low

```bash
npm install pdfkit
```

Add `/api/export-pdf` endpoint:
- Accepts: `{ mode, roleOutputs, synthesis, date }`
- Returns: `Content-Type: application/pdf` binary stream
- Uses pdfkit to render: cover page (mode, date), one section per role, structured synthesis section

Frontend: replace the current "Copy" button in results with a row of actions: Copy · Export PDF · (future: Share link)

---

## Tier 3 — Month 2–3

### 🔴 T3.1 — Document comparison mode
**Effort:** 12–16 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** T2.1 (structured synthesis) strongly recommended
**Risk:** Medium — parallel processing of two full pipelines is 12 concurrent API calls

**New endpoint:** `POST /api/compare`

Input: `{ docA, docB, mode }`

Processing:
```
Step 1: Gap analysis on docA (parallel with step 2)
Step 2: Gap analysis on docB (parallel with step 1)
Step 3: Summary call for docA
Step 4: Summary call for docB
Step 5: All 4 roles on docA (parallel)
Step 6: All 4 roles on docB (parallel — steps 5 and 6 run concurrently)
Step 7: Comparison synthesis call — reads all 8 role outputs + both summaries
```

Comparison synthesis prompt additions:
```
You have received adversarial analyses of two versions of the same document.
In addition to the standard synthesis sections, add:

## Version comparison
- Which version is structurally stronger overall and why
- Specific sections where v2 improved over v1
- Specific sections where v2 regressed or introduced new problems
- Objections present in v1 that v2 resolved
- New objections in v2 not present in v1
- What remains unresolved in both versions
```

**Frontend additions:**
- New landing page variant: "Compare two versions" toggle
- Two textareas (or upload zones) side by side
- Side-by-side results tabs: "Version A" / "Version B" / "Comparison"

**API cost:** approximately $1.80–2.20 per comparison session (14 calls). Price at $79 per comparison session or include in Pro/Team subscriptions.

---

### T3.2 — Multi-model panel (DeepSeek + GPT-4o)
**Effort:** 3–4 hours (stubs already exist, just uncomment and configure)
**Files:** `server.js`, `.env`
**Dependency:** None
**Risk:** Low — OpenAI-compatible API for DeepSeek

```bash
npm install openai  # already a dependency
```

```env
OPENAI_API_KEY=sk-proj-...
DEEPSEEK_API_KEY=sk-...
```

In `server.js`, the stubs are already written. Uncomment `callOpenAI` and the DeepSeek variant:

```js
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

async function callDeepSeek(system, user, maxTokens = 1500) {
  const r = await deepseek.chat.completions.create({
    model: "deepseek-chat",  // V3 — faster than R1 for this use case
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ],
  });
  return r.choices[0].message.content ?? "";
}
```

Then in `buildRoles()`, change callers:
```js
// Role B
caller: callOpenAI,    // GPT-4o — sharper on operational failure

// Role C
caller: callDeepSeek,  // DeepSeek — different training distribution for competitive analysis
```

**Note on latency:** `deepseek-chat` (V3) is fast — comparable to Claude Sonnet. `deepseek-reasoner` (R1) adds 30–60s. Use V3 for the competitive role unless you add a loading message explaining the delay.

---

## Tier 4 — Month 3–6

### T4.1 — Shareable analysis links
**Effort:** 10–14 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** Supabase account (free tier), T2.1 recommended

```bash
npm install @supabase/supabase-js
```

Supabase table schema:
```sql
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,          -- 6-char nanoid
  created_at TIMESTAMPTZ DEFAULT now(),
  mode TEXT NOT NULL,
  doc_summary TEXT,
  role_outputs JSONB,
  synthesis JSONB,
  view_count INTEGER DEFAULT 0
);
```

New endpoints:
- `POST /api/share` — saves analysis, returns `{ id, url }`
- `GET /api/analysis/:id` — returns saved analysis JSON

Frontend:
- "Share" button in results header
- Generates and copies URL: `https://dissent.app/a/x7k2mq`
- Read-only view route: `/a/:id` renders results without the submit form

---

### T4.2 — Follow-up questions on synthesis
**Effort:** 4–6 hours
**Files:** `server.js`, `public/index.html`
**Dependency:** T2.1 (structured synthesis)

New endpoint: `POST /api/followup`
Input: `{ enrichedDoc, roleOutputs, synthesis, question }`

System prompt: *You are a strategic analyst. You have access to a full adversarial analysis of a strategic document. Answer the user's specific follow-up question using evidence from the analysis. Do not invent new analysis — cite the role outputs and synthesis you have been given.*

Frontend: text input at the bottom of the synthesis tab, renders response inline below the synthesis output.

---

## Tier 5 — Month 6+

| Item | Effort | Notes |
|---|---|---|
| Webhook / API access | 8–12h | API key generation, rate limiting, JSON output |
| Team workspaces | 20–30h | Auth (Clerk or Auth.js), shared Supabase storage |
| Custom role builder | 6–8h | Role definition form, saved to localStorage or Supabase |
| Auto document type detection | 2–3h | Preliminary classification call, mode pre-selection |
| Gap card "strengthen draft" | 3–4h | One-shot improvement call per card |
| SSO (enterprise) | 16–24h | SAML/OIDC, requires team workspace first |

---

## Infrastructure scaling notes

Current setup (Hetzner CX22, $6/month) handles approximately:
- 50 concurrent users
- ~200 sessions/day
- No database

At $5K MRR (~100 active users):
- Upgrade to CX32 ($12/month) — more comfortable headroom
- Add Supabase for history + sharing (free tier to ~500MB)
- Add Redis for session caching if Stripe sessions become slow

At $20K MRR (~400 active users):
- Consider moving to a managed Node.js platform (Railway, Render) to reduce ops burden
- Add a CDN (Cloudflare free tier) for static asset delivery
- Database connection pooling (PgBouncer via Supabase)

The architecture does not need to change until well past $20K MRR. The SSE-based streaming is the only unusual infrastructure concern — ensure nginx buffering remains disabled at every stage.
