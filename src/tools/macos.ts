// macOS Calendar, Reminders, Notes, and Mail through AppleScript (osascript).
//
// Each operation is one script run with `on run argv`; values travel as
// arguments, never spliced into the script. Records come back joined with
// ASCII unit (31) and record (30) separators. An app that is not running
// (-600) is opened in the background and the script runs once more.

import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Type } from "typebox";
import { failure, success, type ToolCode, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const FIELD = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);
const TIMEOUT_MS = 20_000;
/** `open` returns before the app accepts Apple events. */
const LAUNCH_SETTLE_MS = 1_000;
const execFileAsync = promisify(execFile);

const HELPERS = [
	"on pad2(n)",
	"set valueInt to n as integer",
	'if valueInt < 10 then return "0" & (valueInt as string)',
	"return valueInt as string",
	"end pad2",
	"on makeDate(y, m, d, hh, mm, ss)",
	"set dt to current date",
	"set day of dt to 1",
	"set year of dt to (y as integer)",
	"set month of dt to (m as integer)",
	"set day of dt to (d as integer)",
	"set time of dt to ((hh as integer) * hours + (mm as integer) * minutes + (ss as integer))",
	"return dt",
	"end makeDate",
	"on formatDate(dt)",
	'if dt is missing value then return ""',
	'return (year of dt as string) & "-" & pad2(month of dt as integer) & "-" & pad2(day of dt as integer) & "T" & pad2(hours of dt) & ":" & pad2(minutes of dt) & ":" & pad2(seconds of dt)',
	"end formatDate",
	"on sanitizeText(txt)",
	'if txt is missing value then return ""',
	"set normalized to txt as string",
	"set oldDelims to AppleScript's text item delimiters",
	"set AppleScript's text item delimiters to {return, linefeed, tab, (character id 31), (character id 30)}",
	"set parts to text items of normalized",
	'set AppleScript\'s text item delimiters to " "',
	"set flattened to parts as text",
	"set AppleScript's text item delimiters to oldDelims",
	"return flattened",
	"end sanitizeText",
	"on splitCommaText(rawText)",
	'if rawText is "" then return {}',
	"set oldDelims to AppleScript's text item delimiters",
	'set AppleScript\'s text item delimiters to ","',
	"set rawParts to text items of (rawText as string)",
	"set AppleScript's text item delimiters to oldDelims",
	"set cleanedParts to {}",
	"repeat with rawPart in rawParts",
	"set partText to rawPart as string",
	'if partText is not "" then set end of cleanedParts to partText',
	"end repeat",
	"return cleanedParts",
	"end splitCommaText",
	"on truncateText(txt, maxChars)",
	"set cleaned to sanitizeText(txt)",
	"if (length of cleaned) <= maxChars then return cleaned",
	"return text 1 thru maxChars of cleaned",
	"end truncateText",
	"on joinFields(fieldValues)",
	'set outputText to ""',
	"repeat with idx from 1 to (count of fieldValues)",
	"if idx > 1 then set outputText to outputText & (character id 31)",
	"set outputText to outputText & (item idx of fieldValues as string)",
	"end repeat",
	"return outputText",
	"end joinFields",
	"on joinRecords(recordValues)",
	'set outputText to ""',
	"repeat with idx from 1 to (count of recordValues)",
	"if idx > 1 then set outputText to outputText & (character id 30)",
	"set outputText to outputText & (item idx of recordValues as string)",
	"end repeat",
	"return outputText",
	"end joinRecords",
];

