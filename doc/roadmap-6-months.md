# Dissent — 6-Month Roadmap
### Target: $5,000 MRR, product-market fit signal

---

## Phase 1: Foundation (Month 1–2)
*Goals: Live product, first paying customers, quality baseline established*

### Must ship
- MVP with all 5 document type modes
- Stripe integration (pay-per-use + subscriptions)
- Gumroad prompt library for pre-validation
- **🔴 Structured synthesis output** — prioritised risk dashboard with severity ratings and convergence scores (see Item 3 in improvements backlog)

### Quality threshold before scaling
Do not spend money on marketing until the synthesis output reliably produces at least 3 objections a competent advisor would agree are non-obvious. Test with 20 real documents. If quality falls short, iterate on the prompts — this is cheaper than iterating on the architecture.

---

## Phase 2: Retention and Referral (Month 2–3)
*Goals: Users return for second session, first organic referrals*

### Ship
- **localStorage analysis history** — last 10 sessions, no backend required
- **PDF export** — formatted report download, every share is a referral
- **Word-by-word streaming** — token-level streaming for role outputs, dramatically reduces perceived wait time
- In-app quality rating (thumbs up/down per synthesis) — feeds prompt improvement loop

### Metrics to watch
- Session 2 rate: what % of users run a second analysis within 30 days?
- Share rate: how often does a user export or copy output to share elsewhere?
- Qualitative: are users describing the output as "surprising" or just "useful"? Surprising is better.

---

## Phase 3: Depth (Month 3–4)
*Goals: Power users emerge, team tier justifiable*

### Ship
- **🔴 Document comparison mode (Item 5)** — submit version A and version B, Dissent analyses both and identifies which is structurally stronger and why. Implementation: two-document submission form, two parallel gap analyses, two parallel adversarial panels, a sixth "comparison synthesis" call that reads both sets of role outputs and produces a differential analysis.

- **Multi-model panel** — DeepSeek R1 assigned to Role C (Competitive Threat Modeller) by default, GPT-4o to Role B (Execution Sceptic). This directly answers the "identical reasoning engines" objection and materially improves output divergence.

- **Custom role builder** — users define a fifth adversarial persona beyond the four defaults. "Write as my most sceptical board member." Power-user feature, natural upsell to team tier.

### Accelerator partnerships
- 5 signed accelerator partnerships providing batch analysis to their cohorts
- Each partnership = 10–30 new users with pre-qualified intent

---

## Phase 4: Distribution (Month 4–5)
*Goals: Organic growth loop, B2B pipeline begins*

### Ship
- **Shareable analysis links** — read-only URL for a completed analysis. Requires Supabase (free tier), a 6-character ID generator, and a read-only results view. Every shared link is a user acquisition event.

- **"Follow-up questions" on synthesis** — conversational layer on top of the static synthesis: "Expand on the competitive threat," "What's the strongest counter-argument?" Implemented as a continuation of the synthesis conversation with full context preserved.

- **Document type auto-detection** — preliminary Claude call classifies the document type from first 200 words and pre-selects the mode. Users can override. Reduces the one decision that currently requires user judgment at submission.

### Corporate persona outreach
- Strategy teams at 20 target companies (Series B–D startups, boutique consultancies)
- Positioning: pre-board-meeting adversarial review
- Team tier ($149/month) becomes the primary pitch

---

## Phase 5: Scale (Month 5–6)
*Goals: $5K MRR, clear path to $20K MRR*

### Ship
- **Webhook / API access** — trigger a Dissent analysis programmatically. Zapier integration. Connects to Notion, Linear, Google Docs workflows.
- **Team workspaces** — shared analysis history, team comments on specific sections, institutional memory of past decisions. Required for team tier retention.
- **Gap card "improve my draft" button** — one-shot improvement pass before accepting an AI-drafted section.

### Fundraising decision point
At $5K MRR: is this a lifestyle business (stay bootstrapped, grow to $20–50K MRR profitably) or a venture-scale bet (raise a small round, hire, accelerate)? The data from 5 months of real usage should make this clear.

---

## 6-month metrics targets

| Metric | Month 1 | Month 3 | Month 6 |
|---|---|---|---|
| MRR | $490 | $1,960 | $5,000 |
| Paying customers | 10 | 40 | 100 |
| Session 2 rate | — | 30% | 45% |
| Accelerator partnerships | 0 | 3 | 8 |
| Multi-model panel live | No | Yes | Yes |
| Document comparison live | No | Yes | Yes |
| Shareable links live | No | No | Yes |
