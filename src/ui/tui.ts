// Terminal UI on pi-tui. The conversation stays in the terminal's scrollback;
// the editor and status line sit below it.
//
// Keys: Enter sends, Esc cancels a running turn, Ctrl+O shows or hides
// reasoning, Ctrl+N starts a new session, Ctrl+C clears the editor (or
// cancels, or quits), Ctrl+D quits.

import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type MarkdownTheme,
	Markdown,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type SelectListTheme,
	type SlashCommand,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { makeRunId, RunCancelledError } from "../runtime/agent-session.ts";
import type { ApprovalHandler } from "../runtime/approval.ts";
import type { Runtime } from "../runtime/bootstrap.ts";
import type { RuntimeEvent } from "../runtime/events.ts";
import { messageText, thinkingText, toolCalls } from "../session/types.ts";
import { parseToolResult } from "../tools/result.ts";
import { errorMessage } from "../util.ts";
import { COMMANDS, isCommand, type Notice, runCommand } from "./commands.ts";
import { approvalQuestion, describeArgs, describeResult, describeUsage } from "./format.ts";
import { painter } from "./style.ts";

const paint = painter(process.env.NO_COLOR === undefined);

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => paint(text, "cyan"),
	selectedText: (text) => paint(text, "bold"),
	description: (text) => paint(text, "gray"),
	scrollInfo: (text) => paint(text, "gray"),
	noMatch: (text) => paint(text, "gray"),
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => paint(text, "bold", "cyan"),
	link: (text) => paint(text, "underline"),
	linkUrl: (text) => paint(text, "gray"),
	code: (text) => paint(text, "yellow"),
	codeBlock: (text) => text,
	codeBlockBorder: (text) => paint(text, "gray"),
	quote: (text) => paint(text, "italic"),
	quoteBorder: (text) => paint(text, "gray"),
	hr: (text) => paint(text, "gray"),
	listBullet: (text) => paint(text, "cyan"),
	bold: (text) => paint(text, "bold"),
	italic: (text) => paint(text, "italic"),
	strikethrough: (text) => text,
	underline: (text) => paint(text, "underline"),
};

/** A collapsible block of reasoning text. */
class Reasoning implements Component {
	text = "";
	#view = new Text("", 1, 0);
	#expanded: () => boolean;

	constructor(expanded: () => boolean) {
		this.#expanded = expanded;
	}

	append(text: string): void {
		this.text += text;
		this.invalidate();
	}

	invalidate(): void {
		const body = this.#expanded() ? `✻ 思考\n${this.text.trim()}` : `✻ 思考 · ${this.text.length} 字(Ctrl+O 展开)`;
		this.#view.setText(paint(body, "dim"));
		this.#view.invalidate();
	}

	render(width: number): string[] {
		return this.#view.render(width);
	}
}

class ToolLine implements Component {
	#view = new Text("", 1, 0);
	#head: string;
	#tail = "";

	constructor(label: string, detail: string) {
		this.#head = `${paint("⏺", "cyan")} ${paint(label, "bold")} ${paint(detail, "gray")}`;
		this.#update();
	}

	finish(summary: string, failed: boolean): void {
		this.#tail = paint(`  ⎿ ${summary}`, failed ? "red" : "gray");
		this.#update();
	}

	note(text: string): void {
		this.#tail = paint(`  ⎿ ${text}`, "yellow");
		this.#update();
	}

	#update(): void {
		this.#view.setText(this.#tail ? `${this.#head}\n${this.#tail}` : this.#head);
	}

	invalidate(): void {
		this.#view.invalidate();
	}

	render(width: number): string[] {
		return this.#view.render(width);
	}
}

