import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(join(__dirname, "public")));

// ── Upload security constants ──────────────────────────────────────────────────

const UPLOAD_MAX_BYTES    = 5 * 1024 * 1024;   // 5 MB — hard cap enforced by multer
const EXTRACTED_MAX_CHARS = 60_000;             // matches text-paste limit
const EXTRACTED_MIN_CHARS = 50;
const ALLOWED_EXTENSIONS  = new Set([".txt", ".md", ".pdf", ".docx"]);

// Magic byte signatures — catches files renamed to a different extension.
// .txt and .md have no universal signature; we validate them as UTF-8 instead.
const MAGIC_SIGNATURES = {
  ".pdf":  { bytes: [0x25, 0x50, 0x44, 0x46] },          // "%PDF"
  ".docx": { bytes: [0x50, 0x4B, 0x03, 0x04] },          // "PK\x03\x04" (ZIP)
};

// ── In-memory IP rate limiter (no extra package) ───────────────────────────────
// 10 uploads per IP per 60-second rolling window.

const _rateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _rateMap) if (now > e.reset) _rateMap.delete(ip);
}, 300_000); // prune stale entries every 5 min

function checkUploadRate(ip) {
  const now = Date.now();
  const WINDOW = 60_000, MAX = 10;
  let e = _rateMap.get(ip);
  if (!e || now > e.reset) e = { count: 0, reset: now + WINDOW };
  e.count++;
  _rateMap.set(ip, e);
  return e.count <= MAX;
}

// ── Multer — memory storage only, file never written to disk ──────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = extname(file.originalname).toLowerCase();
    ALLOWED_EXTENSIONS.has(ext) ? cb(null, true) : cb(new Error("INVALID_TYPE"));
  },
});

// Multer error → clean JSON (must be defined as 4-arg Express error handler)
function multerErrorHandler(err, _req, res, next) {
  if (err?.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: "File too large — maximum 5 MB." });
  if (err?.message === "INVALID_TYPE")
    return res.status(400).json({ error: "File type not allowed. Upload .txt, .md, .pdf, or .docx." });
  next(err);
}

// ── Security helpers ──────────────────────────────────────────────────────────

function validateMagicBytes(buffer, ext) {
  const sig = MAGIC_SIGNATURES[ext];
  if (!sig) return true; // .txt / .md — no signature check
  return sig.bytes.every((b, i) => buffer[i] === b);
}

function sanitizeText(raw) {
  return raw
    .replace(/\0/g, "")                               // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars (keep \t \n \r)
    .replace(/[ \t]+$/gm, "")                         // trailing whitespace per line
    .replace(/\n{4,}/g, "\n\n\n")                     // collapse excessive blank lines
    .trim();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// ── POST /api/extract ─────────────────────────────────────────────────────────
// Accepts a multipart file upload; returns { text, chars, ext } as JSON.
// The browser then populates the textarea — extraction and analysis are
// separate requests so the user can review extracted text before submitting.

app.post("/api/extract", upload.single("file"), multerErrorHandler, async (req, res) => {
  // Rate limit by IP
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (!checkUploadRate(ip))
    return res.status(429).json({ error: "Too many uploads — please wait a minute." });

  if (!req.file)
    return res.status(400).json({ error: "No file received." });

  const { buffer, originalname } = req.file;

  // Extension — derived from filename, never from Content-Type (spoofable)
  const ext = extname(originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext))
    return res.status(400).json({ error: "File type not allowed." });

  // Magic byte check — catches e.g. a .exe renamed to .pdf
  if (!validateMagicBytes(buffer, ext))
    return res.status(400).json({ error: "File content does not match its declared type." });

  let text = "";
  try {
    if (ext === ".txt" || ext === ".md") {
      // Decode as UTF-8; Node replaces invalid sequences with the replacement character
      text = buffer.toString("utf8");
    } else if (ext === ".pdf") {
      // PDFParse v2: pass buffer via constructor, limit to first 50 pages
      const parser = new PDFParse({ data: buffer, verbosity: 0 });
      const result = await withTimeout(
        parser.getText({ first: 50 }),
        15_000, "PDF parse"
      );
      text = result.text;
      await parser.destroy();
    } else if (ext === ".docx") {
      const result = await withTimeout(mammoth.extractRawText({ buffer }), 15_000, "DOCX parse");
      text = result.value;
    }
  } catch (err) {
    // Do not surface internal parse error details — only log server-side
    logError("extract/parse", err);
    return res.status(422).json({
      error: "Could not read file — it may be corrupted, password-protected, or an unsupported variant.",
    });
  }

  // Sanitize and bounds-check the extracted text
  text = sanitizeText(text);

  if (text.length < EXTRACTED_MIN_CHARS)
    return res.status(422).json({ error: "File appears to be empty or contains no readable text." });

  if (text.length > EXTRACTED_MAX_CHARS)
    return res.status(413).json({
      error: `Extracted text is too long (${Math.round(text.length / 1000)}k chars). Maximum is ~12,000 words. Try uploading a shorter document.`,
    });

  // Return extracted text — never echo back the original filename
  res.json({ text, chars: text.length, ext });
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function callClaude(system, user, maxTokens = 1500) {
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return r.content.map(b => (b.type === "text" ? b.text : "")).join("");
}

// Streaming version — sends role_token SSE events as text arrives.
// Returns the full accumulated text when the stream ends.
async function streamRoleClaude(system, user, maxTokens, send, roleId) {
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  let fullText = "";
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
      const token = chunk.delta.text;
      fullText += token;
      send("role_token", { id: roleId, token });
    }
  }
  return fullText;
}

// Parse synthesis — tries JSON first, falls back to prose string.
function parseSynthesis(raw) {
  const clean = raw.replace(/```(?:json)?\n?/g, "").replace(/\n?```/g, "").trim();
  try {
    const data = JSON.parse(clean);
    if (!data.verdict || !Array.isArray(data.high_confidence_objections)) throw new Error("bad shape");
    return { structured: true, data };
  } catch {
    return { structured: false, data: raw };
  }
}

