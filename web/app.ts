// The browser side of minibot-server: an event feed, the conversation, and
// a composer. Types are shared with the server.

import DOMPurify from "dompurify";
import { marked } from "marked";
import type { RuntimeEvent } from "../src/runtime/events.ts";
import type { MessageView, SessionView } from "../src/server/app.ts";

marked.setOptions({ breaks: true, gfm: true });

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const form = $<HTMLFormElement>("#form");
const input = $<HTMLTextAreaElement>("#input");
const sessionSelect = $<HTMLSelectElement>("#sessionSelect");
const reloadButton = $<HTMLButtonElement>("#reloadHistory");
const newButton = $<HTMLButtonElement>("#newSession");
const renameButton = $<HTMLButtonElement>("#renameSession");
const deleteButton = $<HTMLButtonElement>("#deleteSession");
const feed = $<HTMLDivElement>("#feed");
const conversation = $<HTMLDivElement>("#conversation");
const statusEl = $<HTMLDivElement>("#status");
const themeToggle = $<HTMLButtonElement>("#themeToggle");
const runTag = $<HTMLSpanElement>("#runTag");
const sessionTag = $<HTMLSpanElement>("#sessionTag");
const sendButton = $<HTMLButtonElement>("#send");

const THEME_KEY = "minibot.theme";

let activeSessionId = "current";
let currentRunId: string | null = null;
let source: EventSource | null = null;
let streaming: { row: HTMLDivElement; content: HTMLDivElement; text: string } | null = null;

function renderMarkdown(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

function clock(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function category(type: RuntimeEvent["type"]): string {
	if (type === "run.failed" || type === "tool.failed") return "fail";
	return type.split(".")[0] === "compaction" ? "context" : type.split(".")[0];
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
	return body as T;
}

function setStatus(text: string, state: "idle" | "running" | "done" | "error"): void {
	statusEl.textContent = text;
	statusEl.dataset.state = state;
}

function setSendState(state: "send" | "stop"): void {
	sendButton.dataset.state = state;
	sendButton.setAttribute("aria-label", state === "stop" ? "stop run" : "send message");
	sendButton.title = state === "stop" ? "Stop running" : "Send (⌘/Ctrl + Enter)";
	sendButton.disabled = false;
}

function applyTheme(theme: string): void {
	const resolved = theme === "light" ? "light" : "dark";
	document.documentElement.dataset.theme = resolved;
	themeToggle.textContent = resolved;
	localStorage.setItem(THEME_KEY, resolved);
}

function clearEvents(): void {
	feed.innerHTML = '<div class="empty">waiting</div>';
	runTag.textContent = "no run";
}

function setActiveSession(id: string): void {
	activeSessionId = id;
	sessionTag.textContent = id;
	sessionSelect.value = id;
	const alias = id === "current";
	renameButton.disabled = alias;
	deleteButton.disabled = alias;
}

function emptyConversation(text: string): void {
	conversation.innerHTML = "";
	const empty = document.createElement("div");
	empty.className = "empty";
	empty.textContent = text;
	conversation.append(empty);
}

function appendMessage(message: MessageView): void {
	conversation.querySelector(".empty")?.remove();
	const row = document.createElement("div");
	row.className = `message ${message.role}`;
	const meta = document.createElement("div");
	meta.className = "message-meta";
	const role = document.createElement("span");
	role.className = "message-role";
	role.textContent = message.role;
	meta.append(role);
	const time = clock(message.createdAt);
	if (time) {
		const timeEl = document.createElement("span");
		timeEl.className = "message-time";
		timeEl.textContent = time;
		meta.append(timeEl);
	}
	const content = document.createElement("div");
	content.className = "message-content";
	if (message.role === "assistant") {
		content.classList.add("markdown");
		content.innerHTML = renderMarkdown(message.text);
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "message-copy";
		copy.textContent = "copy";
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(message.text);
				copy.textContent = "copied";
				setTimeout(() => {
					copy.textContent = "copy";
				}, 1200);
			} catch {
				copy.textContent = "failed";
			}
		});
		meta.append(copy);
	} else {
		content.textContent = message.text;
	}
	row.append(meta, content);
	conversation.append(row);
	conversation.scrollTop = conversation.scrollHeight;
}

