// Langfuse tracing: one more subscriber of the event stream. Each run becomes
// one trace: an agent root, a generation per model call (request, output,
// usage, first-token time), a generation per summary call, a tool
// observation per tool call, and event markers for approvals, compaction,
// and retries. Enabled only when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY
// are set; a tracing failure never reaches the run.

import type { Message } from "@earendil-works/pi-ai";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import type { EventHandler, RuntimeEvent, Usage } from "./events.ts";

type Observation = ReturnType<typeof startObservation>;

interface RunTrace {
	root: Observation;
	attributes: { sessionId: string; traceName: string; tags: string[] };
	generations: Map<string, Observation>;
	firstToken: Set<string>;
	tools: Map<string, Observation>;
	compactions: number;
}

const MAX_INPUT_MESSAGES = 50;

export interface Tracing {
	handle: EventHandler;
	flush(): Promise<void>;
}

export function langfuseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.LANGFUSE_PUBLIC_KEY?.trim() && env.LANGFUSE_SECRET_KEY?.trim()) && env.MINIBOT_LANGFUSE !== "0";
}

let started: Promise<Tracing | undefined> | undefined;

/**
 * Register the Langfuse span exporter once per process; undefined when not
 * configured. The OpenTelemetry packages load only then, keeping startup fast.
 */
export function startTracing(log: (message: string) => void = () => {}): Promise<Tracing | undefined> {
	started ??= (async () => {
		if (!langfuseConfigured()) return undefined;
		const { LangfuseSpanProcessor } = await import("@langfuse/otel");
		const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
		const processor = new LangfuseSpanProcessor();
		new NodeTracerProvider({ spanProcessors: [processor] }).register();
		const fold = new LangfuseFold(log);
		return { handle: fold.handle, flush: () => processor.forceFlush() };
	})();
	return started;
}

/** Keep leading system messages and the newest ones; mark the gap. */
function trim(messages: Message[]): unknown {
	let head = 0;
	while (head < messages.length && messages[head].role === "system") head++;
	const omitted = messages.length - head - MAX_INPUT_MESSAGES;
	if (omitted <= 0) return messages;
	return [...messages.slice(0, head), { role: "system", content: `[minibot: 省略了 ${omitted} 条较早的消息]` }, ...messages.slice(head + omitted)];
}

/** Cached input is split out so a separate cached-token price is not charged twice. */
function usageDetails(usage: Usage | null): Record<string, number> | undefined {
	if (!usage) return undefined;
	return {
		input: usage.inputTokens - usage.cachedInputTokens,
		input_cached_tokens: usage.cachedInputTokens,
		output: usage.outputTokens,
		total: usage.totalTokens,
	};
}

export class LangfuseFold {
	readonly #runs = new Map<string, RunTrace>();
	readonly #log: (message: string) => void;
	#warned = false;

	constructor(log: (message: string) => void) {
		this.#log = log;
	}

	readonly handle: EventHandler = (event) => {
		try {
			this.#fold(event);
		} catch (error) {
			if (!this.#warned) {
				this.#warned = true;
				this.#log(`Langfuse 追踪出错,已忽略(后续不再提示): ${(error as Error).message}`);
			}
		}
	};