// ── Structured error logger ───────────────────────────────────────────────────
// Writes a consistent line to stdout for every server-side failure so the
// terminal always shows what failed, which endpoint, and the full reason.
function logError(context, err) {
  const ts  = new Date().toISOString();
  const msg = err?.response?.data?.error?.message  // Anthropic/OpenAI structured error
           ?? err?.message
           ?? String(err);
  const status = err?.status ?? err?.response?.status ?? "";
  console.error(`[${ts}] ERROR [${context}]${status ? " HTTP " + status : ""}: ${msg}`);
  // Log the full stack in development so the line number is visible
  if (process.env.NODE_ENV !== "production" && err?.stack) {
    console.error(err.stack);
  }
}


// ── AI provider clients ───────────────────────────────────────────────────────
// All four providers are active. Each requires an API key in .env.
// If a key is missing the client will be created but calls will fail —
// the Claude fallback in the role runner will catch this automatically.
//
// Keys required in .env:
//   OPENAI_API_KEY=sk-proj-...
//   GOOGLE_API_KEY=AIza...
//   MISTRAL_API_KEY=...
//
// Recommended role assignment for maximum analytical divergence:
//   Role A (Assumption Archaeologist)  → callClaude   — strong structural/logical critique
//   Role B (Execution Sceptic)         → callOpenAI   — GPT-4o sharper on operational failure
//   Role C (Competitive Threat)        → callGemini   — strong on market/competitive landscape
//   Role D (First Principles)          → callMistral  — different training emphasis adds divergence

const openai  = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const gemini  = process.env.GOOGLE_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })
  : null;

const mistral = process.env.MISTRAL_API_KEY
  ? new Mistral({ apiKey: process.env.MISTRAL_API_KEY })
  : null;

async function callOpenAI(system, user, maxTokens = 1500) {
  if (!openai) throw new Error("OPENAI_API_KEY not set — add it to .env");
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ],
  });
  return r.choices[0].message.content ?? "";
}

async function callGemini(system, user, maxTokens = 1500) {
  if (!gemini) throw new Error("GOOGLE_API_KEY not set — add it to .env");
  const r = await gemini.models.generateContent({
    model: "gemini-flash-latest",
    config: { maxOutputTokens: maxTokens, systemInstruction: system },
    contents: user,
  });
  return r.text ?? "";
}

async function callMistral(system, user, maxTokens = 1500) {
  if (!mistral) throw new Error("MISTRAL_API_KEY not set — add it to .env");
  const r = await mistral.chat.complete({
    model: "mistral-large-latest",
    maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ],
  });
  return r.choices?.[0]?.message?.content ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────


// ── Document type modes ───────────────────────────────────────────────────────
// Each mode defines:
//   label       — shown in the UI selector
//   description — shown as a hint under the selector
//   sections    — ordered list of sections to check, each with name + guidance
//   roleHints   — injected into each adversarial role prompt as a one-liner context

