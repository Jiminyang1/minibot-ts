// Public web access: search (DuckDuckGo HTML results) and page reading
// (Jina reader for public hosts, direct fetch with HTML extraction otherwise).

import { isIP } from "node:net";
import { Type } from "typebox";
import { errorMessage } from "../util.ts";
import { failure, success, type ToolOutput } from "./result.ts";
import { defineTool, type Tool } from "./tool.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 1024 * 1024;

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function collapse(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ");
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

// ── web_search ────────────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
	const pattern =
		/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(pattern)) {
		const url = resultUrl(match[1]);
		if (!url || seen.has(url)) continue;
		const title = clip(collapse(decodeEntities(match[2].replace(/<[^>]+>/g, ""))), 160);
		if (!title) continue;
		seen.add(url);
		results.push({ title, url, snippet: clip(collapse(decodeEntities(match[3].replace(/<[^>]+>/g, ""))), 280) });
	}
	return results;
}

function resultUrl(raw: string): string | undefined {
	let href = decodeEntities(raw).trim();
	if (href.startsWith("//")) href = `https:${href}`;
	if (href.startsWith("/")) href = `https://html.duckduckgo.com${href}`;
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return undefined;
	}
	if (url.hostname.endsWith("duckduckgo.com")) {
		const target = url.searchParams.get("uddg");
		return target ? resultUrl(target) : undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname.endsWith("bing.com") && url.pathname.startsWith("/aclick")) return undefined;
	return url.toString();
}

function domainMatches(url: string, domains: string[]): boolean {
	const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export const webSearchTool: Tool = defineTool({
	name: "web_search",
	description: "搜索公开互联网并返回结果标题、摘要和链接。适合查询最新信息、新闻、公开网页和外部资料入口。",
	parameters: Type.Object({
		query: Type.String({ description: "要搜索的关键词或问题。" }),
		max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "最多返回多少条结果,默认 5,最大 8。" })),
		allowed_domains: Type.Optional(
			Type.Array(Type.String(), { description: "可选,只保留这些域名下的结果,例如 ['openai.com', 'reuters.com']。" }),
		),
	}),
	async execute(args, context): Promise<ToolOutput> {
		const query = collapse(args.query);
		if (!query) return failure("invalid_args", "搜索失败: query 不能为空。");
		const domains = (args.allowed_domains ?? [])
			.map((domain) => collapse(domain).toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""))
			.filter(Boolean);
		let html: string;
		try {
			const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
				headers: { "User-Agent": USER_AGENT },
				signal: requestSignal(context.signal),
			});
			html = await response.text();
		} catch (error) {
			if (context.signal.aborted) throw context.signal.reason;
			return failure("error", `搜索失败: ${errorMessage(error)}`, { data: { query } });
		}
		let results = parseDuckDuckGo(html);
		if (domains.length > 0) results = results.filter((item) => domainMatches(item.url, domains));
		if (results.length === 0) {
			return failure("not_found", "未找到匹配结果。", { data: { query, allowed_domains: domains, results: [] } });
		}
		const selected = results.slice(0, args.max_results ?? 5);
		return success(`找到 ${selected.length} 条网页结果。`, { data: { query, allowed_domains: domains, results: selected } });
	},
});

// ── fetch_url ─────────────────────────────────────────────────────

interface Page {
	finalUrl: string;
	status: number;
	contentType: string;
	text: string;
	title: string;
	extractor: string;
	byteTruncated: boolean;
}

async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
	const buffer = new Uint8Array(await response.arrayBuffer());
	const truncated = buffer.length > MAX_BYTES;
	return { text: new TextDecoder().decode(truncated ? buffer.slice(0, MAX_BYTES) : buffer), truncated };
}

/** Jina only reaches public hosts; never hand it a private address. */
function isPublicHost(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return false;
	if (isIP(host) === 0) return true;
	return !/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/.test(host);
}

