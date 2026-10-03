// runs.jsonl: one summary line per run, folded from the event stream.
// Nothing in the run knows run logging exists.

import { appendFileSync } from "node:fs";
import { preview } from "../util.ts";
import type { RunSource, RuntimeEvent, Usage } from "./events.ts";

export interface RunRecord {
	runId: string;
	sessionId: string;
	turnIndex: number;
	source: RunSource;
	model: string;
	status: "completed" | "failed" | "cancelled";
	startedAt: string;
	endedAt: string;
	durationMs: number;
	inputPreview: string;
	replyPreview: string | null;
	errorType: string | null;
	errorPreview: string | null;
	didCompact: boolean;
	llmCalls: number;
	usage: Usage;
	toolCalls: number;
	toolsUsed: string[];
	mcpToolCalls: number;
	toolErrors: number;
}

interface Accumulator extends Omit<RunRecord, "status" | "endedAt" | "durationMs" | "replyPreview" | "errorType" | "errorPreview"> {
	startedMs: number;
}

const MAX_ACTIVE = 256;

export class RunLog {
	readonly #path: string;
	readonly #active = new Map<string, Accumulator>();

	constructor(path: string) {
		this.#path = path;
	}

	readonly handle = (event: RuntimeEvent): void => {
		try {
			this.#fold(event);
		} catch {
			// Bookkeeping must never fail a run.
		}
	};

	#fold(event: RuntimeEvent): void {
		if (event.type === "run.started") {
			this.#active.set(event.runId, {
				runId: event.runId,
				sessionId: event.sessionId,
				turnIndex: event.payload.turnIndex,
				source: event.payload.source,
				model: event.payload.model,
				startedAt: event.createdAt,
				startedMs: Date.now(),
				inputPreview: preview(event.payload.input, 120),
				didCompact: false,
				llmCalls: 0,
				usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
				toolCalls: 0,
				toolsUsed: [],
				mcpToolCalls: 0,
				toolErrors: 0,
			});
			if (this.#active.size > MAX_ACTIVE) this.#active.delete(this.#active.keys().next().value as string);
			return;
		}
		const run = this.#active.get(event.runId);
		if (!run) return;
		switch (event.type) {
			case "model.completed":
				run.llmCalls += 1;
				add(run.usage, event.payload.usage);
				return;
			case "compaction.completed":
				run.llmCalls += 1;
				if (event.payload.usage) add(run.usage, event.payload.usage);
				return;
			case "context.compacted":
				run.didCompact = true;
				return;
			case "tool.completed":
			case "tool.failed":
				run.toolCalls += 1;
				run.toolsUsed.push(event.payload.tool);
				if (event.payload.source === "mcp") run.mcpToolCalls += 1;
				if (event.type === "tool.failed") run.toolErrors += 1;
				return;
			case "run.completed":
				this.#finish(run, event.createdAt, "completed", { reply: event.payload.reply });
				return;
			case "run.failed":
				this.#finish(run, event.createdAt, "failed", { errorType: event.payload.errorType, error: event.payload.message });
				return;
			case "run.cancelled":
				this.#finish(run, event.createdAt, "cancelled", {});
				return;
			default:
				return;
		}
	}

	#finish(run: Accumulator, endedAt: string, status: RunRecord["status"], end: { reply?: string; errorType?: string; error?: string }): void {
		this.#active.delete(run.runId);
		const { startedMs, ...fields } = run;
		const record: RunRecord = {
			...fields,
			status,
			endedAt,
			durationMs: Date.now() - startedMs,
			replyPreview: end.reply === undefined ? null : preview(end.reply, 200),
			errorType: end.errorType ?? null,
			errorPreview: end.error === undefined ? null : preview(end.error, 200),
		};
		appendFileSync(this.#path, `${JSON.stringify(record)}\n`, "utf8");
	}
}

function add(total: Usage, usage: Usage): void {
	total.inputTokens += usage.inputTokens;
	total.outputTokens += usage.outputTokens;
	total.cachedInputTokens += usage.cachedInputTokens;
	total.totalTokens += usage.totalTokens;
}
