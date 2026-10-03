// Small helpers shared across modules: time, text, files, locks, ids.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function nowIso(): string {
	return new Date().toISOString();
}

/** Collapse whitespace and cut to `limit` characters, marking the cut. */
export function preview(text: string, limit: number): string {
	const compact = text.split(/\s+/).filter(Boolean).join(" ");
	if (compact.length <= limit) return compact;
	return limit <= 3 ? compact.slice(0, limit) : `${compact.slice(0, limit - 3)}...`;
}

export function randomSuffix(bytes: number): string {
	return randomBytes(bytes).toString("hex").slice(0, bytes * 2);
}

export function shortId(prefix: string, bytes = 6): string {
	return `${prefix}_${randomSuffix(bytes)}`;
}

/** `prefix_YYYYMMDD_HHMMSS` in local time. */
export function timestampId(prefix: string, date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `${prefix}_${day}_${time}`;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "Error";
}

/** Resolve after `ms`, or reject with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Write through a temp file and rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, text, "utf8");
	renameSync(temp, path);
}

export function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cross-process mutual exclusion for read-modify-write of one file. A lock is
 * a directory (mkdir is atomic); a lock older than 10 s is treated as left
 * behind by a crashed process.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	mkdirSync(dirname(lockPath), { recursive: true });
	for (;;) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (lockIsStale(lockPath)) {
				rmSync(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`等待文件锁超时: ${lockPath}`);
			Atomics.wait(sleeper, 0, 0, 20);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function lockIsStale(lockPath: string): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
	} catch {
		return false;
	}
}

/**
 * Rough token count: CJK characters count one each, everything else four
 * characters per token. Only used where the provider has not reported usage.
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x2e80) cjk += 1;
	}
	return cjk + Math.ceil((text.length - cjk) / 4);
}