const DOC_MODES = {
  startup: {
    label: "Startup / investor plan",
    description: "Business plan, pitch deck, fundraising memo",
    roleHints: {
      assumption:      "This is a startup or investor plan. Pay particular attention to market size assumptions, customer willingness-to-pay, and growth rate assumptions — these are where founders most systematically deceive themselves.",
      execution:       "This is a startup or investor plan. Focus on the path to first paying customers, burn rate realism, and whether the team has done this before.",
      competitive:     "This is a startup or investor plan. You are a senior strategist at the most threatening incumbent or well-funded competitor. Be specific about which company you represent.",
      firstprinciples: "This is a startup or investor plan. Challenge whether this is a vitamin or a painkiller, whether the market is as large as claimed, and whether the team can actually execute.",
      evidence:        "This is a startup or investor plan. Focus on whether the problem is evidenced by observable public behaviour — complaints, workarounds, job postings, search demand — or merely asserted. Founders systematically overstate problem severity based on conversations with sympathetic peers.",
    },
    sections: [
      { name: "Executive summary",              guidance: "A tight decision-oriented overview: what is being built, for whom, why now, and what is being asked — often written last but read first." },
      { name: "Problem statement",              guidance: "Clearly defined with evidence of real pain — not a generic observation but a specific description of who suffers, how often, and how acutely." },
      { name: "Target customer",                guidance: "Specific persona with pain level and willingness to pay — 'SMBs' is not a customer; a named archetype with a job title and a specific workflow problem is." },
      { name: "Solution / product description", guidance: "How the product actually works, not just what problem it solves — the mechanism, the workflow, the key differentiating feature." },
      { name: "Key assumptions",                guidance: "The critical beliefs the plan depends on, stated explicitly: market size, conversion rates, pricing tolerance, competitive response, hiring timeline." },
      { name: "Market sizing",                  guidance: "TAM/SAM/SOM with methodology — bottom-up preferred; top-down accepted only with a credible source and a realistic penetration argument." },
      { name: "Competitor analysis",            guidance: "Named competitors with URLs, feature comparison, and a clear positioning argument for why this product wins on a specific dimension." },
      { name: "Go-to-market strategy",          guidance: "Specific channels, tactics, and a 90-day timeline to first 10 paying customers — not 'content marketing and SEO' but named communities, outreach templates, and a sequenced plan." },
      { name: "Business model and pricing",     guidance: "Revenue model, unit economics, and pricing rationale — COGS per transaction, gross margin, and why the price point fits the customer's pain level." },
      { name: "Financial projections",          guidance: "Monthly forecasts for Year 1, annual for Years 2–3, with cost structure and break-even month explicitly stated." },
      { name: "Sensitivity analysis",           guidance: "What happens if 2–3 key assumptions fail simultaneously — the downside case with specific numbers, not qualitative hedging." },
      { name: "Funding requirements & use of funds", guidance: "How much capital is needed, over what period, allocated to which specific categories — hiring, infrastructure, marketing, runway." },
      { name: "Team and execution plan",        guidance: "Who is building this and why they are credible for this specific problem — relevant prior experience, not just titles." },
      { name: "Traction / proof points",        guidance: "Early users, pilots, letters of intent, revenue, or waitlist — any evidence that demand exists beyond the founder's conviction." },
      { name: "Risk assessment",                guidance: "Specific risks with named mitigations: technical, market, competitive, operational, financial — not generic categories but named failure modes." },
      { name: "Success metrics",                guidance: "KPIs and milestones with specific numbers and dates — not 'grow revenue' but '100 paying customers by Month 6 at $49/month average.'" },
    ],
  },

  decision: {
    label: "Decision brief",
    description: "Internal proposal, options analysis, recommendation memo",
    roleHints: {
      assumption:      "This is an internal decision brief. Focus on whether the framing of the decision is itself biased — whether options were defined to make the preferred choice look inevitable.",
      execution:       "This is an internal decision brief. Focus on implementation risk, organisational change management, and whether the team executing this decision has the authority and capability to do so.",
      competitive:     "This is an internal decision brief. Consider external competitive dynamics that the decision creates or ignores — what does a competitor do if this decision is made?",
      firstprinciples: "This is an internal decision brief. Challenge whether this is the right decision to be making at all, whether the options considered are complete, and whether the criteria are measuring what actually matters.",
      evidence:        "This is an internal decision brief. Focus on whether the stated problem or opportunity is backed by observable data — usage metrics, revenue figures, documented complaints, measurable trends — or whether it rests on anecdote, assumption, or internal consensus that has never been stress-tested against external reality.",
    },
    sections: [
      { name: "Problem / opportunity statement",  guidance: "What specific situation requires a decision — with evidence of urgency and the cost of not deciding." },
      { name: "Decision timeline / urgency",       guidance: "Why this decision needs to be made now — the cost of delay and the window that closes if action is deferred." },
      { name: "Decision context and constraints",  guidance: "What is in scope vs out of scope; what constraints (budget, time, regulatory) bound the options." },
      { name: "Key assumptions",                   guidance: "Critical beliefs underpinning the recommendation — if any of these are wrong, the decision changes." },
      { name: "Options considered",                guidance: "At least three options including a 'do nothing' baseline — each described fairly, not set up as strawmen." },
      { name: "Decision criteria",                 guidance: "How options are evaluated — named criteria with relative weights, not an unranked list." },
      { name: "Recommendation",                    guidance: "A clear, opinionated conclusion — not 'it depends' but a specific choice with a rationale." },
      { name: "Trade-offs",                        guidance: "What is explicitly being given up by choosing this option over the alternatives." },
      { name: "Implementation plan",               guidance: "Concrete steps, owners, and a timeline — what happens in the first 30 days if this decision is approved." },
      { name: "Risk assessment",                   guidance: "Specific risks of the recommended option with mitigations — not generic concerns but named failure modes." },
      { name: "Success metrics",                   guidance: "How will we know if this decision was correct — measurable outcomes with a review date." },
    ],
  },

  technical: {
    label: "Technical / product proposal",
    description: "PRD, architecture proposal, engineering spec",
    roleHints: {
      assumption:      "This is a technical or product proposal. Stress-test the technical assumptions: scalability claims, integration complexity, latency requirements, and whether the described architecture can actually deliver the stated capabilities.",
      execution:       "This is a technical or product proposal. Focus on build complexity, dependency risk, testing burden, and whether the engineering timeline accounts for the real cost of production-grade code versus a prototype.",
      competitive:     "This is a technical or product proposal. Consider whether existing libraries, open-source projects, or established vendors solve this problem already — and what the build-vs-buy argument misses.",
      firstprinciples: "This is a technical or product proposal. Challenge whether the technical approach is the right solution or whether a simpler architecture would achieve the same outcome with less risk.",
      evidence:        "This is a technical or product proposal. Focus on whether the user problem is evidenced by observable behaviour — GitHub issues, Stack Overflow question volume, developer forum complaints, npm download trends for workaround libraries — or merely assumed. Technical proposals frequently mistake 'this is annoying' for 'people will pay to fix this.'",
    },
    sections: [
      { name: "Problem and use case",           guidance: "The specific user problem being solved, with a concrete usage scenario — not a technical description of what is being built." },
      { name: "Target user",                    guidance: "Who specifically uses this and in what context — 'developers' is not a user; a specific role with a specific workflow is." },
      { name: "Solution overview",              guidance: "How the product works at the user-facing level, distinct from the technical implementation." },
      { name: "Key assumptions",                guidance: "Technical beliefs the design depends on: latency requirements, data volumes, API reliability, browser/device constraints." },
      { name: "Architecture / technical approach", guidance: "Systems, stack, integrations, and key design decisions — with explicit rationale for choices made." },
      { name: "Dependencies",                   guidance: "External APIs, third-party services, data sources, and regulatory approvals the system relies on — with a risk rating for each." },
      { name: "Development roadmap",            guidance: "Phases with milestones and feature sequencing — what ships in v1, what is deferred and why." },
      { name: "Scalability considerations",     guidance: "What breaks at 10× and 100× usage — the specific bottlenecks and the plan to address them." },
      { name: "Data privacy and security",      guidance: "How user data is stored, transmitted, and protected — especially critical for SaaS and AI products handling sensitive documents." },
      { name: "Regulatory considerations",      guidance: "Industry-specific constraints — GDPR, SOC2, HIPAA, or others — and whether compliance is required at launch or can be deferred." },
      { name: "Risk assessment",                guidance: "Technical, security, and dependency risks with specific mitigations." },
      { name: "Success metrics",                guidance: "Measurable technical outcomes — latency targets, uptime SLAs, adoption KPIs." },
    ],
  },

  strategy: {
    label: "Strategy / operations doc",
    description: "Annual plan, OKR doc, operational strategy",
    roleHints: {
      assumption:      "This is a strategy or operations document. Challenge the environmental assumptions: market conditions, competitive landscape stability, and whether the strategic context described is accurate.",
      execution:       "This is a strategy or operations document. Focus on whether the operational plan is resourced correctly, whether owners are named for each initiative, and whether the timeline is realistic given current capacity.",
      competitive:     "This is a strategy or operations document. Consider how competitors will respond to the strategic moves described, and whether the strategy creates durable differentiation or is easily copied.",
      firstprinciples: "This is a strategy or operations document. Challenge whether the strategic choices are genuinely differentiated, whether the organisation has the capabilities to execute them, and whether the market opportunity is as durable as assumed.",
      evidence:        "This is a strategy or operations document. Focus on whether strategic claims are grounded in measurable data — market share figures, customer retention rates, revenue trends, named competitor moves — or are projections dressed as facts. Strategy documents routinely cite internal optimism as market evidence.",
    },
    sections: [
      { name: "Executive summary",              guidance: "The core strategic argument in one page — what is being decided, why, and what it requires." },
      { name: "Strategic context",              guidance: "The market, competitive, and internal conditions that make this strategy necessary now." },
      { name: "Vision and objectives",          guidance: "Where the organisation is going and what it must achieve — specific enough to evaluate whether the strategy achieves it." },
      { name: "Competitor analysis",            guidance: "How the competitive landscape is expected to evolve and how the strategy positions the organisation against it." },
      { name: "Key assumptions",                guidance: "Market and competitive beliefs the strategy depends on — explicitly stated so they can be monitored and revisited." },
      { name: "Strategic initiatives",          guidance: "The specific programmes or investments that execute the strategy — named, scoped, and sequenced." },
      { name: "Resource plan",                  guidance: "Budget and headcount allocation across initiatives — not just totals but the split between competing priorities." },
      { name: "Operational plan",               guidance: "How the strategy translates into day-to-day operations — processes, workflows, and accountabilities." },
      { name: "Timeline and milestones",        guidance: "A concrete schedule with quarterly checkpoints and named owners for each." },
      { name: "Dependencies and partnerships",  guidance: "External organisations or internal teams the strategy depends on — with a risk assessment for each." },
      { name: "Risk assessment",                guidance: "Strategic, operational, and market risks with specific mitigations and a named owner for each." },
      { name: "Success metrics",                guidance: "OKRs or KPIs with specific targets and review cadences — not aspirational statements but measurable outcomes." },
    ],
  },

  readme: {
    label: "Developer project / README",
    description: "GitHub README, open source proposal, developer tool brief",
    roleHints: {
      assumption:      "This is a developer project or README. Challenge whether the problem being solved is real and widespread enough to attract users, whether the technical approach is actually simpler than alternatives, and whether 'developers' as a target audience is specific enough to be useful.",
      execution:       "This is a developer project or README. Focus on adoption friction, onboarding complexity, maintenance sustainability, and whether a solo maintainer can realistically support this project as it grows.",
      competitive:     "This is a developer project or README. You are the maintainer of the most established competing open-source project or the product manager of the incumbent SaaS tool. Argue why developers will stick with what they have.",
      firstprinciples: "This is a developer project or README. Challenge whether this should be a library, a CLI tool, a SaaS product, or not built at all — and whether the monetisation path (if any) is coherent with how developers actually adopt tools.",
      evidence:        "This is a developer project or README. Focus on whether pain is evidenced by observable developer behaviour — GitHub issue counts on related projects, Stack Overflow question volume, npm download trends for workaround packages, Reddit threads where developers express this frustration. A developer saying 'this is annoying' in a conversation is not evidence. A thousand Stack Overflow questions about the same problem is.",
    },
    sections: [
      { name: "Problem and use case",             guidance: "The specific developer pain being solved — with a concrete before/after scenario, not a generic description of what the tool does." },
      { name: "Target user",                      guidance: "Which developers, doing what — a 'backend engineer building payment integrations' is a user; 'developers' is not." },
      { name: "Solution overview",                guidance: "How the tool works at the usage level — a realistic example with real input and output, not a description of features." },
      { name: "Differentiation from alternatives", guidance: "Named competing tools, libraries, or approaches with an honest comparison — why would a developer choose this over the established option?" },
      { name: "Architecture / technical approach", guidance: "Key design decisions and constraints — especially anything that affects how the project can be extended or integrated." },
      { name: "Dependencies",                     guidance: "External packages, APIs, and runtime requirements — with versions and a note on stability." },
      { name: "Installation and adoption path",   guidance: "The realistic steps to get from zero to working — including prerequisites, common failure modes, and what a new user experiences in the first 10 minutes." },
      { name: "Maintenance and sustainability",   guidance: "Who maintains this project, at what capacity, and what happens if the author becomes unavailable — especially important for projects others build on." },
      { name: "Contribution model",               guidance: "How the project grows beyond one person — issue triage process, PR conventions, and how contributors are onboarded." },
      { name: "Monetisation path",                guidance: "Whether this is intentionally free, open core, hosted SaaS, or sponsorship-funded — and whether that model is coherent with how the target users adopt tools." },
      { name: "Licence and IP",                   guidance: "The licence and any constraints it places on commercial use — and whether the chosen licence matches the intended adoption model." },
    ],
  },
};

