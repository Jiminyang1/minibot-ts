// AgentSession: one user turn at a time per session, run on pi-agent-core.
//
// The pi Agent owns the loop (streaming, tool execution, cancellation).
// This class owns MiniBot's rules around it:
//   - persistence: every finished message is appended in an awaited Agent
//     subscriber, so it is on disk before the next tool runs or request starts;
//     failed and aborted replies are never persisted;
//   - the request: rebuilt from the session before every model call (system
//     prompt, projection, time stamp), compacting first when it is too big;
//   - approval, the per-turn request limit, and retrying a call that failed
//     before any output reached the user;
//   - translation of Agent events into MiniBot's RuntimeEvent stream.

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	isRetryableAssistantError,
	type Message,
	type Model,
	type Models,
	type Tool as ToolDeclaration,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Session, SessionStore } from "../session/store.ts";
import { type ChatMessage, messageText, thinkingText, toolCalls } from "../session/types.ts";
import type { ArtifactStore } from "../tools/artifacts.ts";
import { failure, parseToolResult, type ToolOutput, type ToolResult, toolResultText } from "../tools/result.ts";
import type { ToolRegistry } from "../tools/tool.ts";
import { errorMessage, errorName, estimateTokens, randomSuffix, sleep } from "../util.ts";
import { type ApprovalPolicy, newApprovalId } from "./approval.ts";
import type { Compactor } from "./compaction.ts";
import type { Budget, ContextBuilder } from "./context.ts";
import { EventEmitter, type EventHandler, type RunSource, usageFrom } from "./events.ts";

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
	controller: AbortController;
	agent: Agent | undefined;
}

/** Mutable state of one turn, shared by the Agent callbacks. */
interface TurnState {
	iteration: number;
	requestStartedAt: number;
	/** Text or reasoning of the current request reached the user. */
	visibleOutput: boolean;
	turns: number;
	hitLimit: boolean;
	didCompact: boolean;
	reply: string | undefined;
	fatal: unknown;
}

const LIMIT_REPLY = "抱歉,工具调用轮次已达上限,请简化问题后重试。";
/** Closes a cancelled turn, so the model does not carry out the request later. */
const CANCELLED_REPLY = "(用户取消了这次请求,它没有完成;除非用户再次要求,不要继续做。)";

export function makeRunId(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `r_${stamp}_${randomSuffix(4)}`;
}

function hasOutput(message: AssistantMessage): boolean {
	return message.content.some((block) => (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : true));
}

function zeroUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** The envelope of a finished tool call, whoever produced the result. */
function resultOf(details: unknown, content: { type: string; text?: string }[], isError: boolean): ToolResult {
	const text = content.map((block) => block.text ?? "").join("");
	const parsed = details && typeof details === "object" && "code" in details ? (details as ToolResult) : parseToolResult(text);
	return parsed ?? { ok: !isError, code: isError ? "error" : "success", summary: text, data: {}, artifact: null, truncated: false };
}

export class AgentSession {
	readonly deps: AgentSessionDeps;
	readonly #bySession = new Map<string, ActiveRun>();
	readonly #byRun = new Map<string, ActiveRun>();

	constructor(deps: AgentSessionDeps) {
		this.deps = deps;
	}

	get modelLabel(): string {
		return `${this.deps.model.provider}/${this.deps.model.id}`;
	}

	isBusy(sessionId?: string): boolean {
		return sessionId === undefined ? this.#bySession.size > 0 : this.#bySession.has(sessionId);
	}

	/** Ask a run to stop; it ends with run.cancelled. */
	abort(runId: string): boolean {
		const run = this.#byRun.get(runId);
		if (!run) return false;
		run.controller.abort(new RunCancelledError());
		run.agent?.abort();
		return true;
	}

	/** Manual compaction of an idle session; undefined when nothing can be cut. */
	async compact(sessionId: string): Promise<string | undefined> {
		if (this.isBusy(sessionId)) throw new SessionBusyError(`会话 ${sessionId} 正在运行,稍后再压缩。`);
		const session = this.deps.store.resolve(sessionId);
		const tokens = this.deps.budget.estimate(session, estimateTokens(this.deps.context.systemPrompt(new Date())));
		return this.deps.compactor.compact(session, tokens);
	}

