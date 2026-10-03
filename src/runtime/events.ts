// The runtime event stream: everything observable about a run leaves through
// it. UIs render it, runs.jsonl and tracing fold it, evals read it back.

import type { Message, Usage as ProviderUsage } from "@earendil-works/pi-ai";
import type { ToolResult } from "../tools/result.ts";
import { nowIso } from "../util.ts";

export type RunSource = "cli" | "tui" | "server" | "scheduler" | "heartbeat" | "eval";

export interface Usage {
	/** Every input token, cached ones included. */
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	totalTokens: number;
}

/** pi-ai reports uncached input apart from cache reads and writes. */
export function usageFrom(usage: ProviderUsage): Usage {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		inputTokens,
		outputTokens: usage.output,
		cachedInputTokens: usage.cacheRead,
		totalTokens: inputTokens + usage.output,
	};
}

export interface ModelOutput {
	text: string;
	reasoning: string;
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

export interface ToolEventBase {
	toolCallId: string;
	tool: string;
	label: string;
	source: "local" | "mcp" | "unknown";
}

export interface EventPayloads {
	"run.started": { input: string; source: RunSource; model: string; turnIndex: number };
	"run.completed": { reply: string; didCompact: boolean };
	"run.failed": { errorType: string; message: string };
	"run.cancelled": Record<string, never>;
	"context.usage": { tokens: number; compactAt: number; hardLimit: number; contextWindow: number };
	"context.compacted": { message: string };
	/** `messages` is the exact request; wire-facing subscribers strip it. */
	"model.started": { iteration: number; model: string; messages: Message[]; tools: string[] };
	"model.delta": { iteration: number; channel: "text" | "reasoning"; text: string };
	"model.retrying": { iteration: number; attempt: number; maxRetries: number; delayMs: number; error: string };
	"model.completed": { iteration: number; elapsedMs: number; usage: Usage; output: ModelOutput };
	"compaction.started": { model: string; messages: Message[] };
	"compaction.completed": { elapsedMs: number; usage: Usage | null; summary: string | null; error: string | null };
	"tool.started": ToolEventBase & { args: Record<string, unknown>; requiresApproval: boolean };
	"tool.completed": ToolEventBase & { result: ToolResult };
	"tool.failed": ToolEventBase & { result: ToolResult };
	"approval.required": { approvalId: string; toolCallId: string; tool: string; args: Record<string, unknown> };
	"approval.resolved": { approvalId: string | null; toolCallId: string; tool: string; approved: boolean; auto: boolean };
	"message.completed": { content: string; reason: "answer" | "max_iterations" };
}

export type EventType = keyof EventPayloads;

export type RuntimeEvent = {
	[K in EventType]: {
		id: string;
		runId: string;
		sessionId: string;
		seq: number;
		type: K;
		createdAt: string;
		payload: EventPayloads[K];
	};
}[EventType];

export type EventOf<K extends EventType> = Extract<RuntimeEvent, { type: K }>;

export type EventHandler = (event: RuntimeEvent) => void;

/** Monotonic per-run events, delivered to every handler in order. */
export class EventEmitter {
	readonly runId: string;
	readonly sessionId: string;
	readonly #handlers: EventHandler[];
	#seq = 0;

	constructor(runId: string, sessionId: string, handlers: EventHandler[]) {
		this.runId = runId;
		this.sessionId = sessionId;
		this.#handlers = handlers;
	}

	emit<K extends EventType>(type: K, payload: EventPayloads[K]): RuntimeEvent {
		this.#seq += 1;
		const event = {
			id: `${this.runId}:${this.#seq}`,
			runId: this.runId,
			sessionId: this.sessionId,
			seq: this.#seq,
			type,
			createdAt: nowIso(),
			payload,
		} as RuntimeEvent;
		for (const handler of this.#handlers) handler(event);
		return event;
	}
}
