// Approval for tools that need the user's consent. Each frontend supplies a
// handler (terminal prompt, TUI dialog, web broker). Without one, sensitive
// tools are denied: a frontend that never wired approval must not let them
// run unasked.

import type { ApprovalMode } from "../config.ts";
import { shortId } from "../util.ts";

export interface ApprovalRequest {
	runId: string;
	sessionId: string;
	approvalId: string;
	toolCallId: string;
	tool: string;
	args: Record<string, unknown>;
}

/** Resolve true to approve. Must settle (false is fine) when `signal` aborts. */
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;

export class ApprovalPolicy {
	mode: ApprovalMode;
	handler: ApprovalHandler | undefined;

	constructor(mode: ApprovalMode, handler?: ApprovalHandler) {
		this.mode = mode;
		this.handler = handler;
	}
}

export function newApprovalId(): string {
	return shortId("ap");
}

/**
 * Rendezvous between a run waiting for approval and an HTTP request that
 * answers it. A decision may arrive before the wait starts.
 */
export class ApprovalBroker {
	readonly #pending = new Map<string, (approved: boolean) => void>();
	readonly #early = new Map<string, boolean>();

	readonly handler: ApprovalHandler = (request, signal) => {
		const key = `${request.runId}:${request.approvalId}`;
		const early = this.#early.get(key);
		if (early !== undefined) {
			this.#early.delete(key);
			return Promise.resolve(early);
		}
		return new Promise((resolve) => {
			const finish = (approved: boolean) => {
				this.#pending.delete(key);
				signal.removeEventListener("abort", onAbort);
				resolve(approved);
			};
			const onAbort = () => finish(false);
			if (signal.aborted) {
				resolve(false);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(key, finish);
		});
	};

	/** Returns true when a waiting run received the decision. */
	resolve(runId: string, approvalId: string, approved: boolean): boolean {
		const key = `${runId}:${approvalId}`;
		const pending = this.#pending.get(key);
		if (pending) {
			pending(approved);
			return true;
		}
		this.#early.set(key, approved);
		return false;
	}
}
