// Checks 3, 4, 5 run against pi-ai's in-memory faux provider (no network).
//
// 3. An approval wait inside beforeToolCall can be interrupted by abort.
// 4. A subscriber that persists messages finishes before the tool runs and
//    before the next model request.
// 5. What an interrupted tool call leaves behind, and whether the transcript
//    still works afterwards.

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { report, sleep } from "./lib.ts";

function fauxAgent(tools: AgentTool[], options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: number[] = [];
	const agent = new Agent({
		initialState: { systemPrompt: "test", model: faux.getModel(), tools },
		streamFn: (m, c, o) => {
			requests.push(performance.now());
			return models.streamSimple(m, c, o);
		},
		...options,
	});
	return { agent, faux, requests };
}

function roles(agent: Agent): string {
	return agent.state.messages
		.map((m) => (m.role === "assistant" ? `assistant(${(m as any).stopReason})` : m.role))
		.join(" → ");
}

function toolResultText(agent: Agent): string {
	const result = agent.state.messages.find((m) => m.role === "toolResult") as any;
	if (!result) return "(没有 toolResult)";
	return `isError=${result.isError} 内容=${JSON.stringify(result.content.map((c: any) => c.text ?? c.type).join(""))}`;
}

export async function checkAgent(): Promise<void> {
	// ── 3. approval wait is abortable ──────────────────────────────
	{
		let executed = false;
		let hookSawAbort = false;
		const deleteFile: AgentTool = {
			name: "delete_file",
			label: "Delete file",
			description: "Delete a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "deleted" }], details: undefined };
			},
		};
		let pendingSince = 0;
		const { agent, faux } = fauxAgent([deleteFile], {
			beforeToolCall: (_context, signal) =>
				new Promise((resolve) => {
					pendingSince = performance.now();
					// The human never answers; only abort can end this wait.
					signal?.addEventListener(
						"abort",
						() => {
							hookSawAbort = true;
							resolve({ block: true, reason: "用户取消了运行,工具没有执行。" });
						},
						{ once: true },
					);
				}),
		});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("delete_file", { path: "a.txt" })], { stopReason: "toolUse" })]);
		const run = agent.prompt("删掉 a.txt");
		while (pendingSince === 0) await sleep(5);
		await sleep(50);
		const abortedAt = performance.now();
		agent.abort();
		await run;
		await agent.waitForIdle();
		const elapsed = performance.now() - abortedAt;
		report(
			"3 等待审批时可以被取消打断",
			hookSawAbort && !executed && elapsed < 200 ? "PASS" : "FAIL",
			`钩子收到 abort=${hookSawAbort};工具执行了=${executed};从 abort 到空闲 ${elapsed.toFixed(0)}ms\n` +
				`transcript:${roles(agent)}\n工具结果:${toolResultText(agent)}`,
		);
	}

	// ── 4. persistence order ───────────────────────────────────────
	{
		const timeline: string[] = [];
		const t0 = performance.now();
		const at = () => `${(performance.now() - t0).toFixed(0)}ms`;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params: any) => {
				timeline.push(`${at()} 工具开始执行`);
				return { content: [{ type: "text", text: params.text }], details: undefined };
			},
		};
		// The streamFn logs request starts on the same timeline as the subscriber.
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const tracked = new Agent({
			initialState: { systemPrompt: "test", model: faux.getModel(), tools: [echo] },
			streamFn: (m, c, o) => {
				timeline.push(`${at()} 发出模型请求`);
				return models.streamSimple(m, c, o);
			},
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		tracked.subscribe(async (event: AgentEvent) => {
			if (event.type !== "message_end") return;
			const role = event.message.role;
			timeline.push(`${at()} 开始写盘 ${role}`);
			await sleep(150); // a slow disk
			timeline.push(`${at()} 写盘完成 ${role}`);
		});
		await tracked.prompt("echo hi");
		const index = (text: string) => timeline.findIndex((line) => line.endsWith(text));
		const assistantPersisted = timeline.findIndex((l) => l.endsWith("写盘完成 assistant"));
		const toolStarted = index("工具开始执行");
		const toolResultPersisted = index("写盘完成 toolResult");
		const secondRequest = timeline.findIndex((l, i) => l.endsWith("发出模型请求") && i > toolStarted);
		const ok = assistantPersisted < toolStarted && toolResultPersisted < secondRequest && assistantPersisted >= 0;
		report(
			"4 写盘订阅者完成之后,才执行工具、才发下一次请求",
			ok ? "PASS" : "FAIL",
			timeline.join("\n"),
		);
	}

	// ── 5. interrupted tool call ───────────────────────────────────
	{
		let toolSawAbort = false;
		const slow: AgentTool = {
			name: "slow_tool",
			label: "Slow tool",
			description: "Takes a long time",
			parameters: Type.Object({}),
			execute: (_id, _params, signal) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "finished" }], details: undefined }), 5000);
					signal?.addEventListener(
						"abort",
						() => {
							toolSawAbort = true;
							clearTimeout(timer);
							reject(new Error("aborted by user"));
						},
						{ once: true },
					);
				}),
		};
		const ends: string[] = [];
		const { agent, faux } = fauxAgent([slow]);
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "tool_execution_end") ends.push(`tool_execution_end isError=${event.isError}`);
			if (event.type === "agent_end") ends.push("agent_end");
		});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("slow_tool", {})], { stopReason: "toolUse" })]);
		const run = agent.prompt("run the slow tool");
		await sleep(100);
		agent.abort();
		await run;
		await agent.waitForIdle();
		const afterAbort = roles(agent);
		const resultText = toolResultText(agent);

		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		await agent.prompt("继续");
		const last = agent.state.messages.at(-1) as any;
		report(
			"5 运行中的工具被打断后留下什么;之后还能继续对话",
			toolSawAbort && last?.stopReason === "stop" ? "PASS" : "FAIL",
			`工具收到 abort=${toolSawAbort};事件=${ends.join(", ")}\n` +
				`打断后 transcript:${afterAbort}\n工具结果:${resultText}\n` +
				`再发一条消息后:${roles(agent)}`,
		);
	}
}
