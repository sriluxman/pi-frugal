/**
 * tier-router.ts
 *
 * Auto-routes each user prompt to a model tier based on intent:
 *
 *   haiku   - retrieval / Q&A / lookup work (cheapest)
 *   sonnet  - design, brainstorming, planning, advising (mid)
 *   opus    - essential work: implementation, refactor, deep debug (most expensive)
 *
 * Decision precedence (first match wins):
 *   1. Explicit comma prefix:    ",haiku ...", ",sonnet ...", ",opus ..."   (prefix is stripped)
 *      (We use "," not "!" because pi reserves "!" for shell-out: e.g. "!ls" runs ls in bash.)
 *   2. Manual pin:                /route off  ->  stays on whatever model is currently set
 *   3. Skill-command heuristic:   /skill:brainstorming|writing-plans|po-advisor|architecture-advisor -> sonnet
 *                                 /skill:atlassian (read-only verbs) -> haiku
 *   4. User explicitly picked a model via /model or Ctrl+P after route-on -> stays pinned for the session
 *   5. Keyword classifier on the prompt text -> tier
 *   6. Fallback                                                      -> opus  (do not silently downgrade)
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
	"/skill:po-advisor",
	"/skill:architecture-advisor",
	"/skill:writing-skills",
	"/skill:c4-modelling",
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

function classify(rawText: string): { tier: Tier; reason: string } | null {
	const text = rawText.trim();
	if (!text) return null;

	// Skill-command hints (sonnet) — checked before keyword scan because the skill
	// body would otherwise be expanded later and could bias toward other tiers.
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
	const thinkingByTier = loadThinking();

	// Mode: "auto" = classify each prompt; "off" = never auto-switch.
	let mode: "auto" | "off" = "auto";

	// One-shot tier set by user via `/route haiku|sonnet|opus`. Cleared after one prompt.
	let oneShot: Tier | undefined;

	// Latest classification, for status display.
	let lastDecision: { tier: Tier; reason: string } | undefined;

	// User explicitly picked a model? If so, do not auto-route until they say /route auto again.
	let userPinned = false;

	// True once the first turn of the current user prompt has been routed.
	let routedThisPrompt = false;

	function statusFor(): string | undefined {
		if (mode === "off") return "route:off";
		if (!lastDecision) return undefined;
		return `route:${lastDecision.tier} (${lastDecision.reason})`;
	}

	function setStatus(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setStatus("tier-router", statusFor());
	}

	async function applyTier(tier: Tier, reason: string, ctx: ExtensionContext) {
		const targetId = config.models[tier];
		const targetThinking = thinkingByTier[tier];

		// Always set thinking level for the tier (cheap and idempotent).
		if (pi.getThinkingLevel() !== targetThinking) {
			pi.setThinkingLevel(targetThinking);
		}

		if (ctx.model?.id === targetId) {
			lastDecision = { tier, reason: `${reason} (already)` };
			setStatus(ctx);
			return;
		}
		const model = ctx.modelRegistry.find(config.provider, targetId);
		if (!model) {
			ctx.ui.notify(`tier-router: model ${config.provider}/${targetId} not found`, "warning");
			return;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`tier-router: no API key for ${config.provider}/${targetId}`, "warning");
			return;
		}
		lastDecision = { tier, reason };
		setStatus(ctx);
	}

	// Capture user-driven model changes so we do not fight them.
	pi.on("model_select", async (event, ctx) => {
		// source: "set" = /model command, "cycle" = Ctrl+P, "restore" = session reload.
		// Treat "set" and "cycle" as an explicit user choice.
		if (event.source === "set" || event.source === "cycle") {
			// Did we just do it ourselves?  ctx.model is the new one; if it matches our last
			// applied tier's model AND we set it within the current prompt cycle, ignore.
			const isOurs =
				lastDecision &&
				event.model.id === config.models[lastDecision.tier] &&
				routedThisPrompt;
			if (!isOurs) {
				userPinned = true;
				lastDecision = undefined;
				setStatus(ctx);
			}
		}
	});

	// Strip ",tier " prefix before skill / template expansion.
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
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
			await applyTier(tier, ",override", ctx);
			routedThisPrompt = true;
			return;
		}

		if (mode === "off") {
			setStatus(ctx);
			return;
		}

		if (userPinned) {
			lastDecision = undefined;
			setStatus(ctx);
			return;
		}

		const decision = classify(event.prompt);
		if (!decision) {
			// No signal -> default to opus (do not silently downgrade).
			await applyTier("opus", "default", ctx);
			routedThisPrompt = true;
			return;
		}

		// Guard: do not downgrade to haiku when context is already large.
		const usage = ctx.getContextUsage?.();
		if (decision.tier === "haiku" && usage && usage.tokens > 100_000) {
			await applyTier("sonnet", `${decision.reason} +bigctx`, ctx);
			routedThisPrompt = true;
			return;
		}

		await applyTier(decision.tier, decision.reason, ctx);
		routedThisPrompt = true;
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
