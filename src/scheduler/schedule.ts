// Scheduled tasks (schedule.json) and the cron subset they run on.
//
// Cron expressions are evaluated in local time: "every day at 8" means the
// user's 8 o'clock. Five fields with `*`, numbers, lists, ranges, and `/step`;
// day-of-month and day-of-week combine with OR when both are restricted.
// Every task must fire, and recurring ones at most every MIN_INTERVAL_MINUTES:
// each firing is a model call.

import { isRecord, nowIso, readJsonFile, shortId, withFileLock, writeFileAtomic } from "../util.ts";

export type TaskKind = "cron" | "once" | "heartbeat";

export interface ScheduledTask {
	id: string;
	title: string;
	prompt: string;
	kind: TaskKind;
	/** Cron expression, or a local ISO timestamp for kind "once". */
	expr: string;
	enabled: boolean;
	createdAt: string;
	lastRunAt: string | null;
	lastStatus: string | null;
	/** Failed runs in a row; only the first one of a streak notifies. */
	failures: number;
	workspace: string;
	/** Heartbeat only: the session every patrol reuses. */
	sessionId: string | null;
	/** Heartbeat only: the note one patrol leaves for the next; each patrol starts from it alone. */
	scratch: string;
}

// ── cron ──────────────────────────────────────────────────────────

const BOUNDS: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
];

export interface Cron {
	minute: Set<number>;
	hour: Set<number>;
	day: Set<number>;
	month: Set<number>;
	weekday: Set<number>;
	dayAll: boolean;
	weekdayAll: boolean;
}

