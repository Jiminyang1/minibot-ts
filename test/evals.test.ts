import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { evaluate, formatTable, loadCases } from "../src/evals/runner.ts";
import { runCase } from "../src/evals/sandbox.ts";
import { type CaseOutput, checkValue, endToEnd, parseJudgement, resolveDate, scoreDeterministic } from "../src/evals/scoring.ts";
import { testConfig } from "./helpers.ts";

const today = new Date(2026, 9, 2); // Friday 2026-10-02

function output(partial: Partial<CaseOutput>): CaseOutput {
	return { reply: "ok", error: null, elapsedS: 1, toolCalls: [], skillsRead: [], modelCalls: 1, inputTokens: 10, outputTokens: 5, files: {}, ...partial };
}

describe("scoring", () => {
	it("resolves relative dates", () => {
		expect(resolveDate("+1d", today)).toBe("2026-10-03");
		expect(resolveDate("nextweek:wed", today)).toBe("2026-10-07");
		expect(resolveDate("nextweek:mon", new Date(2026, 9, 5))).toBe("2026-10-12");
	});

	it("checks values", () => {
		expect(checkValue("2026-10-03T15:00", { date: "+1d", time: "15:00" }, today)).toBe("");
		expect(checkValue("2026-10-03 9:00", { time: "09:00" }, today)).toBe("");
		expect(checkValue("abc", { contains: ["a", "z"] }, today)).toContain("应包含");
		expect(checkValue("mem_1", { equals: "mem_1" }, today)).toBe("");
		expect(checkValue("hello", { notContains: "hell" }, today)).toContain("不应包含");
	});

	it("scores each stage the case specifies", () => {
		const scores = scoreDeterministic(
			output({
				toolCalls: [{ name: "reminders_create", args: { title: "交周报", due_at: "2026-10-03T15:00:00" }, ok: true, code: "success", approved: true }],
				files: { "a.txt": "hi" },
			}),
			{
				skill: null,
				toolsRequired: ["reminders_create"],
				args: { reminders_create: { title: { contains: "周报" }, due_at: { date: "+1d", time: "15:00" } } },
				filesAfter: { "a.txt": { contains: "hi" } },
			},
			today,
		);
		expect(scores.map((score) => [score.name, score.value])).toEqual([
			["skill_selection", 1],
			["tool_selection", 1],
			["tool_args", 1],
			["outcome", 1],
		]);
		expect(endToEnd(scores, null).value).toBe(1);
		expect(endToEnd([{ name: "answer", value: 0.5, comment: "" }], null).value).toBe(1);
		expect(endToEnd(scores, "boom").value).toBe(0);
	});

	it("flags forbidden calls", () => {
		const [score] = scoreDeterministic(output({ toolCalls: [{ name: "exec", args: {}, ok: true, code: "success", approved: true }] }), { toolsForbidden: ["*"] }, today);
		expect(score).toMatchObject({ name: "tool_selection", value: 0 });
	});

	it("parses the judge's verdict", () => {
		expect(parseJudgement('结论: {"score": 0.5, "reason": "部分"}')).toMatchObject({ value: 0.5, comment: "部分" });
		expect(parseJudgement("no json").value).toBe(0);
	});

	it("loads the golden cases", () => {
		const cases = loadCases();
		expect(cases).toHaveLength(10);
		expect(() => loadCases(["nope"])).toThrow("未知用例");
		expect(JSON.stringify(cases)).not.toContain("mcp__");
	});
});

describe("sandbox", () => {
	it("runs a case with stand-in tools and seeded files", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 4_000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("reminders_create", { title: "交周报", due_at: "2026-10-03T15:00" }), fauxToolCall("read_file", { path: "notes.txt" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已创建提醒。"),
			fauxAssistantMessage('{"score": 1, "reason": "好"}'),
		]);
		const config = testConfig();
		const result = await runCase(
			{ prompt: "明天下午三点提醒我交周报", files: { "notes.txt": "笔记" }, toolResults: { reminders_create: { sequence: [{ error: "Application isn’t running (-600)" }] } } },
			config,
			models,
		);
		expect(result.error).toBeNull();
		expect(result.reply).toBe("已创建提醒。");
		expect(result.toolCalls.map((call) => [call.name, call.code])).toEqual([
			["reminders_create", "error"],
			["read_file", "success"],
		]);
		expect(result.files).toEqual({ "notes.txt": "笔记" });

		const scores = await evaluate(result, { prompt: "p" }, { toolsRequired: ["reminders_create"], answerRubric: "确认" }, { models, model: faux.getModel() }, today);
		expect(scores.find((score) => score.name === "answer")?.value).toBe(1);
		const table = formatTable([{ case: "demo", output: result, scores: Object.fromEntries(scores.map((score) => [score.name, score])) }]);
		expect(table).toContain("demo");
	});
});
