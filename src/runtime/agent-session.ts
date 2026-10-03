// AgentSession: one user turn at a time per session, run on pi-agent-core's
// loop function.
//
// pi supplies the mechanism and keeps no state between requests: the loop
// (streaming, tool execution, cancellation) and the model call. MiniBot owns
// all state and the rules around it:
//   - persistence: every finished message is appended in the awaited event
//     sink, so it is on disk before the next tool runs or request starts;
//     failed, aborted, and empty replies are never persisted;
//   - the request: rebuilt from the session before every model call (system
//     prompt, projection, time stamp), compacting first when it is too big;
//   - approval, the per-turn request limit, and retries (in the stream, see
//     retry-stream.ts);
//   - the ending: a turn without a final answer (cancelled, failed, or cut off
//     by the limit) gets a closing reply, so the model does not take it up
//     again later;
//   - translation of loop events into MiniBot's RuntimeEvent stream.

import { type AgentEvent, type AgentLoopConfig, type AgentTool, runAgentLoop } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Message, type Model, type Models, type Tool as ToolDeclaration, toToolDeclaration } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Session, SessionStore } from "../session/store.ts";
import { type ChatMessage, emptyUsage, messageText, thinkingText, toolCalls } from "../session/types.ts";
import type { ArtifactStore } from "../tools/artifacts.ts";
import { failure, parseToolResult, type ToolOutput, type ToolResult, toolResultText } from "../tools/result.ts";
import type { ToolRegistry } from "../tools/tool.ts";
import { errorMessage, errorName, estimateTokens, preview, randomSuffix } from "../util.ts";
import { type ApprovalPolicy, newApprovalId } from "./approval.ts";
import type { Compactor } from "./compaction.ts";
import type { Budget, ContextBuilder } from "./context.ts";
import { EventEmitter, type EventHandler, type RunSource, usageFrom } from "./events.ts";
import { withRetries } from "./retry-stream.ts";

export class RunCancelledError extends Error {
	override name = "RunCancelledError";
	constructor() {
		super("运行已取消。");
	}
}

export class SessionBusyError extends Error {
	override name = "SessionBusyError";
}

export interface TurnOutcome {
	runId: string;
	sessionId: string;
	reply: string;
	didCompact: boolean;
}

export interface PromptOptions {
	source: RunSource;
	runId?: string;
	onEvent?: EventHandler;
}

export interface AgentSessionDeps {
	config: Config;
	models: Models;
	model: Model<Api>;
	store: SessionStore;
	tools: ToolRegistry;
	artifacts: ArtifactStore;
	context: ContextBuilder;
	budget: Budget;
	compactor: Compactor;
	approval: ApprovalPolicy;
	/** Always-on subscribers, such as the run log and tracing. */
	subscribers: EventHandler[];
}

interface ActiveRun {
	runId: string;
	sessionId: string;
	/** The one cancellation source: the loop, approvals, tools, and retries all watch it. */
	controller: AbortController;
}

/** Mutable state of one turn, shared by the loop callbacks. */
interface TurnState {
	/** Model requests so far; retries inside the stream are not new requests. */
	requests: number;
	requestStartedAt: number;
	hitLimit: boolean;
	didCompact: boolean;
	reply: string | undefined;
}

/** How a run ended. */
type Ending =
	| { kind: "answered"; reply: string; didCompact: boolean }
	| { kind: "limited"; didCompact: boolean }
	| { kind: "cancelled" }
	| { kind: "failed"; error: unknown };

const LIMIT_REPLY = "抱歉,工具调用轮次已达上限,请简化问题后重试。";
const CANCELLED_REPLY = "(用户取消了这次请求,它没有完成;除非用户再次要求,不要继续做。)";
const failedReply = (error: unknown) => `(这次请求因错误没有完成:${preview(errorMessage(error), 200)};除非用户再次要求,不要继续做。)`;

export function makeRunId(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `r_${stamp}_${randomSuffix(4)}`;
}

/** The envelope of a finished tool call, whoever produced the result. */
function resultOf(details: unknown, content: { type: string; text?: string }[], isError: boolean): ToolResult {
	const text = content.map((block) => block.text ?? "").join("");
	const parsed = details && typeof details === "object" && "code" in details ? (details as ToolResult) : parseToolResult(text);
	return parsed ?? { ok: !isError, code: isError ? "error" : "success", summary: text, data: {}, artifact: null, truncated: false };
}