// Validate that a mode string is known; fall back to 'startup'
function resolveMode(raw) {
  return DOC_MODES[raw] ? raw : "startup";
}

// Build the gap analysis system prompt for a given mode
function buildGapPrompt(modeKey) {
  const mode = DOC_MODES[modeKey];
  const sectionList = mode.sections
    .map((s, i) => `${i + 1}. ${s.name} — ${s.guidance}`)
    .join("\n");

  return `You are a strategic document analyst specialising in ${mode.label.toLowerCase()} documents.

Read the submitted document and identify which of the following standard sections are MISSING (not addressed at all) or WEAK (present but superficial, vague, or lacking specifics).

Check for the presence and quality of each section:
${sectionList}

For each section that is MISSING or WEAK, output one JSON object.

CRITICAL: Return ONLY a valid JSON array. Start your entire response with [ and end with ]. No preamble, no explanation, no markdown fences. Just the raw JSON.

Each object must have exactly these four string fields:
- "section_name": the section name exactly as listed above
- "status": either "missing" or "weak"
- "why_it_matters": one sentence explaining why adversarial analysts need this section for this specific document type
- "draft": a specific, concrete proposed draft written using details already present in the submitted document — not a generic template. If the document has no relevant details, write a realistic placeholder that fits the apparent context.

If all sections are adequately covered, return an empty array: []`;
}

const SUMMARY_SYSTEM = `You are a document synthesiser. You have received two inputs:
1. An original strategic document submitted by a user.
2. Additional sections the user accepted or edited to fill identified gaps.

Synthesise both inputs into a single coherent document summary of 400–600 words.

Rules:
- Write in third person, present tense
- Be specific: preserve all names, numbers, prices, and concrete details from either input
- Do not add any information not present in either input
- Do not evaluate or editorialize — this is a neutral synthesis, not a critique
- Structure naturally: problem, solution, customers, market, competition, go-to-market, financials, team, risks, metrics (only sections present in the inputs)
- Omit sections absent from both inputs rather than inventing content
- Write in clear, precise prose — no bullet points, no markdown headers

This summary will be passed directly to an adversarial analysis panel. Completeness and factual accuracy matter more than style.`;

