// Retry a model call that failed before any output, inside the stream.
//
// Events are held back until the first one that shows the user something.
// An attempt that fails with a transient error before then is dropped and
// requested again after a backoff, so the agent loop never sees it. Once
// output has gone out, a failure is final: the user already saw part of an
// answer, and a retry would show a second, different one.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { emptyUsage } from "../session/types.ts";
import { errorMessage, sleep } from "../util.ts";

export interface Retry {
	attempt: number;
	maxRetries: number;
	delayMs: number;
	error: string;
}

/** Events that show the user something, or end the attempt. */
const RELEASES = new Set<AssistantMessageEvent["type"]>(["text_delta", "thinking_delta", "toolcall_start", "done", "error"]);

export function withRetries(stream: StreamFn, maxRetries: number, onRetry: (retry: Retry) => void): StreamFn {
	return (model, context, options) => {
		const out = createAssistantMessageEventStream();
		const signal = options?.signal;
		const run = async () => {
			for (let attempt = 1; ; attempt++) {
				const held: AssistantMessageEvent[] = [];
				let released = false;
				let failed: AssistantMessage | undefined;
				for await (const event of await stream(model, context, options)) {
					if (released) {
						out.push(event);
						continue;
					}
					if (event.type === "error" && attempt <= maxRetries && !signal?.aborted && isRetryableAssistantError(event.error)) {
						failed = event.error;
						break;
					}
					held.push(event);
					if (!RELEASES.has(event.type)) continue;
					released = true;
					for (const item of held) out.push(item);
				}
				if (!failed) return;
				const delayMs = 1_000 * 2 ** (attempt - 1);
				onRetry({ attempt, maxRetries, delayMs, error: failed.errorMessage ?? "unknown error" });
				try {
					await sleep(delayMs, signal);
				} catch {
					out.push({ type: "error", reason: "aborted", error: { ...failed, stopReason: "aborted" } });
					return;
				}
			}
		};
		// The loop waits on this stream: whatever goes wrong must still end it.
		run().catch((error: unknown) => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "error",
				errorMessage: errorMessage(error),
				timestamp: Date.now(),
			};
			out.push({ type: "error", reason: "error", error: message });
		});
		return out;
	};
}
