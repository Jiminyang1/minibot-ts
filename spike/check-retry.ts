// Check 2: retry semantics against a local mock server.
// Check 5b: what pi-ai sends for a tool call that has no result.
//
// MiniBot's rule: retry transient errors, but never after the first delta
// reached the user (a silent restart would show the text twice).

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { mockProvider, report, sleep, sseChunk, sseHead, sseText, startMock, type MockServer } from "./lib.ts";

function agentFor(server: MockServer, initialMessages: any[] = []) {
	const { model, provider } = mockProvider(server.url);
	const models = createModels();
	models.setProvider(provider);
	return new Agent({
		initialState: { systemPrompt: "test", model, tools: [], messages: initialMessages },
		streamFn: (m, c, o) => models.streamSimple(m, c, { ...o, maxRetries: 2 }),
	});
}

function lastAssistant(agent: Agent): AssistantMessage {
	const message = agent.state.messages.findLast((m) => m.role === "assistant");
	if (!message) throw new Error("no assistant message");
	return message as AssistantMessage;
}

function visibleText(message: AssistantMessage): string {
	return message.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : `[tool ${b.name}]`)).join("");
}

/** MiniBot's rule, applied by our session layer after a failed run. */
function shouldRetry(message: AssistantMessage): boolean {
	return message.stopReason === "error" && visibleText(message) === "" && isRetryableAssistantError(message);
}

export async function checkRetry(): Promise<void> {
	// 2a. 503 before the stream starts, then success.
	{
		const server = await startMock(({ n, res }) => {
			if (n === 1) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "service unavailable", type: "server_error" } }));
				return;
			}
			sseText(res, "OK");
		});
		const agent = agentFor(server);
		await agent.prompt("hi");
		const message = lastAssistant(agent);
		report(
			"2a 流开始前出错(503):pi-ai 会自动重试",
			server.count() === 2 && message.stopReason === "stop" ? "PASS" : "FAIL",
			`服务器收到请求 ${server.count()} 次;最终 stopReason=${message.stopReason},文本="${visibleText(message)}"`,
		);
		await server.close();
	}

	// 2b. Two deltas reach the client, then the connection drops.
	{
		const server = await startMock(async ({ n, res }) => {
			if (n === 1) {
				sseHead(res);
				sseChunk(res, { role: "assistant", content: "Hel" });
				sseChunk(res, { content: "lo" });
				await sleep(50);
				res.destroy();
				return;
			}
			sseText(res, "SECOND");
		});
		const agent = agentFor(server);
		const deltas: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
		});
		await agent.prompt("hi");
		await sleep(300);
		const message = lastAssistant(agent);
		report(
			"2b 已输出一部分后断线:pi-ai 和 agent-core 都不自动重试",
			server.count() === 1 && message.stopReason === "error" ? "PASS" : "FAIL",
			`服务器收到请求 ${server.count()} 次;界面收到增量 ${JSON.stringify(deltas)};` +
				`stopReason=${message.stopReason};保留的半截内容="${visibleText(message)}";` +
				`errorMessage="${message.errorMessage}";MiniBot 规则判定重试=${shouldRetry(message)}`,
		);
		await server.close();
	}

	// 2c. Headers arrive, then the connection drops before any delta.
	{
		const server = await startMock(({ n, res }) => {
			if (n === 1) {
				sseHead(res);
				res.flushHeaders();
				setTimeout(() => res.destroy(), 30);
				return;
			}
			sseText(res, "OK");
		});
		const agent = agentFor(server);
		await agent.prompt("hi");
		const failed = lastAssistant(agent);
		const firstCount = server.count();
		const retry = shouldRetry(failed);
		if (retry) {
			// Drop the failed attempt from the transcript, then run again.
			agent.state.messages = agent.state.messages.slice(0, -1);
			await agent.continue();
		}
		const message = lastAssistant(agent);
		report(
			"2c 还没有任何输出就断线:pi 不重试;MiniBot 自己在会话层补一次重试可行",
			firstCount === 1 && retry && server.count() === 2 && message.stopReason === "stop" ? "PASS" : "FAIL",
			`第一次后服务器收到 ${firstCount} 次;失败消息 errorMessage="${failed.errorMessage}",` +
				`可重试=${isRetryableAssistantError(failed)};补重试后共 ${server.count()} 次,最终 stopReason=${message.stopReason},` +
				`文本="${visibleText(message)}";transcript 角色=${agent.state.messages.map((m) => m.role).join(",")}`,
		);
		await server.close();
	}

	// 5b. A tool call without a result, followed by a new user message.
	{
		const server = await startMock(({ res }) => sseText(res, "OK"));
		const orphan = fauxAssistantMessage([fauxToolCall("delete_file", { path: "a.txt" })], { stopReason: "toolUse" });
		const toolCallId = (orphan.content[0] as { id: string }).id;
		const agent = agentFor(server, [{ role: "user", content: "删掉 a.txt", timestamp: Date.now() }, orphan]);
		await agent.prompt("继续");
		const sent = server.bodies[0]?.messages ?? [];
		const toolMessage = sent.find((m: any) => m.role === "tool" && m.tool_call_id === toolCallId);
		report(
			"5b 没有结果的工具调用:pi-ai 发请求时会自动补一条工具结果",
			"INFO",
			`发出的 messages 角色=${sent.map((m: any) => m.role).join(",")};` +
				(toolMessage ? `补上的工具结果内容=${JSON.stringify(toolMessage.content)}` : "没有补工具结果"),
		);
		await server.close();
	}
}
