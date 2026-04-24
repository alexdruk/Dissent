import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { Mistral } from "@mistralai/mistralai";

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


// Each function has the same signature: (system, user, maxTokens) → string.
// To activate a provider:
//   1. Run:  npm install <package>   (package names shown below each block)
//   2. Add the matching key to your .env file (key names shown below)
//   3. Uncomment the import line at the top of this file
//   4. Uncomment the client initialisation line in this section
//   5. Uncomment the function body
//   6. In buildRoles() below, change the `caller` field for the desired role
//
// Recommended assignment for maximum analytical divergence:
//   Role A (Assumption Archaeologist)  → callClaude   (default)
//   Role B (Execution Sceptic)         → callOpenAI   — GPT-4o is sharper on ops critique
//   Role C (Competitive Threat)        → callGemini   — strong on market/competitive landscape
//   Role D (First Principles)          → callMistral  — different training emphasis adds divergence

// ── OpenAI / GPT-4o ───────────────────────────────────────────────────────────
// npm install openai
// .env:  OPENAI_API_KEY=sk-...
//
// Step 3 — add this import at the top of the file (near the other imports):
//   import OpenAI from "openai";
//
// Step 4 — uncomment the next line:
	 const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//
async function callOpenAI(system, user, maxTokens = 1500) {
  // Step 5 — uncomment the block below:
   const r = await openai.chat.completions.create({
     model: "gpt-4o",
     max_tokens: maxTokens,
     messages: [
       { role: "system", content: system },
       { role: "user",   content: user   },
     ],
   });
   return r.choices[0].message.content ?? "";
  throw new Error("OpenAI not configured — see comments in server.js to activate.");
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
// npm install @google/genai
// .env:  GOOGLE_API_KEY=AIza...
//
// Step 3 — add this import at the top of the file:
//   import { GoogleGenAI } from "@google/genai";
//
// Step 4 — uncomment the next line:
	 const gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
//
async function callGemini(system, user, maxTokens = 1500) {
  // Step 5 — uncomment the block below:
   const r = await gemini.models.generateContent({
     model: "gemini-2.0-flash",
     config: { maxOutputTokens: maxTokens, systemInstruction: system },
     contents: user,
   });
   return r.text ?? "";
  throw new Error("Gemini not configured — see comments in server.js to activate.");
}

// ── Mistral ───────────────────────────────────────────────────────────────────
// npm install @mistralai/mistralai
// .env:  MISTRAL_API_KEY=...
//
// Step 3 — add this import at the top of the file:
//   import { Mistral } from "@mistralai/mistralai";
//
// Step 4 — uncomment the next line:
	 const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
//
async function callMistral(system, user, maxTokens = 1500) {
  // Step 5 — uncomment the block below:
   const r = await mistral.chat.complete({
     model: "mistral-large-latest",
     maxTokens,
     messages: [
       { role: "system", content: system },
       { role: "user",   content: user   },
     ],
   });
   return r.choices?.[0]?.message?.content ?? "";
  throw new Error("Mistral not configured — see comments in server.js to activate.");
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
    },
    sections: [
      { name: "Executive summary",              guidance: "A tight decision-oriented overview: what is being built, for whom, why now, and what is being asked — often written last but read first." },
      { name: "Problem statement",              guidance: "Clearly defined with evidence of real pain — not a generic observation but a specific description of who suffers, how often, and how acutely." },
      { name: "Solution / product description", guidance: "How the product actually works, not just what problem it solves — the mechanism, the workflow, the key differentiating feature." },
      { name: "Key assumptions",                guidance: "The critical beliefs the plan depends on, stated explicitly: market size, conversion rates, pricing tolerance, competitive response, hiring timeline." },
      { name: "Target customer",                guidance: "Specific persona with pain level and willingness to pay — 'SMBs' is not a customer; a named archetype with a job title and a specific workflow problem is." },
      { name: "Market sizing",                  guidance: "TAM/SAM/SOM with methodology — bottom-up preferred; top-down accepted only with a credible source and a realistic penetration argument." },
      { name: "Competitor analysis",            guidance: "Named competitors with URLs, feature comparison, and a clear positioning argument for why this product wins on a specific dimension." },
      { name: "Go-to-market strategy",          guidance: "Specific channels, tactics, and a 90-day timeline to first 10 paying customers — not 'content marketing and SEO' but named communities, outreach templates, and a sequenced plan." },
      { name: "Business model and pricing",     guidance: "Revenue model, unit economics, and pricing rationale — COGS per transaction, gross margin, and why the price point fits the customer's pain level." },
      { name: "Financial projections",          guidance: "Monthly forecasts for Year 1, annual for Years 2–3, with cost structure and break-even month explicitly stated." },
      { name: "Sensitivity analysis",           guidance: "What happens if 2–3 key assumptions fail simultaneously — the downside case with specific numbers, not qualitative hedging." },
      { name: "Funding requirements & use of funds", guidance: "How much capital is needed, over what period, allocated to which specific categories — hiring, infrastructure, marketing, runway." },
      { name: "Team and execution plan",        guidance: "Who is building this and why they are credible for this specific problem — relevant prior experience, not just titles." },
      { name: "Risk assessment",                guidance: "Specific risks with named mitigations: technical, market, competitive, operational, financial — not generic categories but named failure modes." },
      { name: "Traction / proof points",        guidance: "Early users, pilots, letters of intent, revenue, or waitlist — any evidence that demand exists beyond the founder's conviction." },
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
    },
    sections: [
      { name: "Problem / opportunity statement",  guidance: "What specific situation requires a decision — with evidence of urgency and the cost of not deciding." },
      { name: "Decision context and constraints",  guidance: "What is in scope vs out of scope; what constraints (budget, time, regulatory) bound the options." },
      { name: "Key assumptions",                   guidance: "Critical beliefs underpinning the recommendation — if any of these are wrong, the decision changes." },
      { name: "Options considered",                guidance: "At least three options including a 'do nothing' baseline — each described fairly, not set up as strawmen." },
      { name: "Decision criteria",                 guidance: "How options are evaluated — named criteria with relative weights, not an unranked list." },
      { name: "Recommendation",                    guidance: "A clear, opinionated conclusion — not 'it depends' but a specific choice with a rationale." },
      { name: "Trade-offs",                        guidance: "What is explicitly being given up by choosing this option over the alternatives." },
      { name: "Implementation plan",               guidance: "Concrete steps, owners, and a timeline — what happens in the first 30 days if this decision is approved." },
      { name: "Risk assessment",                   guidance: "Specific risks of the recommended option with mitigations — not generic concerns but named failure modes." },
      { name: "Decision timeline / urgency",       guidance: "Why this decision needs to be made now — the cost of delay and the window that closes if action is deferred." },
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
    },
    sections: [
      { name: "Problem and use case",           guidance: "The specific user problem being solved, with a concrete usage scenario — not a technical description of what is being built." },
      { name: "Solution overview",              guidance: "How the product works at the user-facing level, distinct from the technical implementation." },
      { name: "Architecture / technical approach", guidance: "Systems, stack, integrations, and key design decisions — with explicit rationale for choices made." },
      { name: "Key assumptions",                guidance: "Technical beliefs the design depends on: latency requirements, data volumes, API reliability, browser/device constraints." },
      { name: "Target user",                    guidance: "Who specifically uses this and in what context — 'developers' is not a user; a specific role with a specific workflow is." },
      { name: "Development roadmap",            guidance: "Phases with milestones and feature sequencing — what ships in v1, what is deferred and why." },
      { name: "Dependencies",                   guidance: "External APIs, third-party services, data sources, and regulatory approvals the system relies on — with a risk rating for each." },
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
    },
    sections: [
      { name: "Executive summary",              guidance: "The core strategic argument in one page — what is being decided, why, and what it requires." },
      { name: "Strategic context",              guidance: "The market, competitive, and internal conditions that make this strategy necessary now." },
      { name: "Vision and objectives",          guidance: "Where the organisation is going and what it must achieve — specific enough to evaluate whether the strategy achieves it." },
      { name: "Key assumptions",                guidance: "Market and competitive beliefs the strategy depends on — explicitly stated so they can be monitored and revisited." },
      { name: "Strategic initiatives",          guidance: "The specific programmes or investments that execute the strategy — named, scoped, and sequenced." },
      { name: "Resource plan",                  guidance: "Budget and headcount allocation across initiatives — not just totals but the split between competing priorities." },
      { name: "Operational plan",               guidance: "How the strategy translates into day-to-day operations — processes, workflows, and accountabilities." },
      { name: "Timeline and milestones",        guidance: "A concrete schedule with quarterly checkpoints and named owners for each." },
      { name: "Dependencies and partnerships",  guidance: "External organisations or internal teams the strategy depends on — with a risk assessment for each." },
      { name: "Risk assessment",                guidance: "Strategic, operational, and market risks with specific mitigations and a named owner for each." },
      { name: "Competitor analysis",            guidance: "How the competitive landscape is expected to evolve and how the strategy positions the organisation against it." },
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
    },
    sections: [
      { name: "Problem and use case",             guidance: "The specific developer pain being solved — with a concrete before/after scenario, not a generic description of what the tool does." },
      { name: "Target user",                      guidance: "Which developers, doing what — a 'backend engineer building payment integrations' is a user; 'developers' is not." },
      { name: "Solution overview",                guidance: "How the tool works at the usage level — a realistic example with real input and output, not a description of features." },
      { name: "Differentiation from alternatives", guidance: "Named competing tools, libraries, or approaches with an honest comparison — why would a developer choose this over the established option?" },
      { name: "Installation and adoption path",   guidance: "The realistic steps to get from zero to working — including prerequisites, common failure modes, and what a new user experiences in the first 10 minutes." },
      { name: "Architecture / technical approach", guidance: "Key design decisions and constraints — especially anything that affects how the project can be extended or integrated." },
      { name: "Dependencies",                     guidance: "External packages, APIs, and runtime requirements — with versions and a note on stability." },
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
//      caller: callClaude,   // Recommended: swap to callOpenAI for GPT-4o ops critique
	  callOpenAI,
      system: `${hints.execution}

You are a seasoned operator who has seen many promising strategies fail in execution. Assume the strategy in this document is logically sound — the market opportunity is real, the problem exists, the solution is correct in principle — then argue specifically that this plan will fail in execution.

Focus on:
- Team and capability gaps: what skills does this plan require that the team likely lacks
- Resource realism: what does this actually cost in time and money versus what is described
- Timeline optimism: where is the plan unrealistic about how long things take
- Path to first 10 paying customers (or equivalent adoption milestone): why it is harder than described
- The specific first point of failure described concretely
- Technical or operational risks specific to this implementation

ALTERNATIVES: For each major execution problem propose a concrete alternative that avoids or mitigates it. Compare to the current approach on cost, complexity, and risk.

Be specific. "Execution is hard" is not acceptable. Name the specific problems this specific plan will face.`,
    },
    {
      id: "competitive", label: "C", name: "Competitive Threat Modeller", color: "#E4AD6B",
//      caller: callClaude,   // Recommended: swap to callGemini for competitive landscape
	  caller: callGemini,
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
//      caller: callClaude,   // Recommended: swap to callMistral for different training emphasis
      caller: callMistral,
      system: `${hints.firstprinciples}

You do not accept premises — you test them. Challenge the fundamental premises of this plan from first principles.

Ask and answer aggressively:
1. Is the problem real? What actual evidence exists that the target user experiences this acutely enough to act?
2. Is this the right solution? Name at least four simpler alternatives and argue why this approach wins or loses against each.
3. Is the target user correctly identified? Who actually has this problem most severely?
4. Does the approach match the problem — is the scope, pricing, or architecture right for this use case?
5. What conditions must hold simultaneously for this to work? List them, then argue most are unlikely to hold.

ALTERNATIVES: Describe the version of this that you would actually back — what needs to change about the user, solution, approach, and go-to-market or adoption path. Be specific enough that someone could act on it immediately.`,
    },
  ];
}