export class AgentSession {
	readonly #deps: AgentSessionDeps;
	readonly #bySession = new Map<string, ActiveRun>();
	readonly #byRun = new Map<string, ActiveRun>();

	constructor(deps: AgentSessionDeps) {
		this.#deps = deps;
	}

	get modelLabel(): string {
		return `${this.#deps.model.provider}/${this.#deps.model.id}`;
	}

	isBusy(sessionId?: string): boolean {
		return sessionId === undefined ? this.#bySession.size > 0 : this.#bySession.has(sessionId);
	}

	/** Ask a run to stop; it ends with run.cancelled. */
	abort(runId: string): boolean {
		const run = this.#byRun.get(runId);
		if (!run) return false;
		run.controller.abort(new RunCancelledError());
		return true;
	}

	/** Manual compaction of an idle session; undefined when nothing can be cut. */
	async compact(sessionId: string): Promise<string | undefined> {
		if (this.isBusy(sessionId)) throw new SessionBusyError(`会话 ${sessionId} 正在运行,稍后再压缩。`);
		const session = this.#deps.store.resolve(sessionId);
		const tokens = this.#deps.budget.estimate(session, estimateTokens(this.#deps.context.systemPrompt(new Date())));
		return this.#deps.compactor.compact(session, tokens);
	}

