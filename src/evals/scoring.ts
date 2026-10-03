// Score one sandboxed run against its golden expectation, stage by stage.
//
// The four core stages follow how a turn unfolds:
//   skill_selection  did it load the right skill (or correctly none)?
//   tool_selection   did it call the tools it must, and none it must not?
//   tool_args        were the arguments right (paths, dates, ids, text)?
//   answer           does the final reply meet the rubric? (model judge)
// plus outcome (files after the run) and end_to_end (every scored stage
// passed). A stage the case does not specify is skipped, so averages only
// cover what each case actually tests.
//
// A check is an object whose keys must all hold: equals, contains (string or
// list), notContains, regex, date ("+Nd" from today, or "nextweek:mon".."sun"),
// and time ("HH:MM").

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { messageText } from "../session/types.ts";

export interface Check {
	equals?: unknown;
	contains?: string | string[];
	notContains?: string | string[];
	regex?: string;
	date?: string;
	time?: string;
}

export interface Expected {
	skill?: string | null;
	toolsRequired?: string[];
	toolsForbidden?: string[];
	args?: Record<string, Record<string, Check>>;
	filesAfter?: Record<string, Check>;
	answerRubric?: string;
}

export interface ToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	ok: boolean | null;
	code: string | null;
	approved: boolean | null;
}

export interface CaseOutput {
	reply: string | null;
	error: string | null;
	elapsedS: number;
	toolCalls: ToolCallRecord[];
	skillsRead: string[];
	modelCalls: number;
	inputTokens: number;
	outputTokens: number;
	files: Record<string, string>;
}

export interface StageScore {
	name: string;
	value: number;
	comment: string;
}

const ANSWER_PASS = 0.5;
const WEEKDAYS: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "+Nd" → today + N; "nextweek:wed" → that weekday of next (Monday-start) week. */
export function resolveDate(spec: string, today: Date): string {
	const relative = /^\+(\d+)d$/.exec(spec);
	if (relative) return isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(relative[1])));
	const weekday = /^nextweek:(\w{3})$/.exec(spec);
	if (weekday && weekday[1] in WEEKDAYS) {
		const mondayOffset = (today.getDay() + 6) % 7;
		const nextMonday = today.getDate() - mondayOffset + 7;
		return isoDate(new Date(today.getFullYear(), today.getMonth(), nextMonday + WEEKDAYS[weekday[1]]));
	}
	throw new Error(`未知日期规则: ${spec}`);
}

const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Empty string when the check holds, else what went wrong. */
export function checkValue(value: unknown, check: Check, today: Date): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if ("equals" in check && JSON.stringify(value) !== JSON.stringify(check.equals)) return `应为 ${JSON.stringify(check.equals)},实际 ${JSON.stringify(value)}`;
	for (const needle of list(check.contains)) if (!text.includes(needle)) return `应包含 ${JSON.stringify(needle)},实际 ${JSON.stringify(text.slice(0, 80))}`;
	for (const needle of list(check.notContains)) if (text.includes(needle)) return `不应包含 ${JSON.stringify(needle)}`;
	if (check.regex !== undefined && !new RegExp(check.regex).test(text)) return `不匹配 ${check.regex},实际 ${JSON.stringify(text.slice(0, 80))}`;
	if (check.date !== undefined) {
		const want = resolveDate(check.date, today);
		if (/(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] !== want) return `日期应为 ${want},实际 ${JSON.stringify(text.slice(0, 40))}`;
	}
	if (check.time !== undefined) {
		const found = /(?:T|\s|^)(\d{1,2}):(\d{2})/.exec(text);
		const [hour, minute] = check.time.split(":").map(Number);
		if (!found || Number(found[1]) !== hour || Number(found[2]) !== minute) return `时间应为 ${check.time},实际 ${JSON.stringify(text.slice(0, 40))}`;
	}
	return "";
}

function checkArgs(args: Record<string, unknown>, checks: Record<string, Check>, today: Date): string {
	for (const [name, check] of Object.entries(checks)) {
		if (args[name] === undefined || args[name] === null) return `缺少参数 ${name}`;
		const failure = checkValue(args[name], check, today);
		if (failure) return `${name} ${failure}`;
	}
	return "";
}

