// Line REPL: the fallback when stdin is not a terminal, or with --plain.
// Replies stream as they arrive; Ctrl+C cancels a running turn.

import { createInterface } from "node:readline";
import type { ApprovalHandler } from "../runtime/approval.ts";
import type { Runtime } from "../runtime/bootstrap.ts";
import type { RuntimeEvent } from "../runtime/events.ts";
import { makeRunId, RunCancelledError } from "../runtime/agent-session.ts";
import { errorMessage } from "../util.ts";
import { COMMANDS, isCommand, type Notice, runCommand } from "./commands.ts";
import { approvalQuestion, describeArgs, describeResult, describeUsage } from "./format.ts";
import { colorEnabled, type Paint, painter } from "./style.ts";

export interface ReplOptions {
	verbose: boolean;
}

class Printer {
	readonly paint: Paint;
	readonly #out: NodeJS.WriteStream;
	readonly #interactive: boolean;
	readonly #verbose: boolean;
	/** A streamed line is open (no trailing newline yet). */
	#open = false;
	#status = false;
	#streamed = new Set<number>();
	#reasoningShown = new Set<number>();

	constructor(out: NodeJS.WriteStream, verbose: boolean) {
		this.#out = out;
		this.paint = painter(colorEnabled(out));
		this.#interactive = Boolean(out.isTTY);
		this.#verbose = verbose;
	}

	line(text = ""): void {
		this.#settle();
		this.#out.write(`${text}\n`);
	}

	notice(notice: Notice): void {
		const color = notice.kind === "success" ? "green" : notice.kind === "warning" ? "yellow" : notice.kind === "error" ? "red" : "gray";
		this.line(this.paint(`  ${notice.title}`, color));
		if (notice.body) this.line(notice.body.split("\n").map((row) => `    ${row}`).join("\n"));
	}

	/** A transient line, replaced by the next output. Terminals only. */
	status(text: string): void {
		if (!this.#interactive) return;
		this.#closeStream();
		this.#out.write(`\r\x1b[K${this.paint(text, "dim")}`);
		this.#status = true;
	}

	event(event: RuntimeEvent): void {
		switch (event.type) {
			case "model.delta": {
				const { iteration, channel, text } = event.payload;
				if (channel === "reasoning") {
					if (this.#verbose) this.#stream(this.paint(text, "dim"));
					else if (!this.#reasoningShown.has(iteration)) {
						this.#reasoningShown.add(iteration);
						this.status("  ✻ 思考中…");
					}
					return;
				}
				if (!this.#streamed.has(iteration)) {
					this.#streamed.add(iteration);
					this.#clearStatus();
					this.#closeStream();
				}
				this.#stream(text);
				return;
			}
			case "model.started":
				if (this.#verbose) this.line(this.paint(`  ↳ 第 ${event.payload.iteration} 次模型请求`, "gray"));
				else this.status("  ✻ 等待模型…");
				return;
			case "model.completed":
				if (this.#verbose) this.line(this.paint(`  ↳ ${describeUsage(event.payload.usage, event.payload.elapsedMs)}`, "gray"));
				else this.#clearStatus();
				return;
			case "model.retrying":
				this.line(this.paint(`  模型调用失败,${event.payload.delayMs / 1000}s 后重试(${event.payload.attempt}/${event.payload.maxRetries}): ${event.payload.error}`, "yellow"));
				return;
			case "tool.started":
				this.line(`${this.paint("  ⏺", "cyan")} ${this.paint(event.payload.label, "bold")} ${this.paint(describeArgs(event.payload.tool, event.payload.args), "gray")}`);
				return;
			case "tool.completed":
			case "tool.failed": {
				const failed = event.type === "tool.failed";
				this.line(this.paint(`    ⎿ ${describeResult(event.payload.result)}`, failed ? "red" : "gray"));
				return;
			}
			case "approval.resolved":
				if (event.payload.auto) this.line(this.paint(`    ${event.payload.approved ? "已自动批准" : "没有审批渠道,已拒绝"}`, "gray"));
				return;
			case "context.compacted":
				this.line(this.paint(`  ${event.payload.message}`, "yellow"));
				return;
			case "message.completed":
				if (!this.#streamed.size || event.payload.reason === "max_iterations") this.line(event.payload.content);
				this.#closeStream();
				return;
			case "run.failed":
				this.line(this.paint(`  运行失败: ${event.payload.message}`, "red"));
				return;
			case "run.cancelled":
				this.line(this.paint("  已取消。", "yellow"));
				return;
			case "run.completed":
				this.#settle();
				this.#streamed.clear();
				this.#reasoningShown.clear();
				return;
			default:
				return;
		}
	}

	#stream(text: string): void {
		this.#out.write(text);
		this.#open = !text.endsWith("\n");
	}

	#closeStream(): void {
		if (this.#open) {
			this.#out.write("\n");
			this.#open = false;
		}
	}

	#clearStatus(): void {
		if (this.#status) {
			this.#out.write("\r\x1b[K");
			this.#status = false;
		}
	}

	#settle(): void {
		this.#clearStatus();
		this.#closeStream();
	}
}

/** Lines from stdin; while an approval waits, the next line answers it. */
class LineQueue {
	readonly #lines: string[] = [];
	#wake: (() => void) | undefined;
	#closed = false;
	#answer: ((line: string) => void) | undefined;