	#start(run: RunTrace | undefined, parent: Observation | undefined, name: string, attributes: Record<string, unknown>, asType: "agent" | "generation" | "tool" | "event", attrs = run?.attributes): Observation {
		const create = () =>
			parent
				? parent.startObservation(name, attributes as never, { asType: asType as "span" })
				: startObservation(name, attributes as never, { asType: asType as "span" });
		return attrs ? propagateAttributes(attrs, create) : create();
	}

	#event(run: RunTrace, parent: Observation, name: string, metadata: unknown, level?: "WARNING"): void {
		this.#start(run, parent, name, { metadata, level }, "event").end();
	}

	#fold(event: RuntimeEvent): void {
		if (event.type === "run.started") {
			const attributes = { sessionId: event.sessionId, traceName: "minibot.turn", tags: [event.payload.source] };
			const root = this.#start(undefined, undefined, "minibot.turn", {
				input: event.payload.input,
				metadata: { runId: event.runId, turnIndex: event.payload.turnIndex, model: event.payload.model, source: event.payload.source },
			}, "agent", attributes);
			this.#runs.set(event.runId, { root, attributes, generations: new Map(), firstToken: new Set(), tools: new Map(), compactions: 0 });
			return;
		}
		const run = this.#runs.get(event.runId);
		if (!run) return;
		switch (event.type) {
			case "context.usage":
				run.root.update({ metadata: { context: event.payload } });
				return;
			case "model.started":
				run.generations.set(
					`model:${event.payload.iteration}`,
					this.#start(run, run.root, "model", { model: event.payload.model, input: trim(event.payload.messages), metadata: { iteration: event.payload.iteration, tools: event.payload.tools } }, "generation"),
				);
				return;
			case "model.delta": {
				const key = `model:${event.payload.iteration}`;
				if (run.firstToken.has(key)) return;
				run.firstToken.add(key);
				run.generations.get(key)?.update({ completionStartTime: new Date() } as never);
				return;
			}
			case "model.retrying":
				this.#event(run, run.generations.get(`model:${event.payload.iteration}`) ?? run.root, "model.retrying", event.payload, "WARNING");
				return;
			case "model.completed": {
				const key = `model:${event.payload.iteration}`;
				const generation = run.generations.get(key);
				run.generations.delete(key);
				generation?.update({ output: event.payload.output, usageDetails: usageDetails(event.payload.usage), metadata: { elapsedMs: event.payload.elapsedMs } } as never);
				generation?.end();
				return;
			}
			case "compaction.started":
				run.compactions += 1;
				run.generations.set(`compaction:${run.compactions}`, this.#start(run, run.root, "compaction.summary", { model: event.payload.model, input: event.payload.messages }, "generation"));
				return;
			case "compaction.completed": {
				const key = `compaction:${run.compactions}`;
				const generation = run.generations.get(key);
				run.generations.delete(key);
				generation?.update({
					output: event.payload.summary,
					usageDetails: usageDetails(event.payload.usage),
					metadata: { elapsedMs: event.payload.elapsedMs },
					...(event.payload.error ? { level: "ERROR", statusMessage: event.payload.error } : {}),
				} as never);
				generation?.end();
				return;
			}
			case "context.compacted":
				this.#event(run, run.root, "context.compacted", event.payload);
				return;
			case "tool.started":
				run.tools.set(
					event.payload.toolCallId,
					this.#start(run, run.root, event.payload.tool, { input: event.payload.args, metadata: { source: event.payload.source, requiresApproval: event.payload.requiresApproval } }, "tool"),
				);
				return;
			case "approval.required":
			case "approval.resolved": {
				const denied = event.type === "approval.resolved" && !event.payload.approved;
				this.#event(run, run.tools.get(event.payload.toolCallId) ?? run.root, event.type, event.payload, denied ? "WARNING" : undefined);
				return;
			}
			case "tool.completed":
			case "tool.failed": {
				const tool = run.tools.get(event.payload.toolCallId);
				run.tools.delete(event.payload.toolCallId);
				const failed = event.type === "tool.failed";
				tool?.update({ output: event.payload.result, ...(failed ? { level: "ERROR", statusMessage: event.payload.result.summary } : {}) } as never);
				tool?.end();
				return;
			}
			case "message.completed":
				run.root.update({ output: event.payload.content, ...(event.payload.reason === "max_iterations" ? { level: "WARNING", statusMessage: "达到请求次数上限" } : {}) } as never);
				return;
			case "run.completed":
				run.root.update({ output: event.payload.reply, metadata: { didCompact: event.payload.didCompact } });
				this.#finish(event.runId);
				return;
			case "run.failed":
				run.root.update({ level: "ERROR", statusMessage: `${event.payload.errorType}: ${event.payload.message}` } as never);
				this.#finish(event.runId);
				return;
			case "run.cancelled":
				run.root.update({ level: "WARNING", statusMessage: "用户取消" } as never);
				this.#finish(event.runId);
				return;
			default:
				return;
		}
	}

	#finish(runId: string): void {
		const run = this.#runs.get(runId);
		if (!run) return;
		this.#runs.delete(runId);
		// Anything still open was cut off by the end of the run.
		for (const open of [...run.generations.values(), ...run.tools.values()]) {
			open.update({ level: "WARNING", statusMessage: "运行结束时仍未完成" } as never);
			open.end();
		}
		run.root.end();
	}
}