// Build role definitions — core prompts are constant; mode-specific hints prepended.
// To switch a role to a different AI provider, change its `caller` field.
// The provider functions are defined above with step-by-step activation instructions.
function buildRoles(modeKey) {
  const hints = DOC_MODES[modeKey]?.roleHints ?? DOC_MODES.startup.roleHints;
  return [
    {
      id: "assumption", label: "A", name: "Assumption Archaeologist", color: "#6B9FE4",
      caller: callClaude,   // Step 6: swap to callOpenAI / callGemini / callMistral
      system: `${hints.assumption}

You are a rigorous adversarial analyst. Your only job is to identify and attack the assumptions embedded in the document you are given. Do not offer balance. Do not suggest mitigations. Do not acknowledge the plan's strengths. Argue as a committed, intelligent opponent.

1. List every assumption the document depends on — explicit and implicit. Include assumptions the author likely did not consciously make.
2. For each major assumption rate it: (a) how load-bearing is it if wrong (1–5), (b) how empirically supported is it (1–5, where 5 = unsupported).
3. Focus your attack on assumptions that are simultaneously load-bearing AND unsupported (highest combined score).
4. For your three strongest targets write a specific argument for why each is likely wrong.
5. ALTERNATIVES: For each of your three main objections propose one concrete alternative approach the plan could adopt instead. Be specific.

Do not soften. Do not hedge. Argue to win. Then propose alternatives.`,
    },
    {
      id: "execution", label: "B", name: "Execution Sceptic", color: "#E47B6B",
      caller: callOpenAI,   // GPT-4o — sharper on operational failure modes
      system: `${hints.execution}

You are a seasoned operator who has seen many promising strategies fail in execution. Assume the strategy in this document is logically sound — the market opportunity is real, the problem exists, the solution is correct in principle — then argue specifically that this plan will fail in execution.

CRITICAL INSTRUCTION: Do not use numbered headers or generic categories like "Team and Capability Gaps," "Resource Realism," or "Timeline Optimism." These produce boilerplate that applies to every plan. Instead:

Begin with the SINGLE MOST SPECIFIC FIRST POINT OF FAILURE for this exact plan — the precise moment, component, technical dependency, or decision where this specific implementation will break first. Name the exact mechanism. "Developers won't adopt it" is not acceptable. "The HTTP_PROXY environment variable is silently ignored by gRPC clients, which breaks the core value proposition on the first enterprise polyglot stack it encounters" is acceptable.

Then cover only the execution problems that are genuinely specific to this plan:
- Which specific technical dependency is most likely to fail, and exactly how?
- What does this specific plan require that the described team demonstrably cannot do, and what is the evidence for that gap?
- Where does the path to first paying customers break down for this specific product in this specific market — not generically, but at which exact step and why?
- What would the first negative review say, written by a developer who tried it and gave up?

ALTERNATIVES: For each specific failure mode, propose a concrete alternative that addresses it. Compare on cost, complexity, and risk. Be specific enough that a developer could implement the alternative tomorrow.

Generic advice — "hire specialists," "extend your timeline," "build community" — is not acceptable unless tied to a specific failure mode unique to this plan.`,
    },
    {
      id: "competitive", label: "C", name: "Competitive Threat Modeller", color: "#E4AD6B",
      caller: callGemini,   // Gemini flash — strong on market and competitive landscape
      system: `${hints.competitive}

Write an internal memo to your CEO about the threat this document represents.

Structure your memo as:
1. THREAT ASSESSMENT: Why this new entrant or initiative concerns you and what they could do well
2. RESPONSE STRATEGY: Specific actions your organisation takes, in what order, and why
3. WHY YOU WIN: Your specific advantages this plan cannot overcome
4. WHERE THEY COULD BEAT YOU: The one scenario where they succeed despite your response — be honest and specific

Then add:
5. ALTERNATIVES FOR THE NEW ENTRANT: Based on your analysis, propose 2–3 positioning strategies they could adopt that would be harder for you to neutralise. Rank by how much they concern you.

Write as a real strategist protecting your position. Be specific about who you are.`,
    },
    {
      id: "firstprinciples", label: "D", name: "First Principles Challenger", color: "#7BE4B8",
      caller: callMistral,  // Mistral large — different training emphasis adds divergence
      system: `${hints.firstprinciples}

You do not accept premises — you test them. Challenge the fundamental premises of this plan from first principles.

Ask and answer aggressively:
1. Is the problem real? What actual evidence exists that the target user experiences this acutely enough to act?
2. Is this the right solution? Name at least four simpler alternatives and argue why this approach wins or loses against each.
3. Is the target user correctly identified? Who actually has this problem most severely?
4. Does the approach match the problem — is the scope, pricing, or architecture right for this use case?
5. What conditions must hold simultaneously for this to work? List them, then argue most are unlikely to hold.

CRITICAL INSTRUCTION ON THE "VITAMIN VS PAINKILLER" QUESTION: If you conclude this plan addresses a vitamin rather than a painkiller, you must specify which of these three distinct failure modes applies — they require completely different remedies and must not be conflated:

(A) WRONG SOLUTION TO A REAL PROBLEM — The pain is genuine and acute, but this approach does not solve it well enough for users to change behaviour. The fix is a different solution architecture, not a different customer.

(B) RIGHT SOLUTION, WRONG CUSTOMER SEGMENT — The solution works, but the plan targets users who experience the pain too mildly or too infrequently to pay. A different customer segment experiences this as a painkiller. Name that segment specifically.

(C) GENUINE VITAMIN — The problem is real but not acute enough in any segment to drive consistent purchasing behaviour. The market itself is the problem. No repositioning saves this.

Stating "this is a vitamin not a painkiller" without specifying which type is not acceptable. The diagnosis must be actionable.

ALTERNATIVES: Describe the version of this that you would actually back — what needs to change about the user, solution, approach, and go-to-market or adoption path. Be specific enough that someone could act on it immediately.`,
    },
    {
      id: "evidence", label: "E", name: "Evidence Archaeologist", color: "#E46B9F",
      caller: callClaude,   // Claude — strong at structured research methodology
      system: `${hints.evidence}

You are a research methodologist and evidence sceptic. Your job is to assess the empirical foundations of this plan and return a structured validation strategy based entirely on observable public signals — no interviews, no surveys, no focus groups.

Interviews are excluded because: small samples are statistically meaningless, respondents describe problems they think they have rather than problems that cost them money, and people are systematically helpful to anyone who asks — meaning interview data confirms whatever framing the founder brought in.

## 1. Evidence audit
Rate the quality of evidence currently in the document:
- STRONG: cites specific numbers, named sources, observable behaviour (revenue, downloads, reviews, search volume, forum posts)
- CIRCUMSTANTIAL: plausible but not directly observed (analogous markets, adjacent data, second-hand reports)
- ASSERTION: stated as fact without citation ("founders struggle with X", "the market needs Y")

List each claim in the document and rate it. Be specific about which claims are load-bearing and currently unsubstantiated.

## 2. Validation strategy — specific actionable searches only
For each major unsubstantiated claim, provide the exact research action that would confirm or deny it. Use only these methods:

**Complaint mining:**
- Reddit: exact search queries using site:reddit.com with specific subreddits and "I wish" / "why is there no" / "frustrated with" / "anyone else"
- App Store / G2 / Trustpilot / Capterra reviews of named competitors — specific search terms to use
- Twitter/X search operators for complaints about the problem domain
- Hacker News: exact search at hn.algolia.com

**Search demand signals:**
- Google Trends: specific search terms to compare, expected trajectory if the problem is real
- Keyword research: specific phrases to check volume for (problem-description language, not solution language)
- Google autocomplete: specific starter phrases that reveal how people articulate the pain

**Workaround archaeology:**
- GitHub: specific search queries for repos, Gists, or issues that represent the workaround people use today
- npm / PyPI / crates.io: packages people built to solve adjacent problems
- Forum threads where people ask "how do you handle X without Y" — specific communities to check

**Proxy demand signals:**
- Job postings: specific job titles or skill requirements that would be unnecessary if this product existed
- Template sharing: Notion templates, Airtable bases, Google Sheets shared publicly that solve this manually

## 3. Strongest single validation signal
Name the one observable signal that would, if found at scale, most convincingly confirm the problem exists. Explain specifically what threshold would constitute confirmation versus noise.

## 4. Falsification test
Name the one observable signal that, if absent, would most strongly suggest the problem is not real or not acute enough to pay for. Where exactly would you look for this signal?`,
    },
  ];
}