const SYNTHESIS_SYSTEM = `You are a meta-analyst. You have received adversarial analyses from four specialist roles examining the same plan. Each role has also proposed alternatives.

Produce exactly five sections:

## 1. High-confidence objections
Objections appearing in 2 or more analyses. List each in one sentence with the roles that raised it.

## 2. Unique objections worth investigating
Objections raised by only one analyst that are specific and non-generic. Include which role raised it and why it deserves attention.

## 3. Contradictions between analysts
Cases where two analysts argue opposing things. Explain what the contradiction reveals about genuine ambiguity in the plan.

## 4. Alternatives comparison
Collect all concrete alternatives proposed across all four roles. Group similar ones. For each group: name it, which roles proposed it, what problem it solves, trade-offs versus the current approach. Rank by how fundamentally they change the plan (cosmetic → strategic → complete pivot).

## 5. Verdict and recommended next action
In 3–4 sentences: does multi-role analysis reveal materially different concerns than a single analyst would find? What is the single most important thing to change or validate? What is the concrete next action this week?

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
      try {
        const output = await (role.caller ?? callClaude)(role.system, enriched, 1500);
        roleOutputs[role.id] = output;
        send("role_complete", { id: role.id, label: role.label, name: role.name, output });
      } catch (primaryErr) {
        // ── Claude fallback ──────────────────────────────────────────────────
        // If the configured provider fails (e.g. OpenAI/Gemini/Mistral key
        // missing or rate-limited), automatically retry with Claude so the
        // session completes rather than losing a role entirely.
        const callerName = role.caller?.name ?? "callClaude";
        logError(`analyse/role-${role.id} [${callerName}]`, primaryErr);
        if (role.caller && role.caller !== callClaude) {
          send("role_retry", {
            id: role.id, label: role.label, name: role.name,
            error: primaryErr.message,
          });
          try {
            const output = await callClaude(role.system, enriched, 1500);
            roleOutputs[role.id] = output;
            const ts = new Date().toISOString();
            console.log(`[${ts}] FALLBACK [analyse/role-${role.id}] ${callerName} failed → retried with callClaude → succeeded`);
            send("role_complete", {
              id: role.id, label: role.label, name: role.name,
              output, fallback: true,
            });
            return;
          } catch (fallbackErr) {
            logError(`analyse/role-${role.id} [claude-fallback]`, fallbackErr);
            // Both providers failed — fall through to role_error below
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

  // ── Call 6: Synthesis ──────────────────────────────────────────────────────
  send("synthesis_start", { count: validRoles.length });

  const synthInput = validRoles
    .map(r => `=== ${r.name.toUpperCase()} (Role ${r.label}) ===\n${roleOutputs[r.id]}`)
    .join("\n\n---\n\n");

  try {
    const synthesis = await callClaude(SYNTHESIS_SYSTEM, synthInput, 2000);
    send("synthesis_complete", { output: synthesis });
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

// ── GET /api/health ───────────────────────────────────────────────────────────

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
  console.log(`\n  Dissent running at http://localhost:${PORT}`);
  console.log(`  Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "present ✓" : "MISSING ✗ — add to .env"}\n`);
});