	/** Run one user turn. `target`: a session id, "current", or empty for a new session. */
	async prompt(target: string | undefined, input: string, options: PromptOptions): Promise<TurnOutcome> {
		const session = this.#deps.store.resolve(target);
		if (this.#bySession.has(session.id)) throw new SessionBusyError(`会话 ${session.id} 已有运行中的 turn。`);
		const run: ActiveRun = { runId: options.runId ?? makeRunId(), sessionId: session.id, controller: new AbortController() };
		this.#bySession.set(session.id, run);
		this.#byRun.set(run.runId, run);
		const handlers = options.onEvent ? [...this.#deps.subscribers, options.onEvent] : this.#deps.subscribers;
		const emitter = new EventEmitter(run.runId, session.id, handlers);
		try {
			emitter.emit("run.started", { input, source: options.source, model: this.modelLabel, turnIndex: session.turnCount() + 1 });
			let ending: Ending;
			try {
				ending = await this.#turn(session, input, run, emitter);
			} catch (error) {
				ending = run.controller.signal.aborted ? { kind: "cancelled" } : { kind: "failed", error };
			}
			return this.#finish(session, run, emitter, ending);
		} finally {
			this.#bySession.delete(session.id);
			this.#byRun.delete(run.runId);
		}
	}

	/** The one way a run ends: close a turn without a final answer, then report how it ended. */
	#finish(session: Session, run: ActiveRun, emitter: EventEmitter, ending: Ending): TurnOutcome {
		switch (ending.kind) {
			case "answered":
				emitter.emit("run.completed", { reply: ending.reply, didCompact: ending.didCompact });
				return { runId: run.runId, sessionId: session.id, reply: ending.reply, didCompact: ending.didCompact };
			case "limited":
				this.#close(session, LIMIT_REPLY);
				emitter.emit("message.completed", { content: LIMIT_REPLY, reason: "max_iterations" });
				emitter.emit("run.completed", { reply: LIMIT_REPLY, didCompact: ending.didCompact });
				return { runId: run.runId, sessionId: session.id, reply: LIMIT_REPLY, didCompact: ending.didCompact };
			case "cancelled":
				this.#close(session, CANCELLED_REPLY);
				emitter.emit("run.cancelled", {});
				throw new RunCancelledError();
			case "failed":
				this.#close(session, failedReply(ending.error));
				emitter.emit("run.failed", { errorType: errorName(ending.error), message: errorMessage(ending.error) });
				throw ending.error;
		}
	}

	/** Append a fixed reply unless the turn already ends with a final answer (or never started). */
	#close(session: Session, text: string): void {
		const last = session.messages().at(-1);
		if (!last || (last.role === "assistant" && last.stopReason === "stop")) return;
		const { model, store } = this.#deps;
		store.appendMessage(session, {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	async #turn(session: Session, input: string, run: ActiveRun, emitter: EventEmitter): Promise<Ending> {
		const { config, models, model, budget, context } = this.#deps;
		const state: TurnState = { requests: 0, requestStartedAt: 0, hitLimit: false, didCompact: false, reply: undefined };
		const tools = this.#agentTools(session, run);
		const declarations = tools.map(toToolDeclaration);
		const toolTokens = estimateTokens(JSON.stringify(declarations));
		const fixedTokens = (now: Date) => estimateTokens(context.systemPrompt(now)) + toolTokens;

		emitter.emit("context.usage", {
			tokens: budget.estimate(session, fixedTokens(new Date())) + estimateTokens(input),
			compactAt: budget.compactAt,
			hardLimit: budget.hardLimit,
			contextWindow: budget.contextWindow,
		});

		const signal = run.controller.signal;
		const loop: AgentLoopConfig = {
			model,
			reasoning: config.thinking === "off" ? undefined : config.thinking,
			maxTokens: config.maxOutputTokens,
			// pi-ai retries only before a response arrives; MiniBot retries in the stream.
			maxRetries: 0,
			sessionId: session.id,
			toolExecution: "parallel",
			convertToLlm: (messages) => messages,
			// The request is rebuilt from the session; the loop's own transcript is not sent.
			prepareRequest: async () => ({ context: { messages: await this.#request(session, state, emitter, fixedTokens, declarations, signal), tools } }),
			beforeToolCall: ({ toolCall, args }) => this.#approve(run, emitter, toolCall.id, toolCall.name, args as Record<string, unknown>),
			finishTurn: (turn) => {
				if (state.requests < config.maxIterations || toolCalls(turn.message).length === 0) return undefined;
				state.hitLimit = true;
				return { action: "end" };
			},
		};
		const stream = withRetries((m, c, o) => models.streamSimple(m, c, o), config.maxRetries, (retry) =>
			emitter.emit("model.retrying", { iteration: state.requests, ...retry }),
		);
		const user: Message = { role: "user", content: input, timestamp: Date.now() };
		const messages = await runAgentLoop([user], { messages: [], tools }, loop, (event) => this.#record(event, session, state, emitter), signal, stream);

		if (signal.aborted) throw signal.reason;
		const last = messages.at(-1);
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
			throw new Error(last.errorMessage ?? "模型调用失败。");
		}
		if (state.hitLimit) return { kind: "limited", didCompact: state.didCompact };
		if (!state.reply) throw new Error("模型返回空回复,请重试。");
		return { kind: "answered", reply: state.reply, didCompact: state.didCompact };
	}

	/** Build the next request from the session, compacting first when it is too big. */
	async #request(
		session: Session,
		state: TurnState,
		emitter: EventEmitter,
		fixedTokens: (now: Date) => number,
		declarations: ToolDeclaration[],
		signal: AbortSignal,
	): Promise<Message[]> {
		const { budget, compactor, context } = this.#deps;
		const now = new Date();
		let tokens = budget.estimate(session, fixedTokens(now));
		if (tokens > budget.compactAt) {
			const message = await compactor.compact(session, tokens, { emitter, signal });
			if (message) {
				state.didCompact = true;
				emitter.emit("context.compacted", { message });
				tokens = budget.estimate(session, fixedTokens(now));
			}
			if (tokens > budget.hardLimit) throw new Error("当前上下文仍然超过模型输入上限,请用 /compact 压缩或开启新会话后重试。");
		}
		// The leading system message carries the prompt and the tool declarations.
		const system: Message = { role: "system", content: context.systemPrompt(now), toolsAdded: declarations, timestamp: 0 };
		const messages: Message[] = [system, ...context.requestMessages(session.messages(), now)];
		state.requests += 1;
		state.requestStartedAt = performance.now();
		emitter.emit("model.started", {
			iteration: state.requests,
			model: this.modelLabel,
			messages,
			tools: declarations.map((tool) => tool.name),
		});
		return messages;
	}

	async #approve(
		run: ActiveRun,
		emitter: EventEmitter,
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ block: true; reason: string } | undefined> {
		const tool = this.#deps.tools.get(name);
		if (!tool?.requiresApproval) return undefined;
		const { approval } = this.#deps;
		const deny = (summary: string) => ({
			block: true as const,
			reason: toolResultText({ ok: false, code: "denied", summary, data: { tool: name, args }, artifact: null, truncated: false }),
		});
		if (approval.mode === "always") {
			emitter.emit("approval.resolved", { approvalId: null, toolCallId, tool: name, approved: true, auto: true });
			return undefined;
		}
		if (!approval.handler) {
			emitter.emit("approval.resolved", { approvalId: null, toolCallId, tool: name, approved: false, auto: true });
			return deny(`工具 ${name} 需要审批,但当前没有可用的审批渠道,已拒绝执行。`);
		}
		const approvalId = newApprovalId();
		emitter.emit("approval.required", { approvalId, toolCallId, tool: name, args });
		let approved = false;
		try {
			approved = await approval.handler(
				{ runId: run.runId, sessionId: run.sessionId, approvalId, toolCallId, tool: name, args },
				run.controller.signal,
			);
		} catch {
			approved = false;
		}
		emitter.emit("approval.resolved", { approvalId, toolCallId, tool: name, approved, auto: false });
		return approved ? undefined : deny(`用户拒绝执行工具 ${name}。`);
	}

	/** The loop's event sink, awaited by the loop: persistence finishes before it moves on. */
	#record(event: AgentEvent, session: Session, state: TurnState, emitter: EventEmitter): void {
		const { store, tools } = this.#deps;
		switch (event.type) {
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" || update.type === "thinking_delta") {
					emitter.emit("model.delta", {
						iteration: state.requests,
						channel: update.type === "text_delta" ? "text" : "reasoning",
						text: update.delta,
					});
				}
				return;
			}
			case "message_end": {
				const message = event.message as ChatMessage;
				if (message.role === "user") {
					store.appendMessage(session, message);
				} else if (message.role === "toolResult") {
					store.appendMessage(session, { ...message, details: undefined });
				} else if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
					this.#recordReply(message, session, state, emitter);
				}
				return;
			}
			case "tool_execution_start": {
				const tool = tools.get(event.toolName);
				emitter.emit("tool.started", {
					toolCallId: event.toolCallId,
					tool: event.toolName,
					label: tool?.label ?? event.toolName,
					source: tool?.source ?? (tool ? "local" : "unknown"),
					args: (event.args ?? {}) as Record<string, unknown>,
					requiresApproval: tool?.requiresApproval ?? false,
				});
				return;
			}
			case "tool_execution_end": {
				const tool = tools.get(event.toolName);
				const result = resultOf(event.result.details, event.result.content, event.isError);
				emitter.emit(result.ok ? "tool.completed" : "tool.failed", {
					toolCallId: event.toolCallId,
					tool: event.toolName,
					label: tool?.label ?? event.toolName,
					source: tool?.source ?? (tool ? "local" : "unknown"),
					result,
				});
				return;
			}
			default:
				return;
		}
	}

	/** A finished model reply: persisted unless empty, then reported. */
	#recordReply(message: AssistantMessage, session: Session, state: TurnState, emitter: EventEmitter): void {
		const calls = toolCalls(message);
		const text = messageText(message).trim();
		if (calls.length > 0 || text) this.#deps.store.appendMessage(session, message);
		emitter.emit("model.completed", {
			iteration: state.requests,
			elapsedMs: Math.round(performance.now() - state.requestStartedAt),
			usage: usageFrom(message.usage),
			output: { text: messageText(message), reasoning: thinkingText(message), toolCalls: calls },
		});
		if (calls.length === 0 && text) {
			state.reply = text;
			emitter.emit("message.completed", { content: text, reason: "answer" });
		}
	}

	/** MiniBot tools as pi AgentTools: the result is the materialized envelope. */
	#agentTools(session: Session, run: ActiveRun): AgentTool[] {
		const { tools, artifacts, config } = this.#deps;
		const signal = run.controller.signal;
		return tools.list().map((tool) => ({
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description,
			parameters: tool.parameters,
			executionMode: tool.concurrent ? "parallel" : "sequential",
			execute: async (_toolCallId, params) => {
				let result: ToolResult;
				try {
					const output: ToolOutput = await tool.execute(params, { sessionId: session.id, runId: run.runId, workspace: config.workspace, signal });
					result = artifacts.materialize(output, session.id);
				} catch (error) {
					result = signal.aborted
						? {
								ok: false,
								code: "interrupted",
								summary: `工具 ${tool.name} 执行中被取消,副作用未知;重试有副作用的操作前请先确认当前状态。`,
								data: { tool: tool.name },
								artifact: null,
								truncated: false,
							}
						: artifacts.materialize(failure("error", `工具 ${tool.name} 执行失败: ${errorMessage(error)}`, { data: { tool: tool.name } }), session.id);
				}
				return { content: [{ type: "text", text: toolResultText(result) }], details: result as never, isError: !result.ok };
			},
		}));
	}
}