const SYNTHESIS_SYSTEM = `You are a meta-analyst. You have received adversarial analyses from five specialist roles examining the same plan. Each role has also proposed alternatives or validation actions.

Return ONLY a valid JSON object — no preamble, no explanation, no markdown fences. Start with { and end with }.

The JSON must have exactly these seven fields:

{
  "high_confidence_objections": [
    {
      "objection": "One sentence stating the objection concretely",
      "roles": ["A"],
      "severity": "critical",
      "category": "assumption",
      "recommended_action": "Specific concrete next step — never suggest customer interviews or surveys"
    }
  ],
  "unique_objections": [
    {
      "objection": "One sentence",
      "role": "B",
      "why_notable": "Why this deserves attention despite one source"
    }
  ],
  "contradictions": [
    {
      "summary": "One sentence describing what the roles disagree about",
      "role_a": "A",
      "role_a_claim": "What Role A argues",
      "role_b": "C",
      "role_b_claim": "What Role C argues (opposing)"
    }
  ],
  "alternatives": [
    {
      "name": "Short name for this alternative",
      "proposed_by": ["A", "D"],
      "problem_solved": "What this addresses",
      "tradeoff": "What is given up",
      "type": "strategic"
    }
  ],
  "validation_actions": [
    {
      "claim": "The specific unvalidated claim this addresses",
      "method": "complaint-mining | search-demand | workaround-archaeology | proxy-signal",
      "action": "Exact search query, subreddit, platform, or data source to check — specific enough to execute in under 5 minutes",
      "confirms_if": "What finding would confirm the claim",
      "denies_if": "What absence or finding would suggest the claim is wrong"
    }
  ],
  "verdict": "3-4 sentences: overall assessment, most important risk, why multi-role found more than single-prompt would",
  "next_action": "The single most important concrete action this week. Must be specific and immediately executable. NEVER recommend customer interviews, user interviews, surveys, or focus groups — these produce biased confirmatory data. Instead recommend: mining specific complaint sources (named subreddits, competitor reviews on named platforms), checking specific search volume or Google Trends terms, finding workaround evidence on GitHub or forums, or a specific product/pricing/positioning change."
}

Field rules:
- severity: "critical" | "significant" | "minor"
- category: "assumption" | "execution" | "competitive" | "first-principles" | "evidence"
- type: "cosmetic" | "strategic" | "pivot"
- high_confidence_objections: only objections raised by 2+ roles (A, B, C, D, E)
- unique_objections: only objections raised by exactly 1 role that are specific and non-generic
- validation_actions: consolidate the specific validation searches from Role E with any evidence gaps identified by other roles. Include 3–5 actions maximum, prioritised by how load-bearing the unvalidated claim is. Each action must be executable in under 5 minutes with a browser.
- alternatives: all concrete alternatives proposed across all five roles, deduplicated and grouped
- next_action: never interviews, never surveys, never focus groups — always an observable public signal or a concrete product change

Be precise. No filler.`;


// ── POST /api/gap-analyse ────────────────────────────────────────────────────