class ScriptError extends Error {
	code: ToolCode;
	constructor(code: ToolCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function classifyScriptError(detail: string): ToolCode {
	const lower = detail.toLowerCase();
	if (detail.includes("-1743") || lower.includes("not authorized to send apple events")) return "permission_denied";
	if (lower.includes("read-only") || lower.includes("access not allowed")) return "permission_denied";
	if (detail.includes("-1728") || lower.includes("can’t get") || lower.includes("can't get") || lower.includes("not found")) {
		return "not_found";
	}
	if (detail.includes("-1700") || detail.includes("-1703") || lower.includes("invalid mail sender")) return "invalid_args";
	return "error";
}

function osascript(lines: string[], args: string[], signal: AbortSignal): Promise<string> {
	const argv = ["-l", "AppleScript", ...[...HELPERS, ...lines].flatMap((line) => ["-e", line]), "--", ...args];
	return new Promise((resolve, reject) => {
		execFile("osascript", argv, { timeout: TIMEOUT_MS, signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			if (error) {
				if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
					reject(new ScriptError("timeout", `AppleScript 执行超过 ${TIMEOUT_MS / 1000} 秒,已终止。`));
					return;
				}
				const detail = (stderr || stdout || error.message).trim();
				reject(new ScriptError(classifyScriptError(detail), detail));
				return;
			}
			resolve(stdout.replace(/[\r\n]+$/, ""));
		});
	});
}

/** The app a failed script must launch first: its target, when the failure is -600. */
export function appToLaunch(lines: readonly string[], detail: string): string | null {
	if (!detail.includes("-600") && !/isn[’']t running/i.test(detail)) return null;
	for (const line of lines) {
		const target = /^tell application "([^"]+)"$/.exec(line)?.[1];
		if (target) return target;
	}
	return null;
}

/** Run a script. When its app is not running, open the app in the background and run the script once more. */
async function runScript(lines: string[], args: string[], signal: AbortSignal): Promise<string> {
	try {
		return await osascript(lines, args, signal);
	} catch (error) {
		const app = error instanceof ScriptError ? appToLaunch(lines, error.message) : null;
		if (!app) throw error;
		await execFileAsync("open", ["-g", "-a", app], { signal });
		await delay(LAUNCH_SETTLE_MS, undefined, { signal });
		return osascript(lines, args, signal);
	}
}

export function parseRecords<K extends string>(raw: string, fields: readonly K[]): Record<K, string>[] {
	if (!raw) return [];
	return raw
		.split(RECORD)
		.filter(Boolean)
		.map((record) => {
			const values = record.split(FIELD);
			if (values.length !== fields.length) throw new ScriptError("error", "AppleScript 返回结构无法解析。");
			return Object.fromEntries(fields.map((field, index) => [field, values[index]])) as Record<K, string>;
		});
}

function single<K extends string>(raw: string, fields: readonly K[]): Record<K, string> {
	const [first] = parseRecords(raw, fields);
	if (!first) throw new ScriptError("error", "AppleScript 未返回结果。");
	return first;
}

/** Local date-time from ISO text; zoned values are converted to local time. */
export function localDateParts(text: string, field: string): string[] {
	const value = text.trim();
	if (!/\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(value)) {
		throw new ScriptError("invalid_args", `${field} 必须是本地日期时间,例如 2026-04-18T10:30 或 2026-04-18 10:30。`);
	}
	const date = new Date(value.replace(" ", "T"));
	if (Number.isNaN(date.getTime())) throw new ScriptError("invalid_args", `${field} 格式无效: ${text}`);
	return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].map(String);
}

function requireText(value: string, field: string): string {
	const text = value.trim();
	if (!text) throw new ScriptError("invalid_args", `${field} 不能为空。`);
	return text;
}

function recipients(value: string | string[] | undefined, field: string, required: boolean): string[] {
	const list = (Array.isArray(value) ? value : value === undefined ? [] : [value])
		.flatMap((item) => item.split(","))
		.map((item) => item.trim())
		.filter(Boolean);
	if (required && list.length === 0) throw new ScriptError("invalid_args", `${field} 至少需要一个收件人地址。`);
	return list;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function notesHtml(text: string): string {
	const lines = text.split("\n");
	return lines.map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>")).join("");
}

const limitParam = Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "最多返回多少条,默认 10。" }));

/** Wrap a script call: argument problems and AppleScript failures become tool failures. */
async function attempt(run: () => Promise<ToolOutput>): Promise<ToolOutput> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ScriptError) return failure(error.code === "success" || error.code === "noop" ? "error" : error.code, error.message);
		throw error;
	}
}

const EVENT_FIELDS = ["event_id", "title", "calendar_name", "start_at", "end_at", "location", "notes"] as const;
const REMINDER_FIELDS = ["reminder_id", "title", "list_name", "completed", "due_at", "notes"] as const;
const NOTE_FIELDS = ["note_id", "title", "folder_name", "preview"] as const;
const MESSAGE_FIELDS = ["message_id", "subject", "sender", "received_at", "mailbox_name", "account_name", "read", "preview"] as const;

function reminder(row: Record<(typeof REMINDER_FIELDS)[number], string>) {
	return { ...row, completed: row.completed === "true", due_at: row.due_at || null };
}

function message(row: Record<(typeof MESSAGE_FIELDS)[number], string>) {
	return { ...row, read: row.read.trim().toLowerCase() === "true" };
}

