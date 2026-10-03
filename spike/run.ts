// Step 0 entry point: run every check and print a summary.
//
//   node run.ts            all checks
//   node run.ts --offline  skip the real DeepSeek call

import { checkAgent } from "./check-agent.ts";
import { checkDeepseek } from "./check-deepseek.ts";
import { checkRetry } from "./check-retry.ts";
import { loadMinibotEnv, summary } from "./lib.ts";

const offline = process.argv.includes("--offline");

if (!offline) {
	const env = loadMinibotEnv(new URL("../../minibot/.env", import.meta.url).pathname);
	// MiniBot talks to DeepSeek through its OpenAI-compatible settings.
	if (env.OPENAI_BASE_URL?.includes("deepseek") && env.OPENAI_API_KEY) {
		process.env.DEEPSEEK_API_KEY = env.OPENAI_API_KEY;
	}
}

console.log("── 本地检查(假模型服务器 + faux provider)──");
await checkRetry();
await checkAgent();
if (!offline) {
	console.log("\n── 真实 DeepSeek ──");
	await checkDeepseek();
}

const results = summary();
const failed = results.filter((r) => r.verdict === "FAIL");
console.log(`\n共 ${results.length} 项:通过 ${results.filter((r) => r.verdict === "PASS").length},失败 ${failed.length},仅记录 ${results.filter((r) => r.verdict === "INFO").length}`);
process.exit(failed.length > 0 ? 1 : 0);
