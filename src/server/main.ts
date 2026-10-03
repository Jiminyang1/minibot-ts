// `minibot-server`: the web UI and its HTTP/SSE API.

import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config.ts";
import { ApprovalBroker } from "../runtime/approval.ts";
import { buildRuntime } from "../runtime/bootstrap.ts";
import { errorMessage } from "../util.ts";
import { createApp, webAssets } from "./app.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8765" } } });
	const broker = new ApprovalBroker();
	let runtime: Awaited<ReturnType<typeof buildRuntime>>;
	try {
		runtime = await buildRuntime(loadConfig(), { approval: broker.handler });
	} catch (error) {
		console.error(error instanceof ConfigError ? `配置错误: ${error.message}` : `启动失败: ${errorMessage(error)}`);
		process.exit(1);
	}
	const server = createApp(runtime, broker, await webAssets());
	server.listen(Number(values.port), values.host, () => console.log(`MiniBot web: http://${values.host}:${values.port}/`));
	const shutdown = () => {
		server.close();
		void runtime.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

await main();