export const macosTools: readonly Tool[] = [
	defineTool({
		name: "calendar_list_events",
		label: "日历 · 查看",
		description: "列出 macOS 日历在某个时间范围内的事件。start_at/end_at 用本地 ISO 时间。",
		parameters: Type.Object({
			start_at: Type.String({ description: "范围开始,本地 ISO 时间,例如 2026-04-20T00:00" }),
			end_at: Type.String({ description: "范围结束,本地 ISO 时间" }),
			calendar_name: Type.Optional(Type.String({ description: "只看指定日历" })),
			limit: limitParam,
		}),
		execute: (args, context) =>
			attempt(async () => {
				const start = localDateParts(args.start_at, "start_at");
				const end = localDateParts(args.end_at, "end_at");
				if (new Date(args.end_at) <= new Date(args.start_at)) throw new ScriptError("invalid_args", "end_at 必须晚于 start_at。");
				const raw = await runScript(
					[
						"on run argv",
						"set startDate to my makeDate(item 1 of argv, item 2 of argv, item 3 of argv, item 4 of argv, item 5 of argv, item 6 of argv)",
						"set endDate to my makeDate(item 7 of argv, item 8 of argv, item 9 of argv, item 10 of argv, item 11 of argv, item 12 of argv)",
						"set calendarFilter to item 13 of argv",
						'tell application "Calendar"',
						'if calendarFilter is "" then',
						"set targetCalendars to calendars",
						"else",
						"set targetCalendars to {calendar calendarFilter}",
						"end if",
						"set rows to {}",
						"repeat with targetCalendar in targetCalendars",
						"set hits to every event of targetCalendar whose start date >= startDate and start date < endDate",
						"repeat with eachEvent in hits",
						'set locationText to ""',
						"try",
						"set locationText to location of eachEvent",
						"end try",
						'set notesText to ""',
						"try",
						"set notesText to description of eachEvent",
						"end try",
						"set end of rows to my joinFields({uid of eachEvent, my sanitizeText(summary of eachEvent), my sanitizeText(name of targetCalendar), my formatDate(start date of eachEvent), my formatDate(end date of eachEvent), my sanitizeText(locationText), my sanitizeText(notesText)})",
						"end repeat",
						"end repeat",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[...start, ...end, args.calendar_name ?? ""],
					context.signal,
				);
				const events = parseRecords(raw, EVENT_FIELDS)
					.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.title.localeCompare(b.title))
					.slice(0, args.limit ?? 10);
				return success(`找到 ${events.length} 个日历事件。`, {
					data: { events, count: events.length, start_at: args.start_at, end_at: args.end_at, calendar_name: args.calendar_name ?? null },
				});
			}),
	}),
	defineTool({
		name: "calendar_create_event",
		label: "日历 · 新建",
		description: "在 macOS 日历中创建事件。必须有标题、开始和结束时间(本地 ISO 时间)。",
		requiresApproval: true,
		parameters: Type.Object({
			title: Type.String(),
			start_at: Type.String({ description: "开始,本地 ISO 时间" }),
			end_at: Type.String({ description: "结束,本地 ISO 时间,必须晚于开始" }),
			calendar_name: Type.Optional(Type.String({ description: "目标日历;不填则用第一个可写日历" })),
			location: Type.Optional(Type.String()),
			notes: Type.Optional(Type.String()),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const title = requireText(args.title, "title");
				const start = localDateParts(args.start_at, "start_at");
				const end = localDateParts(args.end_at, "end_at");
				if (new Date(args.end_at) <= new Date(args.start_at)) throw new ScriptError("invalid_args", "end_at 必须晚于 start_at。");
				const raw = await runScript(
					[
						"on run argv",
						"set eventTitle to item 1 of argv",
						"set startDate to my makeDate(item 2 of argv, item 3 of argv, item 4 of argv, item 5 of argv, item 6 of argv, item 7 of argv)",
						"set endDate to my makeDate(item 8 of argv, item 9 of argv, item 10 of argv, item 11 of argv, item 12 of argv, item 13 of argv)",
						"set calendarFilter to item 14 of argv",
						"set locationText to item 15 of argv",
						"set notesText to item 16 of argv",
						'tell application "Calendar"',
						'if calendarFilter is "" then',
						"set targetCalendar to missing value",
						"repeat with candidateCalendar in calendars",
						"try",
						"if writable of candidateCalendar then",
						"set targetCalendar to candidateCalendar",
						"exit repeat",
						"end if",
						"end try",
						"end repeat",
						'if targetCalendar is missing value then error "No writable calendar available"',
						"else",
						"set targetCalendar to calendar calendarFilter",
						'if writable of targetCalendar is false then error "Selected calendar is read-only"',
						"end if",
						"set newEvent to make new event at end of events of targetCalendar with properties {summary:eventTitle, start date:startDate, end date:endDate}",
						'if locationText is not "" then set location of newEvent to locationText',
						'if notesText is not "" then set description of newEvent to notesText',
						'set locationOut to ""',
						"try",
						"set locationOut to location of newEvent",
						"end try",
						'set notesOut to ""',
						"try",
						"set notesOut to description of newEvent",
						"end try",
						"return my joinFields({uid of newEvent, my sanitizeText(summary of newEvent), my sanitizeText(name of targetCalendar), my formatDate(start date of newEvent), my formatDate(end date of newEvent), my sanitizeText(locationOut), my sanitizeText(notesOut)})",
						"end tell",
						"end run",
					],
					[title, ...start, ...end, args.calendar_name ?? "", args.location?.trim() ?? "", args.notes?.trim() ?? ""],
					context.signal,
				);
				const event = single(raw, EVENT_FIELDS);
				return success(`已在日历「${event.calendar_name}」创建事件「${event.title}」。`, { data: event });
			}),
	}),
	defineTool({
		name: "reminders_list",
		label: "提醒事项 · 查看",
		description: "列出 macOS 提醒事项。status: open(默认)、completed 或 all。",
		parameters: Type.Object({
			list_name: Type.Optional(Type.String({ description: "只看指定列表" })),
			status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("completed"), Type.Literal("all")])),
			limit: limitParam,
		}),
		execute: (args, context) =>
			attempt(async () => {
				const status = args.status ?? "open";
				const raw = await runScript(
					[
						"on run argv",
						"set listFilter to item 1 of argv",
						"set statusFilter to item 2 of argv",
						'tell application "Reminders"',
						'if listFilter is "" then',
						"set targetLists to lists",
						"else",
						"set targetLists to {list listFilter}",
						"end if",
						"set rows to {}",
						"repeat with targetList in targetLists",
						"repeat with eachReminder in reminders of targetList",
						"set isCompleted to completed of eachReminder",
						'if statusFilter is "open" and isCompleted then',
						'else if statusFilter is "completed" and (isCompleted is false) then',
						"else",
						'set dueText to ""',
						"try",
						"set dueText to my formatDate(due date of eachReminder)",
						"end try",
						'set notesText to ""',
						"try",
						"set notesText to body of eachReminder",
						"end try",
						'set completedText to "false"',
						'if isCompleted then set completedText to "true"',
						"set end of rows to my joinFields({id of eachReminder, my sanitizeText(name of eachReminder), my sanitizeText(name of targetList), completedText, dueText, my sanitizeText(notesText)})",
						"end if",
						"end repeat",
						"end repeat",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[args.list_name ?? "", status],
					context.signal,
				);
				const reminders = parseRecords(raw, REMINDER_FIELDS)
					.map(reminder)
					.sort(
						(a, b) =>
							Number(a.completed) - Number(b.completed) ||
							(a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") ||
							a.title.localeCompare(b.title),
					)
					.slice(0, args.limit ?? 10);
				return success(`找到 ${reminders.length} 条提醒事项。`, {
					data: { reminders, count: reminders.length, list_name: args.list_name ?? null, status },
				});
			}),
	}),
	defineTool({
		name: "reminders_create",
		label: "提醒事项 · 新建",
		description: "创建 macOS 提醒事项。due_at 用本地 ISO 时间,可选。",
		requiresApproval: true,
		parameters: Type.Object({
			title: Type.String(),
			due_at: Type.Optional(Type.String({ description: "截止时间,本地 ISO 时间" })),
			list_name: Type.Optional(Type.String({ description: "目标列表;不填则用默认列表" })),
			notes: Type.Optional(Type.String()),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const title = requireText(args.title, "title");
				const due = args.due_at ? ["1", ...localDateParts(args.due_at, "due_at")] : ["0", "0", "0", "0", "0", "0", "0"];
				const raw = await runScript(
					[
						"on run argv",
						"set reminderTitle to item 1 of argv",
						"set dueFlag to item 2 of argv",
						"set listFilter to item 9 of argv",
						"set notesText to item 10 of argv",
						'tell application "Reminders"',
						'if listFilter is "" then',
						"try",
						"set targetList to first list of default account",
						"on error",
						"set targetList to first list",
						"end try",
						"else",
						"set targetList to list listFilter",
						"end if",
						"set newReminder to make new reminder at end of reminders of targetList with properties {name:reminderTitle}",
						'if dueFlag is "1" then set due date of newReminder to my makeDate(item 3 of argv, item 4 of argv, item 5 of argv, item 6 of argv, item 7 of argv, item 8 of argv)',
						'if notesText is not "" then set body of newReminder to notesText',
						'set dueText to ""',
						"try",
						"set dueText to my formatDate(due date of newReminder)",
						"end try",
						'set notesOut to ""',
						"try",
						"set notesOut to body of newReminder",
						"end try",
						'return my joinFields({id of newReminder, my sanitizeText(name of newReminder), my sanitizeText(name of targetList), "false", dueText, my sanitizeText(notesOut)})',
						"end tell",
						"end run",
					],
					[title, ...due, args.list_name ?? "", args.notes?.trim() ?? ""],
					context.signal,
				);
				const created = reminder(single(raw, REMINDER_FIELDS));
				return success(`已在列表「${created.list_name}」创建提醒「${created.title}」。`, { data: created });
			}),
	}),
	defineTool({
		name: "reminders_complete",
		label: "提醒事项 · 完成",
		description: "把一条提醒事项标记为完成。reminder_id 来自 reminders_list 的结果。",
		requiresApproval: true,
		parameters: Type.Object({ reminder_id: Type.String() }),
		execute: (args, context) =>
			attempt(async () => {
				const id = requireText(args.reminder_id, "reminder_id");
				const raw = await runScript(
					[
						"on run argv",
						"set reminderId to item 1 of argv",
						'tell application "Reminders"',
						"set targetReminder to reminder id reminderId",
						"set completed of targetReminder to true",
						'set dueText to ""',
						"try",
						"set dueText to my formatDate(due date of targetReminder)",
						"end try",
						'set notesText to ""',
						"try",
						"set notesText to body of targetReminder",
						"end try",
						'set listName to ""',
						"repeat with candidateList in lists",
						"try",
						"set matchedReminders to every reminder of candidateList whose id is reminderId",
						"if (count of matchedReminders) > 0 then",
						"set listName to name of candidateList",
						"exit repeat",
						"end if",
						"end try",
						"end repeat",
						'return my joinFields({id of targetReminder, my sanitizeText(name of targetReminder), my sanitizeText(listName), "true", dueText, my sanitizeText(notesText)})',
						"end tell",
						"end run",
					],
					[id],
					context.signal,
				);
				const done = reminder(single(raw, REMINDER_FIELDS));
				return success(`已完成提醒「${done.title}」。`, { data: done });
			}),
	}),
	defineTool({
		name: "notes_search",
		label: "备忘录 · 搜索",
		description: "按标题和正文搜索 macOS 备忘录,返回 note_id、标题、文件夹和预览。",
		parameters: Type.Object({
			query: Type.String(),
			folder_name: Type.Optional(Type.String({ description: "只搜指定文件夹" })),
			limit: limitParam,
		}),
		execute: (args, context) =>
			attempt(async () => {
				const query = requireText(args.query, "query");
				const raw = await runScript(
					[
						"on run argv",
						"set queryText to item 1 of argv",
						"set folderFilter to item 2 of argv",
						'tell application "Notes"',
						'if folderFilter is "" then',
						"set targetFolders to folders",
						"else",
						"set targetFolders to {folder folderFilter}",
						"end if",
						"set rows to {}",
						"ignoring case",
						"repeat with targetFolder in targetFolders",
						"repeat with eachNote in notes of targetFolder",
						"set noteText to plaintext of eachNote",
						"if ((name of eachNote contains queryText) or (noteText contains queryText)) then",
						"set end of rows to my joinFields({id of eachNote, my sanitizeText(name of eachNote), my sanitizeText(name of targetFolder), my truncateText(noteText, 180)})",
						"end if",
						"end repeat",
						"end repeat",
						"end ignoring",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[query, args.folder_name ?? ""],
					context.signal,
				);
				const notes = parseRecords(raw, NOTE_FIELDS)
					.sort((a, b) => a.folder_name.localeCompare(b.folder_name) || a.title.localeCompare(b.title))
					.slice(0, args.limit ?? 10);
				return success(`找到 ${notes.length} 条备忘录。`, {
					data: { notes, count: notes.length, query, folder_name: args.folder_name ?? null },
				});
			}),
	}),
	defineTool({
		name: "notes_create",
		label: "备忘录 · 新建",
		description: "新建 macOS 备忘录。不指定文件夹时写入默认文件夹。",
		requiresApproval: true,
		parameters: Type.Object({
			title: Type.String(),
			content: Type.String(),
			folder_name: Type.Optional(Type.String()),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const title = requireText(args.title, "title");
				requireText(args.content, "content");
				const raw = await runScript(
					[
						"on run argv",
						"set noteTitle to item 1 of argv",
						"set noteBody to item 2 of argv",
						"set folderFilter to item 3 of argv",
						'tell application "Notes"',
						'if folderFilter is "" then',
						"try",
						'set targetFolder to folder "Notes"',
						"on error",
						"set targetFolder to first folder",
						"end try",
						"else",
						"set targetFolder to folder folderFilter",
						"end if",
						"set newNote to make new note at targetFolder with properties {name:noteTitle, body:noteBody}",
						"return my joinFields({id of newNote, my sanitizeText(name of newNote), my sanitizeText(name of targetFolder), my truncateText(plaintext of newNote, 180)})",
						"end tell",
						"end run",
					],
					[title, notesHtml(args.content), args.folder_name ?? ""],
					context.signal,
				);
				const note = single(raw, NOTE_FIELDS);
				return success(`已在文件夹「${note.folder_name}」新建备忘录「${note.title}」。`, { data: note });
			}),
	}),
	defineTool({
		name: "notes_append",
		label: "备忘录 · 追加",
		description: "在已有备忘录末尾追加内容。note_id 来自 notes_search 的结果。",
		requiresApproval: true,
		parameters: Type.Object({ note_id: Type.String(), content: Type.String() }),
		execute: (args, context) =>
			attempt(async () => {
				const id = requireText(args.note_id, "note_id");
				requireText(args.content, "content");
				const raw = await runScript(
					[
						"on run argv",
						"set noteId to item 1 of argv",
						"set htmlFragment to item 2 of argv",
						'tell application "Notes"',
						"set targetNote to note id noteId",
						"set body of targetNote to (body of targetNote) & htmlFragment",
						'set folderName to ""',
						"repeat with candidateFolder in folders",
						"try",
						"set matchedNotes to every note of candidateFolder whose id is noteId",
						"if (count of matchedNotes) > 0 then",
						"set folderName to name of candidateFolder",
						"exit repeat",
						"end if",
						"end try",
						"end repeat",
						"return my joinFields({id of targetNote, my sanitizeText(name of targetNote), my sanitizeText(folderName), my truncateText(plaintext of targetNote, 180)})",
						"end tell",
						"end run",
					],
					[id, notesHtml(args.content)],
					context.signal,
				);
				const note = single(raw, NOTE_FIELDS);
				return success(`已追加到备忘录「${note.title}」。`, { data: note });
			}),
	}),
	defineTool({
		name: "mail_list_mailboxes",
		label: "邮件 · 邮箱列表",
		description: "列出 Mail 的账户和邮箱,含未读数和邮件数。",
		parameters: Type.Object({ account_name: Type.Optional(Type.String()), limit: limitParam }),
		execute: (args, context) =>
			attempt(async () => {
				const raw = await runScript(
					[
						"on run argv",
						"set accountFilter to item 1 of argv",
						'tell application "Mail"',
						'if accountFilter is "" then',
						"set targetAccounts to accounts",
						"else",
						"set targetAccounts to {account accountFilter}",
						"end if",
						"set rows to {}",
						"repeat with targetAccount in targetAccounts",
						"set accountName to name of targetAccount",
						"repeat with targetMailbox in mailboxes of targetAccount",
						'set unreadText to "0"',
						"try",
						"set unreadText to unread count of targetMailbox as string",
						"end try",
						'set messageCountText to "0"',
						"try",
						"set messageCountText to count of messages of targetMailbox as string",
						"end try",
						"set end of rows to my joinFields({my sanitizeText(accountName), my sanitizeText(name of targetMailbox), unreadText, messageCountText})",
						"end repeat",
						"end repeat",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[args.account_name?.trim() ?? ""],
					context.signal,
				);
				const mailboxes = parseRecords(raw, ["account_name", "mailbox_name", "unread_count", "message_count"] as const)
					.map((row) => ({ ...row, unread_count: Number(row.unread_count) || 0, message_count: Number(row.message_count) || 0 }))
					.sort((a, b) => a.account_name.localeCompare(b.account_name) || a.mailbox_name.localeCompare(b.mailbox_name))
					.slice(0, args.limit ?? 10);
				return success(`找到 ${mailboxes.length} 个邮箱。`, { data: { mailboxes, count: mailboxes.length } });
			}),
	}),
	defineTool({
		name: "mail_list_messages",
		label: "邮件 · 最近邮件",
		description: "列出最近的邮件(默认收件箱、最近 7 天)。可只看未读;days_back 传 null 表示不限日期。",
		parameters: Type.Object({
			account_name: Type.Optional(Type.String()),
			mailbox_name: Type.Optional(Type.String({ description: "默认 INBOX" })),
			limit: limitParam,
			unread_only: Type.Optional(Type.Boolean()),
			days_back: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 365 }), Type.Null()])),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const limit = args.limit ?? 10;
				const daysBack = args.days_back === undefined ? 7 : args.days_back;
				const raw = await runScript(
					[
						"on run argv",
						"set accountFilter to item 1 of argv",
						"set mailboxFilter to item 2 of argv",
						"set rowLimit to item 3 of argv as integer",
						"set unreadOnly to false",
						'if item 4 of argv is "1" then set unreadOnly to true',
						"set daysBackText to item 5 of argv",
						"set sinceDate to missing value",
						'if daysBackText is not "" then',
						"set sinceDate to (current date) - ((daysBackText as integer) * days)",
						"end if",
						'tell application "Mail"',
						'if accountFilter is "" then',
						"set targetAccounts to accounts",
						"else",
						"set targetAccounts to {account accountFilter}",
						"end if",
						"set rows to {}",
						"repeat with targetAccount in targetAccounts",
						"set accountName to name of targetAccount",
						'if mailboxFilter is "" then',
						"try",
						'set targetMailboxes to {mailbox "INBOX" of targetAccount}',
						"on error",
						"set targetMailboxes to mailboxes of targetAccount",
						"end try",
						"else",
						"set targetMailboxes to {mailbox mailboxFilter of targetAccount}",
						"end if",
						"repeat with targetMailbox in targetMailboxes",
						"set mailboxName to name of targetMailbox",
						"set targetMessages to messages of targetMailbox",
						"set messageIndex to count of targetMessages",
						"set mailboxRows to 0",
						"repeat while messageIndex >= 1 and mailboxRows < rowLimit",
						"set eachMessage to item messageIndex of targetMessages",
						'set readText to "false"',
						"try",
						"set readText to read status of eachMessage as string",
						"end try",
						"set receivedDate to missing value",
						'set receivedText to ""',
						"try",
						"set receivedDate to date received of eachMessage",
						"set receivedText to my formatDate(receivedDate)",
						"end try",
						"set shouldInclude to true",
						"if sinceDate is not missing value then",
						"if receivedDate is missing value then",
						"set shouldInclude to false",
						"else if receivedDate < sinceDate then",
						"set shouldInclude to false",
						"end if",
						"end if",
						'if unreadOnly is true and readText is "true" then set shouldInclude to false',
						"if shouldInclude then",
						'set subjectText to ""',
						"try",
						"set subjectText to subject of eachMessage",
						"end try",
						'set senderText to ""',
						"try",
						"set senderText to sender of eachMessage",
						"end try",
						'set end of rows to my joinFields({id of eachMessage as string, my sanitizeText(subjectText), my sanitizeText(senderText), receivedText, my sanitizeText(mailboxName), my sanitizeText(accountName), readText, ""})',
						"set mailboxRows to mailboxRows + 1",
						"end if",
						"set messageIndex to messageIndex - 1",
						"end repeat",
						"end repeat",
						"end repeat",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[args.account_name ?? "", args.mailbox_name ?? "", String(limit), args.unread_only ? "1" : "0", daysBack === null ? "" : String(daysBack)],
					context.signal,
				);
				const messages = parseRecords(raw, MESSAGE_FIELDS)
					.map(message)
					.sort((a, b) => b.received_at.localeCompare(a.received_at))
					.slice(0, limit);
				return success(`找到 ${messages.length} 封邮件。`, {
					data: { messages, count: messages.length, unread_only: args.unread_only ?? false, days_back: daysBack },
				});
			}),
	}),
	defineTool({
		name: "mail_search_messages",
		label: "邮件 · 搜索",
		description: "按主题和发件人搜索邮件;include_body=true 时也搜正文(较慢)。",
		parameters: Type.Object({
			query: Type.String(),
			account_name: Type.Optional(Type.String()),
			mailbox_name: Type.Optional(Type.String()),
			limit: limitParam,
			include_body: Type.Optional(Type.Boolean()),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const query = requireText(args.query, "query");
				const limit = args.limit ?? 10;
				const raw = await runScript(
					[
						"on run argv",
						"set queryText to item 1 of argv",
						"set accountFilter to item 2 of argv",
						"set mailboxFilter to item 3 of argv",
						"set rowLimit to item 4 of argv as integer",
						"set includeBody to false",
						'if item 5 of argv is "1" then set includeBody to true',
						'tell application "Mail"',
						'if accountFilter is "" then',
						"set targetAccounts to accounts",
						"else",
						"set targetAccounts to {account accountFilter}",
						"end if",
						"set rows to {}",
						"repeat with targetAccount in targetAccounts",
						"set accountName to name of targetAccount",
						'if mailboxFilter is "" then',
						"set targetMailboxes to mailboxes of targetAccount",
						"else",
						"set targetMailboxes to {mailbox mailboxFilter of targetAccount}",
						"end if",
						"repeat with targetMailbox in targetMailboxes",
						"set mailboxName to name of targetMailbox",
						"repeat with eachMessage in messages of targetMailbox",
						'set subjectText to ""',
						"try",
						"set subjectText to subject of eachMessage",
						"end try",
						'set senderText to ""',
						"try",
						"set senderText to sender of eachMessage",
						"end try",
						'set contentText to ""',
						"if includeBody then",
						"try",
						"set contentText to content of eachMessage",
						"end try",
						"end if",
						"set matchedMessage to false",
						"ignoring case",
						"if ((subjectText contains queryText) or (senderText contains queryText)) then set matchedMessage to true",
						"if includeBody is true and contentText contains queryText then set matchedMessage to true",
						"end ignoring",
						"if matchedMessage then",
						'set receivedText to ""',
						"try",
						"set receivedText to my formatDate(date received of eachMessage)",
						"end try",
						'set readText to "false"',
						"try",
						"set readText to read status of eachMessage as string",
						"end try",
						"set end of rows to my joinFields({id of eachMessage as string, my sanitizeText(subjectText), my sanitizeText(senderText), receivedText, my sanitizeText(mailboxName), my sanitizeText(accountName), readText, my truncateText(contentText, 180)})",
						"end if",
						"if (count of rows) >= rowLimit then exit repeat",
						"end repeat",
						"if (count of rows) >= rowLimit then exit repeat",
						"end repeat",
						"if (count of rows) >= rowLimit then exit repeat",
						"end repeat",
						'if (count of rows) is 0 then return ""',
						"return my joinRecords(rows)",
						"end tell",
						"end run",
					],
					[query, args.account_name ?? "", args.mailbox_name ?? "", String(limit), args.include_body ? "1" : "0"],
					context.signal,
				);
				const messages = parseRecords(raw, MESSAGE_FIELDS)
					.map(message)
					.sort((a, b) => b.received_at.localeCompare(a.received_at))
					.slice(0, limit);
				return success(`找到 ${messages.length} 封匹配的邮件。`, {
					data: { messages, count: messages.length, query, include_body: args.include_body ?? false },
				});
			}),
	}),
	defineTool({
		name: "mail_get_message",
		label: "邮件 · 读取",
		description: "读取一封邮件的正文。带上搜索结果里的 account_name 和 mailbox_name 会快很多。",
		parameters: Type.Object({
			message_id: Type.String(),
			account_name: Type.Optional(Type.String()),
			mailbox_name: Type.Optional(Type.String()),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const id = requireText(args.message_id, "message_id");
				const raw = await runScript(
					[
						"on run argv",
						"set targetId to item 1 of argv",
						"set accountFilter to item 2 of argv",
						"set mailboxFilter to item 3 of argv",
						'tell application "Mail"',
						'if accountFilter is "" then',
						"set targetAccounts to accounts",
						"else",
						"set targetAccounts to {account accountFilter}",
						"end if",
						"repeat with targetAccount in targetAccounts",
						"set accountName to name of targetAccount",
						'if mailboxFilter is "" then',
						"set targetMailboxes to mailboxes of targetAccount",
						"else",
						"set targetMailboxes to {mailbox mailboxFilter of targetAccount}",
						"end if",
						"repeat with targetMailbox in targetMailboxes",
						"set mailboxName to name of targetMailbox",
						"repeat with eachMessage in messages of targetMailbox",
						"if (id of eachMessage as string) is targetId then",
						'set subjectText to ""',
						"try",
						"set subjectText to subject of eachMessage",
						"end try",
						'set senderText to ""',
						"try",
						"set senderText to sender of eachMessage",
						"end try",
						'set receivedText to ""',
						"try",
						"set receivedText to my formatDate(date received of eachMessage)",
						"end try",
						'set readText to "false"',
						"try",
						"set readText to read status of eachMessage as string",
						"end try",
						'set bodyText to ""',
						"try",
						"set bodyText to content of eachMessage",
						"end try",
						"return my joinFields({id of eachMessage as string, my sanitizeText(subjectText), my sanitizeText(senderText), receivedText, my sanitizeText(mailboxName), my sanitizeText(accountName), readText, my truncateText(bodyText, 5000)})",
						"end if",
						"end repeat",
						"end repeat",
						"end repeat",
						'error "Mail message not found"',
						"end tell",
						"end run",
					],
					[id, args.account_name ?? "", args.mailbox_name ?? ""],
					context.signal,
				);
				const { preview: body, ...rest } = message(single(raw, MESSAGE_FIELDS));
				return success(`已读取邮件「${rest.subject}」。`, { data: { ...rest, body } });
			}),
	}),
	defineTool({
		name: "mail_create_draft",
		label: "邮件 · 草稿",
		description: "创建邮件草稿(默认在 Mail 中打开)。用户只说“帮我写一封邮件”时用草稿,不要直接发送。",
		requiresApproval: true,
		parameters: Type.Object({
			subject: Type.String(),
			body: Type.String(),
			to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			sender: Type.Optional(Type.String({ description: "Mail 里的发件人身份;不填用默认账户" })),
			visible: Type.Optional(Type.Boolean({ description: "是否在 Mail 中打开草稿窗口,默认 true" })),
		}),
		execute: (args, context) =>
			attempt(async () => {
				const fields = mailFields(args, false);
				const visible = args.visible ?? true;
				await runScript(mailScript(false, visible), fields.argv, context.signal);
				return success(`已创建邮件草稿「${fields.subject}」。`, {
					data: { subject: fields.subject, to: fields.to, cc: fields.cc, bcc: fields.bcc, visible },
				});
			}),
	}),
	defineTool({
		name: "mail_send_message",
		label: "邮件 · 发送",
		description: "直接发送邮件。发送前必须向用户确认收件人、主题和正文,确认后传 confirm_send=true。",
		requiresApproval: true,
		parameters: Type.Object({
			subject: Type.String(),
			body: Type.String(),
			to: Type.Union([Type.String(), Type.Array(Type.String())]),
			cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			sender: Type.Optional(Type.String()),
			confirm_send: Type.Boolean({ description: "必须为 true 才会发送" }),
		}),
		execute: (args, context) =>
			attempt(async () => {
				if (!args.confirm_send) throw new ScriptError("invalid_args", "confirm_send 必须为 true,才会发送邮件。");
				const fields = mailFields(args, true);
				await runScript(mailScript(true, false), fields.argv, context.signal);
				return success(`已发送邮件「${fields.subject}」。`, {
					data: { subject: fields.subject, to: fields.to, cc: fields.cc, bcc: fields.bcc, sent: true },
				});
			}),
	}),
];