async function loadSessions(): Promise<void> {
	const payload = await json<{ currentId: string | null; sessions: SessionView[] }>("/sessions");
	sessionSelect.innerHTML = "";
	for (const session of payload.sessions) {
		const option = document.createElement("option");
		option.value = session.id;
		option.textContent = `${session.id} · ${session.title}`;
		sessionSelect.append(option);
	}
	const ids = new Set(payload.sessions.map((session) => session.id));
	setActiveSession(ids.has(activeSessionId) ? activeSessionId : (payload.currentId ?? "current"));
}

async function loadHistory(id = activeSessionId): Promise<void> {
	try {
		const payload = await json<{ session: SessionView; messages: MessageView[] }>(`/sessions/${encodeURIComponent(id)}/messages`);
		activeSessionId = payload.session.id;
		conversation.innerHTML = "";
		if (payload.messages.length === 0) emptyConversation("empty");
		for (const message of payload.messages) appendMessage(message);
		await loadSessions();
	} catch (error) {
		emptyConversation(String(error));
	}
}

function summarize(event: RuntimeEvent): string {
	switch (event.type) {
		case "run.started":
			return event.payload.input;
		case "context.usage":
			return `≈${event.payload.tokens} tokens · 压缩线 ${event.payload.compactAt}`;
		case "context.compacted":
			return event.payload.message;
		case "model.started":
			return `第 ${event.payload.iteration} 次请求`;
		case "model.completed":
			return `${event.payload.output.toolCalls.length} 个工具调用 · 输入 ${event.payload.usage.inputTokens}(缓存 ${event.payload.usage.cachedInputTokens})· 输出 ${event.payload.usage.outputTokens}`;
		case "model.retrying":
			return `${event.payload.delayMs / 1000}s 后重试: ${event.payload.error}`;
		case "compaction.completed":
			return event.payload.error ?? "摘要完成";
		case "tool.started":
			return `${event.payload.label} ${JSON.stringify(event.payload.args)}`;
		case "tool.completed":
		case "tool.failed":
			return event.payload.result.summary;
		case "approval.required":
			return `${event.payload.tool} 需要审批`;
		case "approval.resolved":
			return event.payload.approved ? "approved" : "denied";
		case "message.completed":
			return "assistant message";
		case "run.completed":
			return "done";
		case "run.cancelled":
			return "cancelled";
		case "run.failed":
			return `${event.payload.errorType}: ${event.payload.message}`;
		default:
			return "";
	}
}

function finishRun(text: string, state: "done" | "error"): void {
	streaming?.row.remove();
	streaming = null;
	setStatus(text, state);
	setSendState("send");
	currentRunId = null;
	source?.close();
	source = null;
	void loadSessions();
}

function appendDelta(text: string): void {
	conversation.querySelector(".empty")?.remove();
	if (!streaming) {
		const row = document.createElement("div");
		row.className = "message assistant streaming";
		const meta = document.createElement("div");
		meta.className = "message-meta";
		meta.innerHTML = '<span class="message-role">assistant</span>';
		const content = document.createElement("div");
		content.className = "message-content";
		row.append(meta, content);
		conversation.append(row);
		streaming = { row, content, text: "" };
	}
	streaming.text += text;
	streaming.content.textContent = streaming.text;
	conversation.scrollTop = conversation.scrollHeight;
}

