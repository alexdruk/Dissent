# Dissent — 90-Day Roadmap
### Target: 10 paying customers, first revenue

---

## Guiding principle

Every item on this roadmap must either reduce friction for the first 10 customers or improve the quality of what they experience. Nothing else ships in 90 days.

---

## Week 1–2 — Pre-launch validation

**Gumroad prompt library**
- Publish the 6-prompt PDF at $9
- Launch on Indie Hackers, Twitter/X, r/SideProject
- Success threshold: 25 purchases in 14 days

**Domain and hosting**
- Register domain (dissent.app or similar)
- Provision Hetzner CX22 VPS (~$6/month)
- Configure nginx + Let's Encrypt

---

## Week 3–4 — MVP live

**Core app deployment**
- Node.js/Express server with all 7 AI calls
- Five document type modes
- Gap review page (accept / edit / skip)
- Synthesised document view with AI-suggested additions marked
- Four adversarial roles + synthesis with SSE streaming
- File upload (.pdf, .docx, .txt, .md) with security validation

**Quality baseline**
- Run 10 real documents through the system (own plans + volunteers)
- Fix any output quality issues in the prompts
- Ensure all 5 modes produce sharp, specific analysis

---

## Week 5–6 — First users and feedback

**Soft launch**
- Post "Show HN" on Hacker News
- Post "Show IH" on Indie Hackers
- Personal DMs to 20 identified founders

**🔴 HIGH PRIORITY: Structured synthesis output (Item 3)**
The synthesis currently returns prose. Restructure the synthesis prompt to return a prioritised risk dashboard:
- Each objection rated by severity (critical / significant / minor)
- Category tags (assumption, execution, competitive, first-principles)
- Cross-role convergence score (how many roles raised it)
- Recommended action per objection

Render in the UI as a structured panel with colour-coded severity — red/amber/green. This makes the output look like a professional tool rather than a chatbot response and is the single strongest driver of perceived value.

*Implementation: modify `SYNTHESIS_SYSTEM` prompt to return JSON, add a structured results panel component to the frontend alongside the existing prose tab.*

---

## Week 7–8 — Monetisation

**Stripe integration**
- Pay-per-use: $49/session
- Pro subscription: $49/month (5 sessions)
- Team subscription: $149/month (20 sessions, 3 seats)
- Free trial: 1 session before payment required

**Product Hunt launch**
- Coordinate upvotes from network
- Launch post simultaneously on Indie Hackers and Twitter/X
- 5 hunters ready to comment on launch day

---

## Week 9–10 — Retention and referral

**localStorage analysis history**
- Store last 10 sessions in browser localStorage (no backend required)
- "Recent analyses" panel on landing page
- Prevents the biggest drop-off: users who close the tab and lose their results

**PDF export**
- "Export as PDF" button on results page
- Formatted: title, mode, date, role outputs, synthesis
- Every exported PDF that gets shared is a referral event

---

## Week 11–12 — Accelerator outreach

**Batch analysis partnerships**
- Email 10–15 accelerator programme managers
- Offer free batch analysis for their current cohort
- One yes = 10–15 users instantly

**10 paying customers milestone**
- Review: which mode converted best?
- Review: which acquisition channel worked?
- Review: what did paying customers say about the output quality?
- Decide: raise price, add features, or both?

---

## Success metrics at Day 90

| Metric | Target |
|---|---|
| Gumroad prompt library sales | 50+ |
| Total registered sessions | 200+ |
| Paying customers | 10+ |
| MRR | $490+ |
| NPS from first users | >40 |
| Synthesis quality rating (in-app) | >4/5 |