function mailFields(
	args: { subject: string; body: string; to?: string | string[]; cc?: string | string[]; bcc?: string | string[]; sender?: string },
	requireTo: boolean,
) {
	const subject = requireText(args.subject, "subject");
	const body = requireText(args.body, "body");
	const to = recipients(args.to, "to", requireTo);
	const cc = recipients(args.cc, "cc", false);
	const bcc = recipients(args.bcc, "bcc", false);
	return { subject, to, cc, bcc, argv: [subject, body, to.join(","), cc.join(","), bcc.join(","), args.sender?.trim() ?? ""] };
}

function mailScript(send: boolean, visible: boolean): string[] {
	return [
		"on run argv",
		"set messageSubject to item 1 of argv",
		"set messageBody to item 2 of argv",
		"set toCsv to item 3 of argv",
		"set ccCsv to item 4 of argv",
		"set bccCsv to item 5 of argv",
		"set senderText to item 6 of argv",
		'tell application "Mail"',
		`set newMessage to make new outgoing message with properties {subject:messageSubject, content:messageBody, visible:${visible}}`,
		'if senderText is not "" then',
		"try",
		"set sender of newMessage to senderText",
		"on error senderError",
		'error "Invalid Mail sender: " & senderError',
		"end try",
		"end if",
		"tell newMessage",
		"repeat with addressText in my splitCommaText(toCsv)",
		"make new to recipient at end of to recipients with properties {address:(addressText as string)}",
		"end repeat",
		"repeat with addressText in my splitCommaText(ccCsv)",
		"make new cc recipient at end of cc recipients with properties {address:(addressText as string)}",
		"end repeat",
		"repeat with addressText in my splitCommaText(bccCsv)",
		"make new bcc recipient at end of bcc recipients with properties {address:(addressText as string)}",
		"end repeat",
		...(send ? ["send"] : []),
		"end tell",
		'return "ok"',
		"end tell",
		"end run",
	];
}