function approvalActions(event: Extract<RuntimeEvent, { type: "approval.required" }>, row: HTMLDivElement): HTMLDivElement {
	const actions = document.createElement("div");
	actions.className = "approval-actions";
	const buttons = (["approve", "deny"] as const).map((label) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `small ${label}`;
		button.textContent = label;
		button.addEventListener("click", async () => {
			for (const item of buttons) item.disabled = true;
			row.classList.add("is-resolved");
			await json(`/runs/${event.runId}/approvals/${event.payload.approvalId}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ approved: label === "approve" }),
			});
		});
		return button;
	});
	actions.append(...buttons);
	return actions;
}

function onEvent(event: RuntimeEvent): void {
	if (event.type === "model.delta") {
		if (event.payload.channel === "text") appendDelta(event.payload.text);
		return;
	}
	feed.querySelector(".empty")?.remove();
	runTag.textContent = event.runId;
	setActiveSession(event.sessionId);
	const row = document.createElement("div");
	row.className = "event";
	row.dataset.category = category(event.type);
	const time = document.createElement("span");
	time.className = "event-time";
	time.textContent = clock(event.createdAt);
	const pill = document.createElement("span");
	pill.className = "event-pill";
	pill.textContent = event.type;
	const body = document.createElement("div");
	body.className = "event-body";
	const summary = document.createElement("div");
	summary.className = "event-summary";
	summary.textContent = summarize(event);
	body.append(summary);
	if (event.type === "approval.required") {
		row.classList.add("is-approval");
		body.append(approvalActions(event, row));
	}
	row.append(time, pill, body);
	feed.append(row);
	feed.scrollTop = feed.scrollHeight;

	if (event.type === "model.completed" && streaming && event.payload.output.toolCalls.length > 0) {
		// Narration before tool calls stays; the next request streams into a fresh bubble.
		streaming.row.classList.remove("streaming");
		streaming = null;
	}
	if (event.type === "message.completed") {
		// The completed text is authoritative; the streamed bubble was a preview.
		streaming?.row.remove();
		streaming = null;
		appendMessage({ role: "assistant", text: event.payload.content, createdAt: event.createdAt });
	}
	if (event.type === "run.completed") finishRun("done", "done");
	if (event.type === "run.cancelled") finishRun("cancelled", "error");
	if (event.type === "run.failed") finishRun("failed", "error");
}

function subscribe(runId: string): void {
	source?.close();
	source = new EventSource(`/runs/${encodeURIComponent(runId)}/events`);
	source.onmessage = (message) => onEvent(JSON.parse(message.data) as RuntimeEvent);
	source.onerror = () => {
		if (source?.readyState === EventSource.CLOSED && currentRunId === runId) finishRun("disconnected", "error");
	};
}

async function cancelRun(): Promise<void> {
	if (!currentRunId) return;
	sendButton.disabled = true;
	await fetch(`/runs/${encodeURIComponent(currentRunId)}/cancel`, { method: "POST" }).catch(() => {});
	sendButton.disabled = false;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (sendButton.dataset.state === "stop") {
		await cancelRun();
		return;
	}
	const text = input.value.trim();
	if (!text) return;
	clearEvents();
	appendMessage({ role: "user", text, createdAt: new Date().toISOString() });
	input.value = "";
	setSendState("stop");
	setStatus("running", "running");
	try {
		const payload = await json<{ runId: string; sessionId: string }>("/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: text, sessionId: activeSessionId }),
		});
		currentRunId = payload.runId;
		runTag.textContent = payload.runId;
		setActiveSession(payload.sessionId);
		subscribe(payload.runId);
	} catch (error) {
		finishRun(String(error), "error");
	}
});

input.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		form.requestSubmit();
	}
});

themeToggle.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
sessionSelect.addEventListener("change", () => void loadHistory(sessionSelect.value));
reloadButton.addEventListener("click", () => void loadHistory(activeSessionId));

newButton.addEventListener("click", async () => {
	try {
		const payload = await json<{ session: SessionView }>("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		clearEvents();
		setStatus("idle", "idle");
		activeSessionId = payload.session.id;
		await loadHistory(payload.session.id);
	} catch (error) {
		alert(`新建失败: ${error}`);
	}
});

renameButton.addEventListener("click", async () => {
	const id = activeSessionId;
	const current = sessionSelect.selectedOptions[0]?.textContent?.split(" · ").slice(1).join(" · ") ?? "";
	const title = prompt(`重命名会话 ${id}`, current)?.trim();
	if (!title || title === current) return;
	try {
		await json(`/sessions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
		await loadSessions();
	} catch (error) {
		alert(`重命名失败: ${error}`);
	}
});

deleteButton.addEventListener("click", async () => {
	const id = activeSessionId;
	if (!confirm(`确认删除会话 ${id}?此操作不可恢复。`)) return;
	try {
		await json(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
		clearEvents();
		setStatus("idle", "idle");
		activeSessionId = "current";
		await loadHistory("current");
	} catch (error) {
		alert(`删除失败: ${error}`);
	}
});

applyTheme(localStorage.getItem(THEME_KEY) ?? "dark");
clearEvents();
void loadHistory("current");