	/** Run one user turn. `target`: a session id, "current", or empty for a new session. */
	async prompt(target: string | undefined, input: string, options: PromptOptions): Promise<TurnOutcome> {
		const session = this.deps.store.resolve(target);
		if (this.#bySession.has(session.id)) throw new SessionBusyError(`会话 ${session.id} 已有运行中的 turn。`);
		const run: ActiveRun = { runId: options.runId ?? makeRunId(), sessionId: session.id, controller: new AbortController(), agent: undefined };
		this.#bySession.set(session.id, run);
		this.#byRun.set(run.runId, run);
		const handlers = options.onEvent ? [...this.deps.subscribers, options.onEvent] : this.deps.subscribers;
		const emitter = new EventEmitter(run.runId, session.id, handlers);
		try {
			emitter.emit("run.started", { input, source: options.source, model: this.modelLabel, turnIndex: session.turnCount() + 1 });
			const outcome = await this.#turn(session, input, run, emitter);
			emitter.emit("run.completed", { reply: outcome.reply, didCompact: outcome.didCompact });
			return outcome;
		} catch (error) {
			if (run.controller.signal.aborted) {
				const last = session.messages().at(-1);
				if (last && !(last.role === "assistant" && last.stopReason === "stop")) {
					this.deps.store.appendMessage(session, this.#fixedReply(CANCELLED_REPLY));
				}
				emitter.emit("run.cancelled", {});
				throw new RunCancelledError();
			}
			emitter.emit("run.failed", { errorType: errorName(error), message: errorMessage(error) });
			throw error;
		} finally {
			this.#bySession.delete(session.id);
			this.#byRun.delete(run.runId);
		}
	}

	async #turn(session: Session, input: string, run: ActiveRun, emitter: EventEmitter): Promise<TurnOutcome> {
		const { config, models, model, budget, context, store } = this.deps;
		const state: TurnState = {
			iteration: 0,
			requestStartedAt: 0,
			visibleOutput: false,
			turns: 0,
			hitLimit: false,
			didCompact: false,
			reply: undefined,
			fatal: undefined,
		};
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

		const agent = new Agent({
			// The request itself is rebuilt from the session in prepareRequest.
			initialState: { model, thinkingLevel: config.thinking, tools },
			streamFn: (m, c, o) => models.streamSimple(m, c, { ...o, maxTokens: config.maxOutputTokens, maxRetries: 0 }),
			sessionId: session.id,
			toolExecution: "parallel",
			prepareRequest: async (_request, signal) => {
				try {
					return { context: { messages: await this.#request(session, state, emitter, fixedTokens, declarations, signal), tools } };
				} catch (error) {
					state.fatal = error;
					throw error;
				}
			},
			beforeToolCall: ({ toolCall, args }, signal) => this.#approve(run, emitter, toolCall.id, toolCall.name, args as Record<string, unknown>, signal),
			finishTurn: (turn) => {
				state.turns += 1;
				if (state.turns >= config.maxIterations && toolCalls(turn.message).length > 0) {
					state.hitLimit = true;
					return { action: "end" };
				}
				return undefined;
			},
		});
		run.agent = agent;
		agent.subscribe((event) => this.#onAgentEvent(event, session, state, emitter));
		if (run.controller.signal.aborted) throw run.controller.signal.reason;

		await agent.prompt({ role: "user", content: input, timestamp: Date.now() });
		await this.#retryEmptyFailures(agent, state, run, emitter);

		if (run.controller.signal.aborted) throw run.controller.signal.reason;
		if (state.fatal) throw state.fatal;
		const last = agent.state.messages.at(-1);
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
			throw new Error(last.errorMessage ?? "模型调用失败。");
		}
		if (state.hitLimit) {
			store.appendMessage(session, this.#fixedReply(LIMIT_REPLY));
			emitter.emit("message.completed", { content: LIMIT_REPLY, reason: "max_iterations" });
			state.reply = LIMIT_REPLY;
		}
		if (!state.reply) throw new Error("模型返回空回复,请重试。");
		return { runId: run.runId, sessionId: session.id, reply: state.reply, didCompact: state.didCompact };
	}

	/** A reply MiniBot writes itself, not the model. */
	#fixedReply(text: string): AssistantMessage {
		const { model } = this.deps;
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	/** Build the next request from the session, compacting first when it is too big. */
	async #request(
		session: Session,
		state: TurnState,
		emitter: EventEmitter,
		fixedTokens: (now: Date) => number,
		declarations: ToolDeclaration[],
		signal: AbortSignal | undefined,
	): Promise<Message[]> {
		const { budget, compactor, context } = this.deps;
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
		state.iteration += 1;
		state.visibleOutput = false;
		state.requestStartedAt = performance.now();
		emitter.emit("model.started", {
			iteration: state.iteration,
			model: this.modelLabel,
			messages,
			tools: declarations.map((tool) => tool.name),
		});
		return messages;
	}

	/** Retry a call that failed before any output, the way the user saw it: not at all. */
	async #retryEmptyFailures(agent: Agent, state: TurnState, run: ActiveRun, emitter: EventEmitter): Promise<void> {
		const { maxRetries } = this.deps.config;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			const last = agent.state.messages.at(-1);
			if (last?.role !== "assistant" || last.stopReason !== "error") return;
			if (run.controller.signal.aborted || state.fatal || state.visibleOutput || hasOutput(last) || !isRetryableAssistantError(last)) return;
			const delayMs = 1000 * 2 ** (attempt - 1);
			emitter.emit("model.retrying", {
				iteration: state.iteration,
				attempt,
				maxRetries,
				delayMs,
				error: last.errorMessage ?? "unknown error",
			});
			try {
				await sleep(delayMs, run.controller.signal);
			} catch {
				return;
			}
			agent.state.messages = agent.state.messages.slice(0, -1);
			await agent.continue();
		}
	}

	async #approve(
		run: ActiveRun,
		emitter: EventEmitter,
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<{ block: true; reason: string } | undefined> {
		const tool = this.deps.tools.get(name);
		if (!tool?.requiresApproval) return undefined;
		const { approval } = this.deps;
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
				signal ?? run.controller.signal,
			);
		} catch {
			approved = false;
		}
		emitter.emit("approval.resolved", { approvalId, toolCallId, tool: name, approved, auto: false });
		return approved ? undefined : deny(`用户拒绝执行工具 ${name}。`);
	}

	/** Awaited by the Agent: persistence finishes before the loop moves on. */
	#onAgentEvent(event: AgentEvent, session: Session, state: TurnState, emitter: EventEmitter): void {
		const { store, tools } = this.deps;
		switch (event.type) {
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" || update.type === "thinking_delta") {
					state.visibleOutput = true;
					emitter.emit("model.delta", {
						iteration: state.iteration,
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
					store.appendMessage(session, message);
					const calls = toolCalls(message);
					const text = messageText(message);
					emitter.emit("model.completed", {
						iteration: state.iteration,
						elapsedMs: Math.round(performance.now() - state.requestStartedAt),
						usage: usageFrom(message.usage),
						output: { text, reasoning: thinkingText(message), toolCalls: calls },
					});
					if (calls.length === 0 && text.trim()) {
						state.reply = text.trim();
						emitter.emit("message.completed", { content: state.reply, reason: "answer" });
					}
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

	/** MiniBot tools as pi AgentTools: the result is the materialized envelope. */
	#agentTools(session: Session, run: ActiveRun): AgentTool[] {
		const { tools, artifacts, config } = this.deps;
		return tools.list().map((tool) => ({
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description,
			parameters: tool.parameters,
			executionMode: tool.concurrent ? "parallel" : "sequential",
			execute: async (_toolCallId, params, signal) => {
				const abortSignal = signal ?? run.controller.signal;
				let result: ToolResult;
				try {
					const output: ToolOutput = await tool.execute(params, {
						sessionId: session.id,
						runId: run.runId,
						workspace: config.workspace,
						signal: abortSignal,
					});
					result = artifacts.materialize(output, session.id);
				} catch (error) {
					result = abortSignal.aborted
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