/** Every stage except the judged answer; unspecified stages are omitted. */
export function scoreDeterministic(output: CaseOutput, expected: Expected, today: Date): StageScore[] {
	const scores: StageScore[] = [];
	const called = output.toolCalls.map((call) => call.name);

	if ("skill" in expected) {
		const read = output.skillsRead;
		const ok = expected.skill === null ? read.length === 0 : read.includes(expected.skill as string);
		const comment = expected.skill === null ? (ok ? "未读取 skill" : `不该读取却读了 ${read.join(", ")}`) : read.length ? `读取了 ${read.join(", ")}` : "没有读取任何 skill";
		scores.push({ name: "skill_selection", value: Number(ok), comment });
	}

	const required = expected.toolsRequired ?? [];
	const forbidden = expected.toolsForbidden ?? [];
	if (required.length || forbidden.length) {
		const missing = required.filter((name) => !called.includes(name));
		const violated = forbidden.includes("*") ? called : called.filter((name) => forbidden.includes(name));
		const problems = [missing.length ? `缺少 ${missing.join(", ")}` : "", violated.length ? `不该调用 ${violated.join(", ")}` : ""].filter(Boolean);
		scores.push({ name: "tool_selection", value: Number(problems.length === 0), comment: problems.join(";") || `调用了 ${called.join(", ") || "无"}` });
	}

	const argSpecs = Object.entries(expected.args ?? {});
	if (argSpecs.length) {
		let passed = 0;
		const notes: string[] = [];
		for (const [tool, checks] of argSpecs) {
			const failures = output.toolCalls.filter((call) => call.name === tool).map((call) => checkArgs(call.args, checks, today));
			if (failures.some((failure) => failure === "")) passed += 1;
			else notes.push(`${tool}: ${failures[0] ?? "未调用"}`);
		}
		scores.push({ name: "tool_args", value: passed / argSpecs.length, comment: notes.join(";") || "参数全部符合" });
	}

	const fileSpecs = Object.entries(expected.filesAfter ?? {});
	if (fileSpecs.length) {
		const notes = fileSpecs.flatMap(([path, check]) => {
			if (!(path in output.files)) return [`${path}: 文件不存在`];
			const failure = checkValue(output.files[path], check, today);
			return failure ? [`${path}: ${failure}`] : [];
		});
		scores.push({ name: "outcome", value: Number(notes.length === 0), comment: notes.join(";") || "文件状态符合" });
	}
	return scores;
}

/** Pass only when the run finished and every scored stage passed. */
export function endToEnd(scores: StageScore[], error: string | null): StageScore {
	if (error) return { name: "end_to_end", value: 0, comment: `运行失败: ${error}` };
	const failed = scores.filter((score) => score.value < (score.name === "answer" ? ANSWER_PASS : 1)).map((score) => score.name);
	return { name: "end_to_end", value: Number(failed.length === 0), comment: failed.length ? `未通过: ${failed.join(", ")}` : "全部阶段通过" };
}

const JUDGE_PROMPT =
	"你是严格的 AI 助手评测员。根据评分标准判断助手的最终回复是否合格。只依据给出的对话内容判断,不要脑补助手没说的话。" +
	'只输出一个 JSON 对象:{"score": 0 或 0.5 或 1, "reason": "一句话理由"}。1 = 完全满足标准;0.5 = 部分满足或有明显瑕疵;0 = 不满足。';

export function parseJudgement(text: string): StageScore {
	try {
		const data = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "") as { score?: unknown; reason?: unknown };
		const value = Number(data.score);
		if (!Number.isFinite(value)) throw new Error("score");
		return { name: "answer", value: Math.min(Math.max(value, 0), 1), comment: String(data.reason ?? "") };
	} catch {
		return { name: "answer", value: 0, comment: `评测员输出无法解析: ${text.slice(0, 120)}` };
	}
}

export async function judgeAnswer(models: Models, model: Model<Api>, prompt: string, output: CaseOutput, rubric: string): Promise<StageScore> {
	if (!output.reply) return { name: "answer", value: 0, comment: "没有最终回复" };
	const tools = output.toolCalls.map((call) => call.name).join(", ") || "无";
	const content = `## 用户输入\n${prompt}\n\n## 助手调用过的工具\n${tools}\n\n## 助手最终回复\n${output.reply}\n\n## 评分标准\n${rubric}`;
	const reply = await models.completeSimple(model, { systemPrompt: JUDGE_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] }, { maxTokens: 2_000 });
	if (reply.stopReason === "error") return { name: "answer", value: 0, comment: `评测员调用失败: ${reply.errorMessage}` };
	return parseJudgement(messageText(reply));
}
