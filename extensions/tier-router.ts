/**
 * tier-router.ts
 *
 * Auto-routes each user prompt to a model tier based on intent:
 *
 *   haiku   - retrieval / Q&A / lookup work (cheapest cloud tier)
 *   sonnet  - design, brainstorming, planning, advising (mid) — also the DEFAULT model
 *   opus    - essential work: implementation, refactor, deep debug (most expensive)
 *
 *   local   - OPTIONAL. When a local model (default local-llm/qwen3-30b-a3b) is present
 *             in the model registry, the cheap retrieval tier routes to it instead of
 *             cloud haiku (zero token cost). Auto-detected per machine: boxes without a
 *             local model silently fall back to cloud haiku. No per-machine config needed.
 *
 * Decision precedence (first match wins):
 *   1. Explicit comma prefix:    ",haiku ...", ",sonnet ...", ",opus ..."   (prefix is stripped)
 *      (We use "," not "!" because pi reserves "!" for shell-out: e.g. "!ls" runs ls in bash.)
 *   2. Manual pin:                /route off  ->  stays on whatever model is currently set
 *   3. Skill-command heuristic:   /skill:brainstorming|writing-plans|po-advisor|architecture-advisor -> sonnet
 *                                 /skill:atlassian (read-only verbs) -> haiku
 *   4. User explicitly picked a model via /model or Ctrl+P after route-on -> stays pinned for the session
 *   5. Keyword classifier on the prompt text -> tier
 *   6. Fallback (no classification signal)                          -> sonnet (the default tier; never silently jump to opus)
 *
 * Guard rails:
 *   - If accumulated context > 100K tokens, never downgrade to haiku (context limit).
 *   - Only routes on the *first* turn of each user prompt cycle (subsequent tool-loop turns
 *     keep the model already chosen, so a Sonnet design session does not silently flip to Opus
 *     mid-loop).
 *   - When agent_end fires, "pending decision" is cleared so the next user prompt routes fresh.
 *
 * Commands:
 *   /route          - show current state and last decision
 *   /route off      - disable auto-routing (pin to current model)
 *   /route auto     - re-enable auto-routing
 *   /route haiku    - one-shot: force next turn to haiku (then resumes auto)
 *   /route sonnet   - one-shot: force next turn to sonnet
 *   /route opus     - one-shot: force next turn to opus
 *
 * Tier model IDs (override via env TIER_ROUTER_MODELS as JSON):
 *   { "haiku":  "claude-haiku-4.5",
 *     "sonnet": "claude-sonnet-4.6",
 *     "opus":   "claude-opus-4.7" }
 *
 * Footer/status: shows "route:<tier> (<why>)" via ctx.ui.setStatus.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Tier = "haiku" | "sonnet" | "opus";

interface TierConfig {
	provider: string;
	models: Record<Tier, string>;
}

const DEFAULT_CONFIG: TierConfig = {
	provider: "github-copilot",
	models: {
		haiku: "claude-haiku-4.5",
		sonnet: "claude-sonnet-4.6",
		opus: "claude-opus-4.7",
	},
};

// Thinking level per tier. github-copilot's Claude offerings currently only
// accept "off" or "medium" — anything else returns invalid_reasoning_effort.
// Mapping: retrieval skips thinking entirely; design/essential get the only
// non-zero level available. Override via env
// TIER_ROUTER_THINKING='{"haiku":"off","sonnet":"medium","opus":"medium"}'.
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const DEFAULT_THINKING: Record<Tier, Thinking> = {
	haiku: "off",
	sonnet: "medium",
	opus: "medium",
};
function loadThinking(): Record<Tier, Thinking> {
	const env = process.env.TIER_ROUTER_THINKING;
	if (!env) return DEFAULT_THINKING;
	try {
		return { ...DEFAULT_THINKING, ...JSON.parse(env) };
	} catch {
		return DEFAULT_THINKING;
	}
}

// Optional local model that replaces the cheap (haiku) tier when it is present
// in the model registry. Auto-detected per machine; machines without it fall
// back to cloud haiku. Override/disable via env TIER_ROUTER_LOCAL:
//   TIER_ROUTER_LOCAL='{"provider":"local-llm","model":"qwen3-30b-a3b","thinking":"off"}'
//   TIER_ROUTER_LOCAL=off   -> never route to a local model
interface LocalConfig {
	provider: string;
	model: string;
	thinking: Thinking;
}
const DEFAULT_LOCAL: LocalConfig = { provider: "local-llm", model: "qwen3-30b-a3b", thinking: "off" };
function loadLocal(): LocalConfig | null {
	const env = process.env.TIER_ROUTER_LOCAL;
	if (env && env.trim().toLowerCase() === "off") return null;
	if (!env) return DEFAULT_LOCAL;
	try {
		const p = JSON.parse(env);
		return {
			provider: p.provider ?? DEFAULT_LOCAL.provider,
			model: p.model ?? DEFAULT_LOCAL.model,
			thinking: p.thinking ?? DEFAULT_LOCAL.thinking,
		};
	} catch {
		return DEFAULT_LOCAL;
	}
}

function loadConfig(): TierConfig {
	const env = process.env.TIER_ROUTER_MODELS;
	if (!env) return DEFAULT_CONFIG;
	try {
		const parsed = JSON.parse(env);
		return {
			provider: parsed.provider ?? DEFAULT_CONFIG.provider,
			models: { ...DEFAULT_CONFIG.models, ...parsed.models },
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

// --- classification rules ----------------------------------------------------

// Sonnet: design + brainstorming + advisory work.
const SONNET_SKILL_HINTS = [
	"/skill:brainstorming",
	"/skill:writing-plans",
	"/skill:architecture",
	"/skill:product",
	"/skill:requirements-engineering",
	"/skill:writing-skills",
	// archived aliases, kept for back-compat with old sessions/muscle memory:
	"/skill:po-advisor",
	"/skill:architecture-advisor",
	"/skill:c4-modelling",
];

// Haiku (→ local when available): retrieval-heavy skills. Injecting the skill
// body is what makes small local models reliably one-shot the tool calls, so
// these belong on the cheap tier.
const HAIKU_SKILL_HINTS = [
	"/skill:atlassian",
	"/skill:atlassian-br-patterns",
	"/skill:atlassian-epic-creation-guide",
	"/skill:dps-platform",
];
const SONNET_KEYWORDS = [
	/\bdesign\b/i,
	/\barchitecture\b/i,
	/\bbrainstorm/i,
	/\btrade[- ]?offs?\b/i,
	/\balternatives?\b/i,
	/\bapproach(es)?\b/i,
	/\bproposal?\b/i,
	/\bpropose\b/i,
	/\bstrategy\b/i,
	/\bplan\b/i,
	/\bplanning\b/i,
	/\bspec(ification)?\b/i,
	/\boptions?\b/i,
	/\bshould (we|i)\b/i,
	/\bhow (would|should) (we|i)\b/i,
	/\bwhat'?s the best\b/i,
	/\bC4\b/,
	/\bADR\b/,
	/\bRFC\b/,
	/\breview (the )?(design|architecture|spec|plan)\b/i,
	/\bcompare\b/i,
	/\bevaluate\b/i,
];

// Haiku: retrieval / lookup / Q&A.
const HAIKU_KEYWORDS = [
	/^\s*(what|where|when|who|which|why) (is|are|was|were|does|do|did)\b/i,
	/\b(find|search|look ?up|locate|grep|list|show me?|fetch|get me?)\b/i,
	/\b(summari[sz]e|tl;?dr|recap)\b/i,
	/\b(read|open|cat|tail|head|preview)\b/i,
	/\b(status|state) of\b/i,
	/\b(current|latest|recent) (sprint|epic|issue|PR|commit|build)\b/i,
	/^\s*(jira|confluence|bitbucket)[ :].{0,80}$/i,
	/\bcount\b/i,
	/\bhow many\b/i,
];

// Opus signals (kept for transparency / scoring): essential / high-stakes work.
const OPUS_KEYWORDS = [
	/\b(implement|build|create|scaffold|write|generate) (the |a |an )/i,
	/\brefactor(ing)?\b/i,
	/\bdebug(ging)?\b/i,
	/\bfix (the |a |this )?(bug|issue|error|crash|regression)\b/i,
	/\bmigrate\b/i,
	/\bport\b/i,
	/\bbreaking change\b/i,
	/\brewrite\b/i,
	/\bship\b/i,
	/\bdeploy\b/i,
	/\bperformance (issue|problem|bug)\b/i,
	/\boptimi[sz]e (the |this )/i,
	/```/, // code block in the prompt
];

function skillTier(rawText: string): Tier | undefined {
	const text = rawText.trimStart();
	for (const hint of HAIKU_SKILL_HINTS) if (text.startsWith(hint)) return "haiku";
	for (const hint of SONNET_SKILL_HINTS) if (text.startsWith(hint)) return "sonnet";
	return undefined;
}

function classify(rawText: string): { tier: Tier; reason: string } | null {
	const text = rawText.trim();
	if (!text) return null;

	// Skill-command hints — checked before keyword scan because the skill body
	// would otherwise be expanded later and could bias toward other tiers.
	for (const hint of HAIKU_SKILL_HINTS) {
		if (text.startsWith(hint)) return { tier: "haiku", reason: `skill ${hint.slice(7)}` };
	}
	for (const hint of SONNET_SKILL_HINTS) {
		if (text.startsWith(hint)) return { tier: "sonnet", reason: `skill ${hint.slice(7)}` };
	}

	// Very short questions => haiku.
	if (text.length < 60 && /\?\s*$/.test(text)) {
		return { tier: "haiku", reason: "short Q" };
	}

	// Score-based classification (simple sum of hits per tier).
	let scoreH = 0,
		scoreS = 0,
		scoreO = 0;
	for (const re of HAIKU_KEYWORDS) if (re.test(text)) scoreH++;
	for (const re of SONNET_KEYWORDS) if (re.test(text)) scoreS++;
	for (const re of OPUS_KEYWORDS) if (re.test(text)) scoreO++;

	const max = Math.max(scoreH, scoreS, scoreO);
	if (max === 0) return null;

	// Tie-breaker preference: opus > sonnet > haiku (favor not-downgrading on ambiguity).
	if (scoreO === max) return { tier: "opus", reason: `opus×${scoreO}` };
	if (scoreS === max) return { tier: "sonnet", reason: `sonnet×${scoreS}` };
	return { tier: "haiku", reason: `haiku×${scoreH}` };
}

function parseBangPrefix(text: string): { tier: Tier; rest: string } | null {
	// Comma-prefix override: ",haiku ...", ",sonnet ...", ",opus ...".
	// We intentionally do NOT use "!" because pi reserves it for shell-out.
	const m = text.match(/^\s*,(haiku|sonnet|opus)\b\s*(.*)$/is);
	if (!m) return null;
	return { tier: m[1].toLowerCase() as Tier, rest: m[2] };
}

// --- extension --------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const local = loadLocal();
	const thinkingByTier = loadThinking();

	// Mode: "auto" = classify each prompt; "off" = never auto-switch.
	let mode: "auto" | "off" = "auto";

	// One-shot tier set by user via `/route haiku|sonnet|opus`. Cleared after one prompt.
	let oneShot: Tier | undefined;

	// Tier implied by a /skill:<name> command, captured from the RAW input before
	// pi expands the skill body. Consumed on the next before_agent_start.
	let pendingSkillTier: Tier | undefined;

	// Latest classification, for status display.
	let lastDecision: { tier: Tier; reason: string; label?: string } | undefined;

	// The concrete provider/id we most recently applied (may be the local
	// substitute for the cheap tier). Used to recognise our own model changes.
	let lastApplied: { provider: string; id: string } | undefined;

	// User explicitly picked a model? If so, do not auto-route until they say /route auto again.
	let userPinned = false;

	// True once the first turn of the current user prompt has been routed.
	let routedThisPrompt = false;

	function statusFor(): string | undefined {
		if (mode === "off") return "route:off";
		if (!lastDecision) return undefined;
		const label = lastDecision.label ?? lastDecision.tier;
		return `route:${label} (${lastDecision.reason})`;
	}

	function setStatus(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setStatus("tier-router", statusFor());
	}

	// Is the configured local model actually present on this machine?
	function localModel(ctx: ExtensionContext) {
		if (!local) return undefined;
		return ctx.modelRegistry.find(local.provider, local.model) ?? undefined;
	}

	// Resolve a tier to a concrete target, substituting the local model for the
	// cheap (haiku) tier when it is available on this machine.
	function resolveTarget(
		tier: Tier,
		ctx: ExtensionContext,
	): { provider: string; id: string; thinking: Thinking; label: string } {
		if (tier === "haiku" && local && localModel(ctx)) {
			return { provider: local.provider, id: local.model, thinking: local.thinking, label: "local" };
		}
		return { provider: config.provider, id: config.models[tier], thinking: thinkingByTier[tier], label: tier };
	}

	async function applyTier(tier: Tier, reason: string, ctx: ExtensionContext) {
		const t = resolveTarget(tier, ctx);
		const shownReason = t.label === "local" ? `${reason} → local` : reason;

		// Always set thinking level for the target (cheap and idempotent).
		if (pi.getThinkingLevel() !== t.thinking) {
			pi.setThinkingLevel(t.thinking);
		}

		if (ctx.model?.provider === t.provider && ctx.model?.id === t.id) {
			lastApplied = { provider: t.provider, id: t.id };
			lastDecision = { tier, reason: `${shownReason} (already)`, label: t.label };
			setStatus(ctx);
			return;
		}
		const model = ctx.modelRegistry.find(t.provider, t.id);
		if (!model) {
			ctx.ui.notify(`tier-router: model ${t.provider}/${t.id} not found`, "warning");
			return;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`tier-router: no API key for ${t.provider}/${t.id}`, "warning");
			return;
		}
		lastApplied = { provider: t.provider, id: t.id };
		lastDecision = { tier, reason: shownReason, label: t.label };
		setStatus(ctx);
	}

	// Apply a tier plus the cheap-tier context guard: the local model (or cloud
	// haiku) has a smaller window, so bump to cloud sonnet past the limit.
	async function routeTier(tier: Tier, reason: string, ctx: ExtensionContext) {
		if (tier === "haiku") {
			const usage = ctx.getContextUsage?.();
			const cheapLimit = localModel(ctx) ? 28_000 : 100_000;
			if (usage && usage.tokens > cheapLimit) {
				await applyTier("sonnet", `${reason} +bigctx`, ctx);
				routedThisPrompt = true;
				return;
			}
		}
		await applyTier(tier, reason, ctx);
		routedThisPrompt = true;
	}

	// Capture user-driven model changes so we do not fight them.
	pi.on("model_select", async (event, ctx) => {
		// source: "set" = /model command, "cycle" = Ctrl+P, "restore" = session reload.
		// Treat "set" and "cycle" as an explicit user choice.
		if (event.source === "set" || event.source === "cycle") {
			// Did we just do it ourselves?  ctx.model is the new one; if it matches our last
			// applied tier's model AND we set it within the current prompt cycle, ignore.
			const isOurs =
				lastApplied &&
				event.model.provider === lastApplied.provider &&
				event.model.id === lastApplied.id &&
				routedThisPrompt;
			if (!isOurs) {
				userPinned = true;
				lastDecision = undefined;
				setStatus(ctx);
			}
		}
	});

	// Strip ",tier " prefix before skill / template expansion, and capture any
	// /skill:<name> command from the RAW input (pre-expansion) for routing.
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		pendingSkillTier = skillTier(event.text);
		const parsed = parseBangPrefix(event.text);
		if (!parsed) return;
		oneShot = parsed.tier;
		return { action: "transform" as const, text: parsed.rest, images: event.images };
	});

	// Route once per user prompt, right before the agent starts thinking.
	pi.on("before_agent_start", async (event, ctx) => {
		routedThisPrompt = false; // reset; we will set true if we route.

		// Highest-priority: user override via ,prefix.
		if (oneShot) {
			const tier = oneShot;
			oneShot = undefined;
			pendingSkillTier = undefined;
			await applyTier(tier, ",override", ctx);
			routedThisPrompt = true;
			return;
		}

		if (mode === "off") {
			pendingSkillTier = undefined;
			setStatus(ctx);
			return;
		}

		if (userPinned) {
			pendingSkillTier = undefined;
			lastDecision = undefined;
			setStatus(ctx);
			return;
		}

		// Skill-command routing, captured from the raw input before expansion.
		if (pendingSkillTier) {
			const tier = pendingSkillTier;
			pendingSkillTier = undefined;
			await routeTier(tier, "skill", ctx);
			return;
		}

		const decision = classify(event.prompt);
		if (!decision) {
			// No classification signal -> stay on the default tier (sonnet).
			// Never silently jump to opus; routing only escalates on a clear signal.
			await applyTier("sonnet", "default", ctx);
			routedThisPrompt = true;
			return;
		}

		await routeTier(decision.tier, decision.reason, ctx);
	});

	// Allow next prompt to route again (reset per-prompt latch).
	pi.on("agent_end", async (_event, _ctx) => {
		routedThisPrompt = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx);
	});

	// /route command -------------------------------------------------------
	pi.registerCommand("route", {
		description: "Tier-router controls: /route [off|auto|haiku|sonnet|opus|show]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			switch (arg) {
				case "":
				case "show":
					ctx.ui.notify(
						[
							`mode      : ${mode}`,
							`pinned    : ${userPinned ? "yes (user picked a model; /route auto to release)" : "no"}`,
							`one-shot  : ${oneShot ?? "(none)"}`,
							`last call : ${lastDecision ? `${lastDecision.tier} — ${lastDecision.reason}` : "(none yet)"}`,
							`current   : ${ctx.model?.id ?? "(no model)"}`,
							`tiers     : haiku=${config.models.haiku}  sonnet=${config.models.sonnet}  opus=${config.models.opus}`,
							`local     : ${local ? `${local.provider}/${local.model} ${localModel(ctx) ? "— available; cheap tier routes here" : "— not on this machine"}` : "(disabled)"}`,
							`thinking  : haiku=${thinkingByTier.haiku}  sonnet=${thinkingByTier.sonnet}  opus=${thinkingByTier.opus}`,
						].join("\n"),
						"info",
					);
					break;
				case "off":
					mode = "off";
					userPinned = false;
					setStatus(ctx);
					ctx.ui.notify("tier-router: OFF (model stays as-is)", "info");
					break;
				case "auto":
				case "on":
					mode = "auto";
					userPinned = false;
					setStatus(ctx);
					ctx.ui.notify("tier-router: AUTO (releasing any manual pin)", "info");
					break;
				case "haiku":
				case "sonnet":
				case "opus":
					oneShot = arg as Tier;
					ctx.ui.notify(`tier-router: next prompt forced to ${arg}`, "info");
					break;
				default:
					ctx.ui.notify(`tier-router: unknown arg '${arg}'. Use off|auto|haiku|sonnet|opus|show.`, "warning");
			}
		},
		getArgumentCompletions: (prefix: string) => {
			const opts = ["show", "off", "auto", "haiku", "sonnet", "opus"];
			const items = opts
				.filter((o) => o.startsWith(prefix.toLowerCase()))
				.map((o) => ({ value: o, label: o }));
			return items.length > 0 ? items : null;
		},
	});
}