	push(line: string): void {
		if (this.#answer) {
			const answer = this.#answer;
			this.#answer = undefined;
			answer(line);
			return;
		}
		this.#lines.push(line);
		this.#wake?.();
	}

	close(): void {
		this.#closed = true;
		this.#answer?.("");
		this.#wake?.();
	}

	async next(): Promise<string | undefined> {
		while (this.#lines.length === 0) {
			if (this.#closed) return undefined;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
			this.#wake = undefined;
		}
		return this.#lines.shift();
	}

	answer(signal: AbortSignal): Promise<string> {
		return new Promise((resolve) => {
			if (this.#closed || signal.aborted) {
				resolve("");
				return;
			}
			const onAbort = () => {
				this.#answer = undefined;
				resolve("");
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#answer = (line) => {
				signal.removeEventListener("abort", onAbort);
				resolve(line);
			};
		});
	}
}

function askApproval(queue: LineQueue, printer: Printer, out: NodeJS.WriteStream): ApprovalHandler {
	return async (request, signal) => {
		printer.line();
		out.write(printer.paint(`  ${approvalQuestion(request.tool, request.args)} [y/N] `, "yellow"));
		return /^y(es)?$/i.test((await queue.answer(signal)).trim());
	};
}

export async function runRepl(runtime: Runtime, options: ReplOptions): Promise<void> {
	const printer = new Printer(process.stdout, options.verbose);
	const interactive = Boolean(process.stdin.isTTY);
	const completions = [...COMMANDS.map((command) => `/${command.name}`), "exit"];
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: interactive,
		completer: (line: string) => {
			const hits = completions.filter((item) => item.startsWith(line));
			return [hits.length ? hits : completions, line];
		},
	});
	const queue = new LineQueue();
	rl.on("line", (line) => queue.push(line));
	rl.on("close", () => queue.close());
	runtime.approval.handler = askApproval(queue, printer, process.stdout);

	const { session, resumed } = runtime.store.startup();
	let sessionId = session.id;
	const { paint } = printer;
	printer.line(
		`${paint("MiniBot", "bold", "magenta")} ${paint(`${runtime.model.provider}/${runtime.model.id}`, "gray")} ${paint(sessionId, "cyan")} ${paint(resumed ? "resumed" : "new", "gray")} ${paint(`approval ${runtime.approval.mode}`, "gray")}`,
	);
	if (interactive) printer.line(paint("Tab 补全命令 · /help 查看命令 · Ctrl+C 取消运行 · Ctrl+D 退出", "gray"));
	if (options.verbose) for (const note of runtime.notes) printer.line(paint(`  ${note}`, "gray"));

	let runningId: string | undefined;
	rl.on("SIGINT", () => {
		if (runningId) runtime.session.abort(runningId);
		else {
			printer.line(paint("  (Ctrl+D 或 exit 退出)", "gray"));
			rl.prompt();
		}
	});

	const prompt = () => {
		if (interactive) {
			rl.setPrompt(paint("\n› ", "bold", "cyan"));
			rl.prompt();
		}
	};
	prompt();
	for (;;) {
		const line = await queue.next();
		if (line === undefined) break;
		const input = line.trim();
		if (!input) {
			prompt();
			continue;
		}
		if (isCommand(input)) {
			const result = await runCommand(input, sessionId, runtime);
			for (const notice of result.notices) printer.notice(notice);
			sessionId = result.sessionId;
			if (result.exit) break;
			prompt();
			continue;
		}
		const runId = makeRunId();
		runningId = runId;
		try {
			await runtime.session.prompt(sessionId, input, { source: "cli", runId, onEvent: (event) => printer.event(event) });
		} catch (error) {
			if (!(error instanceof RunCancelledError) && !printerShowedFailure(error)) printer.line(paint(`  ${errorMessage(error)}`, "red"));
		} finally {
			runningId = undefined;
		}
		prompt();
	}
	rl.close();
}

/** Failures inside a run already arrived as run.failed; only setup errors need printing. */
function printerShowedFailure(error: unknown): boolean {
	return error instanceof Error && error.name !== "SessionBusyError" && error.name !== "SessionNotFoundError";
}
