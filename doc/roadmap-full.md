# Dissent — Full Product Roadmap
### Version 1.0 | April 2026
### From MVP to category-defining tool

---

## Vision

Dissent becomes the default pre-decision layer for any organisation making an irreversible strategic choice. The way spell-check is invisible infrastructure for writing, adversarial analysis becomes invisible infrastructure for deciding.

---

## Phase 0 — Validate (Month 0–1)
*Done or in progress*

- [x] MVP codebase (Node.js / Express / SSE)
- [x] Five document type modes with tailored section checklists
- [x] Gap review page (accept / edit / skip per section)
- [x] Synthesised document view with AI-suggested additions marked
- [x] Four adversarial roles + synthesis (7 AI calls per session)
- [x] File upload with security validation (.pdf, .docx, .txt, .md)
- [x] Gumroad prompt library ($9 pre-validation product)
- [ ] Stripe integration
- [ ] First 10 paying customers

---

## Phase 1 — Quality (Month 1–3)

### 🔴 Structured synthesis output
*High priority — biggest impact on perceived value*

Replace prose synthesis with a structured risk dashboard:
- Each objection rated: **Critical / Significant / Minor**
- Category: Assumption / Execution / Competitive / First-Principles
- Cross-role convergence score (1–4)
- Recommended action per objection
- Rendered as a visual dashboard with severity colour-coding

*Why it matters:* Transforms the product from "AI writes a report" to "professional risk assessment tool." The structured output is what a consultant would produce. It's also directly comparable to competing tools, which all produce prose.

### Word-by-word streaming
- Token-level streaming for all role outputs
- First tokens appear within 2–3 seconds of submission
- Eliminates the largest source of user abandonment (waiting for slow calls)

### localStorage analysis history
- Last 10 sessions stored in browser, no backend required
- "Recent analyses" panel on landing page
- One-click restore of previous session

### PDF export
- Formatted PDF: mode, date, document summary, all role outputs, structured synthesis
- Every exported PDF that circulates is a referral event

### In-app quality feedback
- Thumbs up/down per synthesis
- Optional 1-sentence comment
- Weekly prompt iteration based on negative ratings

---

## Phase 2 — Depth (Month 3–6)

### 🔴 Document comparison mode
*High priority — unlocks a new use case and a new customer segment*

Submit two versions of the same document (v1 and v2). Dissent:
1. Runs gap analysis on both
2. Runs all four adversarial roles on both in parallel
3. Runs a "comparison synthesis" as a sixth call: which version is structurally stronger, where did v2 improve, where did it regress, what remains unresolved?

*Use cases:*
- Founder revised a pitch after investor feedback — is the new version actually better?
- Strategy team iterated a proposal — which version do we submit to the board?
- Developer updated a README — did the new version address the adoption friction problems?

*Implementation:* Two-document submission form on landing page, parallel processing, dedicated comparison synthesis prompt, side-by-side results UI.

### Multi-model adversarial panel
Assign each role to a different AI provider for genuine analytical divergence:
- Role A → Claude (logical/structural)
- Role B → GPT-4o (operational/direct)
- Role C → DeepSeek R1 (competitive/different training distribution)
- Role D → Gemini (first-principles/scientific grounding)
- Synthesis → Mistral (neutral aggregator)

This directly answers the "identical reasoning engines" objection and makes convergence across roles meaningfully significant.

### Custom role builder
Users define a fifth adversarial persona:
- "Write as my most sceptical board member"
- "Write as a GDPR compliance officer"
- "Write as a Series A investor who has seen this market fail twice"
Saved per user, sharable as templates. Natural upsell to power users.

### Gap card "improve my draft" button
One-shot improvement pass on an accepted draft before submitting:
- User edits the draft
- Clicks "Strengthen this"
- Claude returns a more specific, evidence-based version
- User accepts or reverts

---

## Phase 3 — Distribution (Month 6–12)

