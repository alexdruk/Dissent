# Dissent

Adversarial AI analysis for strategic documents. Paste or upload a business plan, decision brief, technical proposal, strategy doc, or developer README — Dissent stress-tests it from four simultaneous angles and synthesises the highest-confidence risks.

## How it works

1. **Select document type** — five modes, each with a tailored section checklist
2. **Gap review** — Claude identifies missing sections and drafts them for your approval
3. **Adversarial panel** — four AI roles run in parallel, each attacking from a distinct angle:
   - **A** Assumption Archaeologist
   - **B** Execution Sceptic
   - **C** Competitive Threat Modeller
   - **D** First Principles Challenger
4. **Synthesis** — cross-role convergence reveals your highest-confidence risks

## Quick start

```bash
git clone https://github.com/your-username/dissent.git
cd dissent
npm install
cp .env.example .env          # add your Anthropic key
npm start                      # → http://localhost:3000
```

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com).

## Adding AI providers

By default all roles use Claude. To swap a role to GPT-4o, Gemini, or Mistral, follow the step-by-step instructions in SETUP.md.

## Stack

Node.js · Express · Anthropic Claude · Server-Sent Events · single-file HTML frontend · no framework · no build step

## License

MIT