export async function runTui(runtime: Runtime, options: { verbose: boolean }): Promise<void> {
	const tui = new TuiMainScreen(new ProcessTerminal());
	const chat = new Container();
	const status = new Text("", 1, 0);
	const editor = new Editor(tui, { borderColor: (text) => paint(text, "gray"), selectList: selectTheme }, { paddingX: 1 });
	let expanded = false;
	const reasonings: Reasoning[] = [];

	const startup = runtime.store.startup();
	let sessionId = startup.session.id;
	let running: string | undefined;
	let iteration = 0;

	const add = (component: Component) => {
		chat.addChild(component);
		tui.requestRender();
	};
	const addText = (text: string) => add(new Text(text, 1, 0));
	const showNotice = (notice: Notice) => {
		const color = notice.kind === "success" ? "green" : notice.kind === "warning" ? "yellow" : notice.kind === "error" ? "red" : "gray";
		addText(paint(notice.title, color) + (notice.body ? `\n${paint(notice.body, "gray")}` : ""));
	};
	const setStatus = () => {
		const hint = running
			? paint(`● 运行中${iteration ? ` · 第 ${iteration} 次模型请求` : ""} · Esc 取消`, "yellow")
			: paint(`${runtime.model.provider}/${runtime.model.id} · ${sessionId} · approval ${runtime.approval.mode} · /help`, "gray");
		status.setText(hint);
		tui.requestRender();
	};

	const commands: SlashCommand[] = COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		getArgumentCompletions:
			command.argument === "session"
				? (prefix: string) =>
						runtime.store
							.list()
							.filter((meta) => meta.id.startsWith(prefix))
							.slice(0, 20)
							.map((meta) => ({ value: meta.id, label: meta.id, description: meta.title }))
				: command.argument === "approval"
					? () => [
							{ value: "ask", label: "ask", description: "敏感工具需要确认" },
							{ value: "always", label: "always", description: "自动批准" },
						]
					: undefined,
	}));
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, runtime.config.workspace));

	const approve: ApprovalHandler = (request, signal) =>
		new Promise((resolve) => {
			const list = new SelectList(
				[
					{ value: "yes", label: "允许", description: approvalQuestion(request.tool, request.args) },
					{ value: "no", label: "拒绝" },
				],
				2,
				selectTheme,
			);
			const handle = tui.showOverlay(list, { anchor: "bottom-center", width: "80%", offsetY: -3 });
			const finish = (approved: boolean) => {
				signal.removeEventListener("abort", onAbort);
				handle.hide();
				tui.setFocus(editor);
				tui.requestRender();
				resolve(approved);
			};
			const onAbort = () => finish(false);
			signal.addEventListener("abort", onAbort, { once: true });
			list.onSelect = (item) => finish(item.value === "yes");
			list.onCancel = () => finish(false);
			tui.setFocus(list);
			tui.requestRender();
		});
	runtime.approval.handler = approve;

	/** Per-turn rendering state. */
	let markdown: Markdown | undefined;
	let markdownText = "";
	let reasoning: Reasoning | undefined;
	const toolLines = new Map<string, ToolLine>();

	const onEvent = (event: RuntimeEvent) => {
		switch (event.type) {
			case "model.started":
				iteration = event.payload.iteration;
				markdown = undefined;
				markdownText = "";
				reasoning = undefined;
				setStatus();
				return;
			case "model.delta":
				if (event.payload.channel === "reasoning") {
					if (!reasoning) {
						reasoning = new Reasoning(() => expanded);
						reasonings.push(reasoning);
						add(reasoning);
					}
					reasoning.append(event.payload.text);
				} else {
					if (!markdown) {
						markdown = new Markdown("", 1, 0, markdownTheme);
						add(markdown);
					}
					markdownText += event.payload.text;
					markdown.setText(markdownText);
				}
				tui.requestRender();
				return;
			case "model.completed":
				if (options.verbose) addText(paint(describeUsage(event.payload.usage, event.payload.elapsedMs), "gray"));
				return;
			case "model.retrying":
				addText(paint(`模型调用失败,${event.payload.delayMs / 1000}s 后重试: ${event.payload.error}`, "yellow"));
				return;
			case "tool.started": {
				const line = new ToolLine(event.payload.label, describeArgs(event.payload.tool, event.payload.args));
				toolLines.set(event.payload.toolCallId, line);
				add(line);
				return;
			}
			case "approval.resolved":
				if (!event.payload.approved) toolLines.get(event.payload.toolCallId)?.note(event.payload.auto ? "没有审批渠道,已拒绝" : "已拒绝");
				tui.requestRender();
				return;
			case "tool.completed":
			case "tool.failed":
				toolLines.get(event.payload.toolCallId)?.finish(describeResult(event.payload.result), event.type === "tool.failed");
				tui.requestRender();
				return;
			case "context.compacted":
				addText(paint(event.payload.message, "yellow"));
				return;
			case "message.completed":
				if (!markdown || event.payload.reason === "max_iterations") add(new Markdown(event.payload.content, 1, 0, markdownTheme));
				return;
			case "run.failed":
				addText(paint(`运行失败: ${event.payload.message}`, "red"));
				return;
			case "run.cancelled":
				addText(paint("已取消。", "yellow"));
				return;
			default:
				return;
		}
	};

	const submit = async (text: string) => {
		const input = text.trim();
		if (!input) return;
		if (running) {
			editor.setText(text);
			showNotice({ kind: "warning", title: "正在运行,按 Esc 取消后再发送。" });
			return;
		}
		editor.addToHistory(input);
		if (isCommand(input)) {
			const result = await runCommand(input, sessionId, runtime);
			for (const notice of result.notices) showNotice(notice);
			if (result.sessionId !== sessionId) {
				sessionId = result.sessionId;
				renderHistory();
			}
			setStatus();
			if (result.exit) quit();
			return;
		}
		addText(`${paint("›", "cyan", "bold")} ${input}`);
		running = makeRunId();
		iteration = 0;
		toolLines.clear();
		setStatus();
		try {
			await runtime.session.prompt(sessionId, input, { source: "tui", runId: running, onEvent });
		} catch (error) {
			if (!(error instanceof RunCancelledError) && (error as Error).name.startsWith("Session")) {
				showNotice({ kind: "error", title: errorMessage(error) });
			}
		} finally {
			running = undefined;
			iteration = 0;
			setStatus();
		}
	};
	editor.onSubmit = (text) => void submit(text);

	/** Show the recent part of the current session. */
	const renderHistory = () => {
		chat.clear();
		const session = runtime.store.load(sessionId);
		if (!session) return;
		const messages = session.messages().slice(-30);
		const results = new Map<string, string>();
		for (const message of messages) {
			if (message.role === "toolResult") results.set(message.toolCallId, parseToolResult(messageText(message))?.summary ?? "");
		}
		for (const message of messages) {
			if (message.role === "user") addText(`${paint("›", "cyan", "bold")} ${messageText(message)}`);
			if (message.role !== "assistant") continue;
			const thinking = thinkingText(message);
			if (thinking) {
				const block = new Reasoning(() => expanded);
				block.append(thinking);
				reasonings.push(block);
				add(block);
			}
			for (const call of toolCalls(message)) {
				const line = new ToolLine(runtime.tools.get(call.name)?.label ?? call.name, describeArgs(call.name, call.arguments));
				line.finish(results.get(call.id) ?? "", false);
				add(line);
			}
			const text = messageText(message);
			if (text.trim()) add(new Markdown(text, 1, 0, markdownTheme));
		}
	};

	let resolveDone: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const quit = () => {
		if (running) runtime.session.abort(running);
		tui.stop();
		resolveDone();
	};

	tui.addInputListener((data) => {
		if (matchesKey(data, "escape") && running) {
			runtime.session.abort(running);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			expanded = !expanded;
			for (const block of reasonings) block.invalidate();
			tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (editor.getText()) editor.setText("");
			else if (running) runtime.session.abort(running);
			else quit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+n") && !running) {
			void submit("/new");
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !editor.getText()) {
			quit();
			return { consume: true };
		}
		return undefined;
	});

	const header = new Text(
		`${paint("MiniBot", "bold", "magenta")} ${paint(startup.resumed ? "恢复会话" : "新会话", "gray")}` +
			(options.verbose && runtime.notes.length > 0 ? `\n${paint(runtime.notes.join("\n"), "gray")}` : ""),
		1,
		0,
	);
	tui.addChild(header);
	tui.addChild(chat);
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);
	renderHistory();
	setStatus();
	tui.start();
	await done;
}