app.post("/api/gap-analyse", async (req, res) => {
  const { document, mode: rawMode } = req.body;
  const mode = resolveMode(rawMode);

  if (!document || document.trim().length < 50)
    return res.status(400).json({ error: "Document too short — minimum 50 characters." });
  if (document.length > 60000)
    return res.status(400).json({ error: "Document too long — maximum ~12,000 words." });

  try {
    const raw = await callClaude(buildGapPrompt(mode), document, 3000);
    const clean = raw.replace(/```(?:json)?\n?/g, "").replace(/\n?```/g, "").trim();
    let gaps;
    try {
      gaps = JSON.parse(clean);
      if (!Array.isArray(gaps)) gaps = [];
    } catch {
      gaps = [];
    }
    res.json({ gaps, mode });
  } catch (err) {
    logError("gap-analyse", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/analyse  (SSE) ─────────────────────────────────────────────────

app.post("/api/analyse", async (req, res) => {
  const { original, acceptedSections, mode: rawMode } = req.body;
  const mode  = resolveMode(rawMode);
  const ROLES = buildRoles(mode);

  if (!original || original.trim().length < 50)
    return res.status(400).json({ error: "Document too short." });

  // Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // ── Call 1: Summary ────────────────────────────────────────────────────────
  send("stage", { stage: "summary" });

  let enriched;
  try {
    const additionsText =
      acceptedSections && acceptedSections.length > 0
        ? acceptedSections
            .map(s => `### ${s.section_name}\n${s.content}`)
            .join("\n\n")
        : "No additional sections were added.";

    enriched = await callClaude(
      SUMMARY_SYSTEM,
      `ORIGINAL DOCUMENT:\n${original}\n\nACCEPTED ADDITIONS:\n${additionsText}`,
      1200
    );
    // Send the enriched summary text to the browser so it can be shown/saved
    // before the adversarial panel starts. Also send the accepted sections so
    // the UI can clearly mark which parts were AI-suggested.
    send("summary_ready", {
      text: enriched,
      acceptedSections: acceptedSections ?? [],
    });
  } catch (err) {
    logError("analyse/summary", err);
    send("error", { message: "Summary call failed: " + err.message });
    res.end();
    return;
  }

  // ── Calls 2–5: Parallel adversarial roles ─────────────────────────────────
  const roleOutputs = {};

  await Promise.all(
    ROLES.map(async role => {
      send("role_start", { id: role.id, label: role.label, name: role.name });

      // Use Anthropic streaming when the role uses Claude (tokens flow to client in real-time).
      // Fall back to standard (non-streaming) call for third-party providers.
      const isClaudeCaller = !role.caller || role.caller === callClaude;

      const runCall = async (streaming) => {
        if (streaming) return streamRoleClaude(role.system, enriched, 1500, send, role.id);
        return (role.caller ?? callClaude)(role.system, enriched, 1500);
      };

      try {
        const output = await runCall(isClaudeCaller);
        roleOutputs[role.id] = output;
        // Always send full output so frontend can do a final markdown render
        send("role_complete", { id: role.id, label: role.label, name: role.name, output, fallback: false });
      } catch (primaryErr) {
        const callerName = role.caller?.name ?? "callClaude";
        logError(`analyse/role-${role.id} [${callerName}]`, primaryErr);
        if (role.caller && role.caller !== callClaude) {
          send("role_retry", { id: role.id, label: role.label, name: role.name, error: primaryErr.message });
          try {
            const output = await runCall(true); // fallback always streams
            roleOutputs[role.id] = output;
            console.log(`[${new Date().toISOString()}] FALLBACK [analyse/role-${role.id}] ${callerName} → callClaude succeeded`);
            send("role_complete", { id: role.id, label: role.label, name: role.name, output, fallback: true });
            return;
          } catch (fallbackErr) {
            logError(`analyse/role-${role.id} [claude-fallback]`, fallbackErr);
          }
        }
        roleOutputs[role.id] = null;
        send("role_error", { id: role.id, label: role.label, name: role.name, error: primaryErr.message });
      }
    })
  );

  const validRoles = ROLES.filter(r => roleOutputs[r.id]);
  if (validRoles.length < 2) {
    send("error", { message: "Too many role failures. Check your API key and try again." });
    res.end();
    return;
  }

  // ── Call 7: Synthesis ──────────────────────────────────────────────────────
  send("synthesis_start", { count: validRoles.length });

  const synthInput = validRoles
    .map(r => `=== ${r.name.toUpperCase()} (Role ${r.label}) ===\n${roleOutputs[r.id]}`)
    .join("\n\n---\n\n");

  try {
    const raw      = await callClaude(SYNTHESIS_SYSTEM, synthInput, 3000);
    const parsed   = parseSynthesis(raw);
    send("synthesis_complete", parsed);
  } catch (err) {
    logError("analyse/synthesis", err);
    send("synthesis_error", { error: err.message });
  }

  send("done", {
    rolesCompleted: validRoles.length,
    rolesFailed: ROLES.length - validRoles.length,
  });

  res.end();
});

// ── POST /api/detect-mode ─────────────────────────────────────────────────────
// Takes the first ~200 words of a document, returns the most likely mode key.

const DETECT_SYSTEM = `You are a document classifier. Read the text and classify it as one of these five types:
- startup   (business plan, pitch deck, investor memo, startup proposal)
- decision  (decision brief, options analysis, recommendation memo)
- technical (PRD, architecture doc, engineering spec, technical proposal)
- strategy  (annual plan, OKR doc, operational strategy, corporate strategy)
- readme    (GitHub README, open source project, developer tool brief)

Return ONLY the single lowercase word — one of: startup, decision, technical, strategy, readme
No explanation. No punctuation. Just the word.`;

app.post("/api/detect-mode", async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 30) return res.json({ mode: "startup" });
  const preview = text.trim().split(/\s+/).slice(0, 200).join(" ");
  try {
    const raw  = await callClaude(DETECT_SYSTEM, preview, 10);
    const mode = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
    const valid = ["startup","decision","technical","strategy","readme"];
    res.json({ mode: valid.includes(mode) ? mode : "startup" });
  } catch (err) {
    logError("detect-mode", err);
    res.json({ mode: "startup" }); // fail silently — never block the user
  }
});

// ── POST /api/export-pdf ──────────────────────────────────────────────────────

app.post("/api/export-pdf", async (req, res) => {
  const { mode, modeName, date, roleOutputs: ro, synthesis } = req.body;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="dissent-analysis-${Date.now()}.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  const COL    = { purple: "#534AB7", text: "#1A1A1A", mid: "#444", light: "#888", rule: "#E0DFF8" };
  const W      = doc.page.width - 100; // content width

  const rule   = () => doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(COL.rule).lineWidth(0.5).stroke().moveDown(0.5);
  const h1     = (t) => { doc.font("Helvetica-Bold").fontSize(18).fillColor(COL.purple).text(t).moveDown(0.3); rule(); };
  const h2     = (t) => doc.font("Helvetica-Bold").fontSize(12).fillColor(COL.text).text(t).moveDown(0.2);
  const body   = (t) => doc.font("Helvetica").fontSize(10).fillColor(COL.mid).text(t, { lineGap: 3 }).moveDown(0.4);
  const label  = (t) => doc.font("Helvetica-Bold").fontSize(9).fillColor(COL.light).text(t.toUpperCase(), { characterSpacing: 0.5 }).moveDown(0.1);

  // ── Cover ──────────────────────────────────────────────────────────────────
  doc.rect(50, 50, W, 80).fill(COL.purple);
  doc.font("Helvetica-Bold").fontSize(28).fillColor("white").text("DISSENT", 70, 68);
  doc.font("Helvetica").fontSize(12).fillColor("#CCCAF4").text("Adversarial Analysis Report", 70, 104);
  doc.moveDown(4);
  label("Document type"); body(modeName ?? mode);
  label("Date"); body(new Date(date ?? Date.now()).toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" }));

  // ── Role outputs ───────────────────────────────────────────────────────────
  const ROLE_META_PDF = [
    { id:"assumption",      label:"A", name:"Assumption Archaeologist" },
    { id:"execution",       label:"B", name:"Execution Sceptic" },
    { id:"competitive",     label:"C", name:"Competitive Threat Modeller" },
    { id:"firstprinciples", label:"D", name:"First Principles Challenger" },
    { id:"evidence",        label:"E", name:"Evidence Archaeologist" },
  ];

  for (const r of ROLE_META_PDF) {
    const output = ro?.[r.id];
    if (!output) continue;
    doc.addPage();
    h1(`Role ${r.label} — ${r.name}`);
    // Strip markdown for PDF
    const plain = output.replace(/^#{1,4} /gm,"").replace(/\*\*(.+?)\*\*/g,"$1").replace(/\*(.+?)\*/g,"$1").replace(/^---$/gm,"");
    body(plain);
  }

  // ── Synthesis ──────────────────────────────────────────────────────────────
  doc.addPage();
  h1("Synthesis — Meta-Analysis");

  if (synthesis?.structured && synthesis?.data) {
    const s = synthesis.data;

    // ASCII-only severity labels — pdfkit's built-in Helvetica is Latin-1;
    // Unicode bullets/diamonds render as garbage (%i, %o etc.)
    const SEV_LABEL = { critical:"[!!!] CRITICAL", significant:"[!] SIGNIFICANT", minor:"[ ] MINOR" };
    const SEV_COL   = { critical:"#E05A4A", significant:"#BA7517", minor:COL.light };

    if (s.high_confidence_objections?.length) {
      h2("High-confidence objections");
      s.high_confidence_objections.forEach(o => {
        const sevText  = SEV_LABEL[o.severity] ?? o.severity.toUpperCase();
        const catText  = `   ${(o.category ?? "").toUpperCase()}   Roles: ${(o.roles ?? []).join(", ")}`;
        doc.font("Helvetica-Bold").fontSize(9)
           .fillColor(SEV_COL[o.severity] ?? COL.light)
           .text(sevText, { continued: true });
        doc.font("Helvetica").fontSize(9)
           .fillColor(COL.light)
           .text(catText);
        doc.font("Helvetica").fontSize(10).fillColor(COL.text).text(o.objection ?? "", { lineGap: 2 });
        doc.font("Helvetica").fontSize(9).fillColor(COL.mid)
           .text(`-> ${o.recommended_action ?? ""}`, { lineGap: 2 }).moveDown(0.5);
      });
    }

    if (s.unique_objections?.length) {
      doc.moveDown(0.5); h2("Unique objections");
      s.unique_objections.forEach(o => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COL.light).text(`Role ${o.role ?? ""}`);
        body(`${o.objection ?? ""}\nWhy notable: ${o.why_notable ?? ""}`);
      });
    }

    if (s.contradictions?.length) {
      doc.moveDown(0.5); h2("Contradictions");
      s.contradictions.forEach(c => {
        doc.font("Helvetica-Bold").fontSize(10).fillColor(COL.text).text(c.summary ?? "").moveDown(0.2);
        body(`Role ${c.role_a ?? ""}: ${c.role_a_claim ?? ""}\nRole ${c.role_b ?? ""}: ${c.role_b_claim ?? ""}`);
      });
    }

    if (s.alternatives?.length) {
      doc.moveDown(0.5); h2("Alternatives");
      s.alternatives.forEach(a => {
        doc.font("Helvetica-Bold").fontSize(10).fillColor(COL.text)
           .text(`${a.name ?? ""}  `, { continued: true });
        doc.font("Helvetica").fontSize(9).fillColor(COL.light)
           .text(`[${a.type ?? ""}]  Proposed by: ${(a.proposed_by ?? []).join(", ")}`);
        body(`Solves: ${a.problem_solved ?? ""}\nTrade-off: ${a.tradeoff ?? ""}`);
      });
    }

    if (s.validation_actions?.length) {
      doc.moveDown(0.5); h2("Validation strategy");
      s.validation_actions.forEach((v, i) => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#E46B9F")
           .text(`${i + 1}. [${(v.method ?? "").replace(/-/g, " ").toUpperCase()}]`, { continued: true });
        doc.font("Helvetica").fontSize(9).fillColor(COL.light)
           .text(`  ${v.claim ?? ""}`);
        doc.font("Helvetica").fontSize(9).fillColor(COL.mid)
           .text(`Action: ${v.action ?? ""}`, { lineGap: 2 });
        doc.font("Helvetica").fontSize(8).fillColor("#4ABA7A")
           .text(`Confirms if: ${v.confirms_if ?? ""}`, { lineGap: 1 });
        doc.font("Helvetica").fontSize(8).fillColor("#E05A4A")
           .text(`Denies if:   ${v.denies_if ?? ""}`, { lineGap: 1 }).moveDown(0.5);
      });
    }

    if (s.verdict) {
      doc.moveDown(0.5); h2("Verdict");
      body(s.verdict);
    }
    if (s.next_action) {
      h2("Recommended next action");
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COL.purple)
         .text(s.next_action, { lineGap: 3 });
    }
  } else {
    // prose fallback
    body(typeof synthesis?.data === "string" ? synthesis.data : "No synthesis available.");
  }

  doc.end();
});



app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    node: process.version,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const key  = k => process.env[k] ? "present ✓" : "missing  ✗";
  console.log(`\n  Dissent running at http://localhost:${PORT}`);
  console.log(`  ANTHROPIC_API_KEY  ${key("ANTHROPIC_API_KEY")}  (Role A + summary + synthesis)`);
  console.log(`  OPENAI_API_KEY     ${key("OPENAI_API_KEY")}  (Role B — Execution Sceptic)`);
  console.log(`  GOOGLE_API_KEY     ${key("GOOGLE_API_KEY")}  (Role C — Competitive Threat)`);
  console.log(`  MISTRAL_API_KEY    ${key("MISTRAL_API_KEY")}  (Role D — First Principles)`);
  console.log(`  Missing keys fall back to Claude automatically.\n`);
});