async function viaJina(url: URL, signal: AbortSignal): Promise<Page | undefined> {
	if (!isPublicHost(url)) return undefined;
	try {
		const response = await fetch(`https://r.jina.ai/${url}`, {
			headers: { "User-Agent": USER_AGENT, Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1" },
			signal: requestSignal(signal),
		});
		if (!response.ok) return undefined;
		const { text, truncated } = await readLimited(response);
		let body = text.trim();
		let title = "";
		let finalUrl = url.toString();
		const marker = body.indexOf("Markdown Content:");
		if (marker >= 0) {
			const header = body.slice(0, marker);
			body = body.slice(marker + "Markdown Content:".length).trim();
			title = /^Title:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? "";
			finalUrl = /^URL Source:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? finalUrl;
		}
		if (!body) return undefined;
		return { finalUrl, status: response.status, contentType: "text/markdown", text: body, title, extractor: "jina", byteTruncated: truncated };
	} catch {
		if (signal.aborted) throw signal.reason;
		return undefined;
	}
}

const SKIP_BLOCKS = /<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|menu)\b[\s\S]*?<\/\1>/gi;
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|h[1-6]|section|article|main|header|blockquote|figcaption)\b[^>]*>/gi;

export function htmlToText(html: string): { title: string; text: string } {
	const title = collapse(decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
	const text = decodeEntities(html.replace(SKIP_BLOCKS, " ").replace(BLOCK_TAGS, "\n").replace(/<[^>]+>/g, " "))
		.split("\n")
		.map(collapse)
		.filter(Boolean)
		.join("\n");
	return { title, text };
}

async function direct(url: URL, signal: AbortSignal): Promise<Page> {
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1" },
		signal: requestSignal(signal),
	});
	const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!["text/html", "application/xhtml+xml", "text/plain", "application/json"].includes(contentType)) {
		throw new Error(`不支持的内容类型 ${contentType || "unknown"}`);
	}
	const { text, truncated } = await readLimited(response);
	let body = text;
	let title = "";
	let extractor = "text";
	if (contentType === "text/html" || contentType === "application/xhtml+xml") {
		({ title, text: body } = htmlToText(text));
		extractor = "html";
	} else if (contentType === "application/json") {
		try {
			body = JSON.stringify(JSON.parse(text), null, 2);
			extractor = "json";
		} catch {
			// Keep the raw text.
		}
	}
	body = body.trim();
	if (!body) throw new Error("抓取成功,但没有提取到可读正文");
	return { finalUrl: response.url, status: response.status, contentType, text: body, title, extractor, byteTruncated: truncated };
}

export const fetchUrlTool: Tool = defineTool({
	name: "fetch_url",
	description: "抓取公开网页并提取可读正文、标题和链接。适合在 `web_search` 找到候选链接后继续深入阅读页面内容。",
	parameters: Type.Object({ url: Type.String({ description: "要抓取的公开网页 URL。" }) }),
	async execute(args, context): Promise<ToolOutput> {
		let url: URL;
		try {
			url = new URL(args.url.trim());
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
		} catch {
			return failure("invalid_args", "抓取失败: 请输入有效的 http/https URL。", { data: { url: args.url } });
		}
		let page: Page;
		try {
			page = (await viaJina(url, context.signal)) ?? (await direct(url, context.signal));
		} catch (error) {
			if (context.signal.aborted) throw context.signal.reason;
			return failure("error", `抓取失败: ${errorMessage(error)}`, { data: { url: args.url } });
		}
		return success(`已抓取网页 ${page.finalUrl}(${page.text.length} 字符)。`, {
			data: {
				url: args.url,
				final_url: page.finalUrl,
				content_type: page.contentType,
				status_code: page.status,
				title: page.title,
				extractor: page.extractor,
				total_chars: page.text.length,
				byte_truncated: page.byteTruncated,
			},
			content: page.text,
			contentName: page.title || page.finalUrl,
			truncated: page.byteTruncated,
		});
	},
});
