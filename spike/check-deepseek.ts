// Check 1: pi-ai + pi-agent-core against the real DeepSeek endpoint.
//
// - streaming: text and reasoning deltas arrive
// - a tool call round trip works
// - reasoning_content of the tool-call reply is sent back on the next request
// - cached input tokens are reported (DeepSeek prompt_cache_hit_tokens)

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { report, sleep } from "./lib.ts";

// A long, stable system prompt so the shared prefix is big enough to cache.
const RULES = Array.from(
	{ length: 60 },
	(_, i) => `${i + 1}. 回答时保持简洁、准确;如果需要外部信息,先调用合适的工具,再根据工具结果回答,不要编造数据。`,
).join("\n");
const SYSTEM = `你是 MiniBot,一个运行在用户本机上的个人助理。\n\n工作守则:\n${RULES}`;

export async function checkDeepseek(): Promise<void> {
	if (!process.env.DEEPSEEK_API_KEY) {
		report("1 DeepSeek 真实端点", "FAIL", "没有可用的 API key");
		return;
	}
	const models = createModels();
	models.setProvider(deepseekProvider());
	const model = models.getModel("deepseek", "deepseek-v4-pro");
	if (!model) {
		report("1 DeepSeek 真实端点", "FAIL", "pi-ai 目录里没有 deepseek-v4-pro");
		return;
	}

	let toolCalls = 0;
	const getTime: AgentTool = {
		name: "get_time",
		label: "Get time",
		description: "返回指定城市的当前本地时间。",
		parameters: Type.Object({ city: Type.String({ description: "城市名" }) }),
		execute: async (_id, params: any) => {
			toolCalls += 1;
			return { content: [{ type: "text", text: `${params.city} 当前时间 2026-10-02 21:30` }], details: undefined };
		},
	};

	const payloads: any[] = [];
	const agent = new Agent({
		initialState: { systemPrompt: SYSTEM, model, thinkingLevel: "medium", tools: [getTime] },
		streamFn: (m, c, o) => models.streamSimple(m, c, { ...o, maxRetries: 2 }),
		onPayload: (payload) => {
			payloads.push(structuredClone(payload));
			return undefined;
		},
		sessionId: "minibot-spike",
	});

	const deltas = { text: 0, thinking: 0, toolcall: 0 };
	agent.subscribe((event) => {
		if (event.type !== "message_update") return;
		const kind = event.assistantMessageEvent.type;
		if (kind === "text_delta") deltas.text += 1;
		if (kind === "thinking_delta") deltas.thinking += 1;
		if (kind === "toolcall_delta") deltas.toolcall += 1;
	});

	const started = performance.now();
	await agent.prompt("请调用 get_time 工具查一下上海现在的时间,然后用一句话告诉我。");
	await sleep(1500); // give DeepSeek's prefix cache a moment
	await agent.prompt("刚才查到的时间是几点?不要再调用工具,一句话回答。");
	const seconds = ((performance.now() - started) / 1000).toFixed(1);

	const replies = agent.state.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
	const errors = replies.filter((m) => m.stopReason === "error" || m.stopReason === "aborted");
	const finalText = replies
		.at(-1)
		?.content.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("");

	report(
		"1a 流式输出:正文和思考增量都能收到",
		deltas.text > 0 && deltas.thinking > 0 ? "PASS" : "FAIL",
		`正文增量 ${deltas.text} 个,思考增量 ${deltas.thinking} 个,工具参数增量 ${deltas.toolcall} 个;共 ${replies.length} 次模型回复,用时 ${seconds}s`,
	);

	report(
		"1b 工具调用往返",
		toolCalls === 1 && errors.length === 0 ? "PASS" : "FAIL",
		`工具被调用 ${toolCalls} 次;出错回复 ${errors.length} 条${errors.length ? `(${errors[0].errorMessage})` : ""};最后回答="${finalText}"`,
	);

	// The request right after the tool call must carry back the reasoning_content
	// of the assistant message that made the call.
	const afterTool = payloads.find((p) => p.messages?.some((m: any) => m.role === "tool"));
	const callerMessage = afterTool?.messages?.find((m: any) => m.role === "assistant" && m.tool_calls?.length);
	const reasoningBack = typeof callerMessage?.reasoning_content === "string" && callerMessage.reasoning_content.length > 0;
	report(
		"1c 工具调用那条回复的 reasoning_content 被回传",
		reasoningBack ? "PASS" : "FAIL",
		`回传长度 ${callerMessage?.reasoning_content?.length ?? 0} 字符;请求里的 thinking 参数=${JSON.stringify(afterTool?.thinking)},` +
			`reasoning_effort=${JSON.stringify(afterTool?.reasoning_effort)},max_tokens=${afterTool?.max_tokens}`,
	);

	const usage = replies.map((m, i) => `#${i + 1} 输入 ${m.usage.input} 缓存命中 ${m.usage.cacheRead} 输出 ${m.usage.output}`);
	const anyCache = replies.slice(1).some((m) => m.usage.cacheRead > 0);
	report(
		"1d 缓存命中数能拿到",
		anyCache ? "PASS" : "FAIL",
		`${usage.join("\n")}\n注意:pi-ai 的 input 是否已扣除 cacheRead,要对照 MiniBot 的口径(MiniBot 的 input_tokens 含缓存部分)`,
	);
}
