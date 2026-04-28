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
cp .env.example .env          # add your API keys (see below)
npm start                      # → http://localhost:3000
```

Requires Node.js 18+. API keys needed:

| Key | Provider | Used for |
|-----|----------|----------|
| `ANTHROPIC_API_KEY` | [Anthropic](https://console.anthropic.com) | **Required** — Role A, summary, synthesis |
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com) | Role B (Execution Sceptic) |
| `GOOGLE_API_KEY` | [Google AI Studio](https://aistudio.google.com) | Role C (Competitive Threat) |
| `MISTRAL_API_KEY` | [Mistral](https://console.mistral.ai) | Role D (First Principles) |

Only `ANTHROPIC_API_KEY` is required to run. Missing provider keys fall back to Claude automatically.

## Stack

Node.js · Express · Anthropic Claude · Server-Sent Events · single-file HTML frontend · no framework · no build step

## Status

V.1 implemented

## License

MIT