### Shareable analysis links
Read-only URL for a completed analysis:
- 6-character session ID stored in Supabase (free tier up to 500MB)
- No account required to view a shared link
- Shared links show: mode, document summary, all role outputs, structured synthesis
- Analytics: see how many times your shared analysis was viewed

*Why it matters:* Every shared link is a user acquisition event. A founder shares their stress-test with a co-founder — that co-founder is now a Dissent user.

### Follow-up questions on synthesis
Conversational layer on top of the static synthesis:
- "Expand on the competitive threat from Validator AI"
- "What's the strongest counter-argument to the pricing assumption?"
- "Give me a concrete action plan to address the top three risks"

Implemented as a continuation call with full context: original document, all role outputs, synthesis, and user question. Not a general chatbot — constrained to the analysis context.

### Document type auto-detection
Preliminary classification call (200 words, fast) infers document type and pre-selects the mode. User can override. Reduces the one friction point that requires active user judgment.

### Accelerator programme integrations
- Formalised batch analysis API for accelerator programmes
- Programme managers submit cohort documents via API, receive structured JSON results
- Dissent branding on output ("Powered by Dissent")
- Pricing: flat monthly fee per cohort size

---

## Phase 4 — Platform (Month 12–24)

### Team workspaces
- Shared analysis history visible to all workspace members
- Comment threads on specific synthesis objections
- Decision tracking: what was decided after the analysis, and did it work?
- Institutional memory: search past analyses by topic, document type, outcome

### Webhook and API access
- Trigger a Dissent analysis programmatically
- Receive results via webhook (JSON)
- Zapier integration: "When a new document is added to Notion, run a Dissent analysis"
- Linear integration: "When a PRD is marked ready for review, run a technical proposal analysis"

### Benchmark database
- Opt-in anonymised comparison: "Your go-to-market section is stronger than 68% of startup plans we've analysed in this mode"
- Aggregate patterns: "Plans that scored high on assumption quality raised their next round at 2.3× higher valuations"
- Requires: opt-in data collection, privacy review, minimum N of ~500 sessions per mode

### Dissent for teams — enterprise tier
- SSO (SAML/OIDC)
- Custom adversarial roles defined at workspace level
- Audit log of all analyses
- Custom section checklists per document type
- Priority API access with dedicated rate limits
- Pricing: $499–1,499/month depending on seat count

---

## Phase 5 — Category definition (Month 24+)

### The long-term bets

**Decision database**
Track what was decided after each analysis and whether it worked. Over time, Dissent has data on which types of objections predicted failure and which were false alarms. The synthesis prompt can weight its confidence scores based on historical outcomes. No other tool has this data.

**Regulatory compliance mode**
GDPR, SOC2, HIPAA, FCA — each has a known set of compliance requirements that map directly to the gap analysis checklist format. Dissent becomes the pre-submission stress-test for compliance documentation.

**Integration with VC due diligence workflows**
VCs receive hundreds of decks. A Dissent API integration means every deck gets a standardised adversarial analysis before it reaches a partner meeting. The output becomes a shared vocabulary between investor and founder.

---

## What we explicitly will not build

- A document writing tool (Dissent attacks documents, it doesn't create them)
- A general AI assistant (the adversarial framing is the product)
- A meeting summariser or note-taker (different problem, different persona)
- A compliance certification tool (adjacent, but requires legal liability we don't want)

---

## Roadmap summary

| Phase | Timeline | Key deliverable | Revenue target |
|---|---|---|---|
| 0 — Validate | Month 0–1 | 10 paying customers | $490 MRR |
| 1 — Quality | Month 1–3 | Structured synthesis, streaming, history | $1,960 MRR |
| 2 — Depth | Month 3–6 | Comparison mode, multi-model, custom roles | $5,000 MRR |
| 3 — Distribution | Month 6–12 | Shareable links, API, accelerator deals | $15,000 MRR |
| 4 — Platform | Month 12–24 | Team workspaces, webhooks, benchmarks | $50,000 MRR |
| 5 — Category | Month 24+ | Decision database, enterprise, VC integration | — |