export function parseCron(expr: string): Cron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron 表达式必须是 5 个字段: "${expr}"`);
	const sets = fields.map((field, index) => {
		const [low, high] = BOUNDS[index];
		const values = new Set<number>();
		for (const part of field.split(",")) {
			for (const value of parsePart(part, low, high, expr)) values.add(value);
		}
		return values;
	});
	if (sets[4].delete(7)) sets[4].add(0);
	return {
		minute: sets[0],
		hour: sets[1],
		day: sets[2],
		month: sets[3],
		weekday: sets[4],
		dayAll: sets[2].size === 31,
		weekdayAll: sets[4].size === 7,
	};
}

function parsePart(part: string, low: number, high: number, expr: string): number[] {
	const [range, stepText] = part.split("/");
	const step = stepText === undefined ? 1 : Number(stepText);
	if (!Number.isInteger(step) || step < 1) throw new Error(`cron step 无效: "${expr}"`);
	let start: number;
	let end: number;
	if (range === "*") [start, end] = [low, high];
	else if (/^\d+-\d+$/.test(range)) [start, end] = range.split("-").map(Number) as [number, number];
	else if (/^\d+$/.test(range)) start = end = Number(range);
	else throw new Error(`cron 字段无效: "${expr}"`);
	if (start < low || end > high || start > end) throw new Error(`cron 字段超出范围 [${low},${high}]: "${expr}"`);
	const values: number[] = [];
	for (let value = start; value <= end; value += step) values.push(value);
	return values;
}

function dayMatches(cron: Cron, date: Date): boolean {
	const dayHit = cron.day.has(date.getDate());
	const weekdayHit = cron.weekday.has(date.getDay());
	if (cron.dayAll && cron.weekdayAll) return true;
	if (cron.dayAll) return weekdayHit;
	if (cron.weekdayAll) return dayHit;
	return dayHit || weekdayHit;
}

/** First matching minute strictly after `after`, in local time. */
export function cronNext(expr: string, after: Date): Date {
	const cron = parseCron(expr);
	const t = new Date(after);
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);
	const limit = after.getTime() + 366 * 86_400_000;
	while (t.getTime() <= limit) {
		if (!cron.month.has(t.getMonth() + 1)) {
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0);
		} else if (!dayMatches(cron, t)) {
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0);
		} else if (!cron.hour.has(t.getHours())) {
			t.setHours(t.getHours() + 1, 0);
		} else if (!cron.minute.has(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1);
		} else {
			return t;
		}
	}
	throw new Error(`一年内找不到下一次触发时间: "${expr}"`);
}

export const MIN_INTERVAL_MINUTES = 5;

/** The shortest gap between consecutive firings, over the next 50 of them. Throws when it never fires. */
export function shortestInterval(expr: string, from = new Date()): number {
	let previous = cronNext(expr, from);
	let shortest = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 50; i++) {
		const next = cronNext(expr, previous);
		shortest = Math.min(shortest, (next.getTime() - previous.getTime()) / 60_000);
		previous = next;
	}
	return shortest;
}

/** ISO timestamp; without a zone it is local time. Requires a time of day. */
function parseLocalTime(text: string): Date {
	if (!/\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(text)) throw new Error(`时间格式无效: "${text}",例如 2026-07-07T09:00`);
	const date = new Date(text.replace(" ", "T"));
	if (Number.isNaN(date.getTime())) throw new Error(`时间格式无效: "${text}"`);
	return date;
}

export function nextRun(task: ScheduledTask, now = new Date()): Date | null {
	if (!task.enabled) return null;
	if (task.kind === "once") return task.lastRunAt === null ? parseLocalTime(task.expr) : null;
	const anchor = task.lastRunAt ?? task.createdAt;
	return cronNext(task.expr, anchor ? new Date(anchor) : now);
}

/** "MM-DD HH:mm" in local time, for status lines. */
export function shortLocal(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── store ─────────────────────────────────────────────────────────

function isTask(value: unknown): value is ScheduledTask {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.prompt === "string" &&
		typeof value.expr === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.failures === "number" &&
		typeof value.scratch === "string" &&
		(value.kind === "cron" || value.kind === "once" || value.kind === "heartbeat")
	);
}

export class ScheduleStore {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	list(): ScheduledTask[] {
		const value = readJsonFile(this.#path);
		return Array.isArray(value) ? value.filter(isTask) : [];
	}

	get(id: string): ScheduledTask | undefined {
		return this.list().find((task) => task.id === id);
	}

	add(input: { title: string; prompt: string; kind: TaskKind; expr: string; workspace: string }): ScheduledTask {
		if (input.kind === "once") parseLocalTime(input.expr);
		else {
			const interval = shortestInterval(input.expr);
			if (interval < MIN_INTERVAL_MINUTES) {
				throw new Error(`"${input.expr}" 最短每 ${interval} 分钟触发一次,太频繁;至少间隔 ${MIN_INTERVAL_MINUTES} 分钟。`);
			}
		}
		const task: ScheduledTask = {
			id: shortId("t", 5),
			title: input.title.trim() || input.prompt.slice(0, 30),
			prompt: input.prompt,
			kind: input.kind,
			expr: input.expr,
			enabled: true,
			createdAt: nowIso(),
			lastRunAt: null,
			lastStatus: null,
			failures: 0,
			workspace: input.workspace,
			sessionId: null,
			scratch: "",
		};
		this.#update((tasks) => [...tasks, task]);
		return task;
	}

	remove(id: string): boolean {
		let removed = false;
		this.#update((tasks) => {
			const kept = tasks.filter((task) => task.id !== id);
			removed = kept.length !== tasks.length;
			return kept;
		});
		return removed;
	}

	/** Apply `changes` to the stored copy of a task; returns the result. */
	update(id: string, changes: Partial<Omit<ScheduledTask, "id">>): ScheduledTask | undefined {
		let updated: ScheduledTask | undefined;
		this.#update((tasks) =>
			tasks.map((task) => {
				if (task.id !== id) return task;
				updated = { ...task, ...changes };
				return updated;
			}),
		);
		return updated;
	}

	#update(change: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
		withFileLock(`${this.#path}.lock`, () => {
			writeFileAtomic(this.#path, `${JSON.stringify(change(this.list()), null, 2)}\n`);
		});
	}
}
