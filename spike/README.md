# Step 0: verification of pi-ai + pi-agent-core

Date: 2026-10-02. Packages: `@earendil-works/pi-ai@1.0.0`, `@earendil-works/pi-agent-core@1.0.0`. Node 24 (runs `.ts` directly).

## Run

```bash
npm install
node run.ts            # all checks, including the real DeepSeek call
node run.ts --offline  # local checks only
```

The real check reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from `../../minibot/.env`. It sets `DEEPSEEK_API_KEY` only in this process.

## Files

| File | Checks |
|---|---|
| `check-deepseek.ts` | 1. Real DeepSeek: streaming, tool call, `reasoning_content` passback, cache hits |
| `check-retry.ts` | 2. Retry behavior (local mock server). 5b. Request for a tool call without a result |
| `check-agent.ts` | 3. Abortable approval wait. 4. Persistence order. 5. Interrupted tool call (faux provider) |
| `lib.ts` | Reporter, mock OpenAI-compatible server, mock provider |

## Results

All 10 checks pass. One check (5b) is information only.

| # | Result |
|---|---|
| 1a | Text and reasoning deltas arrive. |
| 1b | A tool call round trip works. |
| 1c | The `reasoning_content` of the tool-call reply goes back in the next request. |
| 1d | Cache hits are reported (`usage.cacheRead`). Request 2: 2176 of 2282 input tokens from cache. |
| 2a | An error before the stream starts (503): pi-ai retries by itself (`maxRetries`). |
| 2b | An error after deltas arrived: no retry. The partial text stays in the message. |
| 2c | An error before any delta: pi does not retry. Our session layer can drop the failed message and call `agent.continue()`. |
| 3 | `beforeToolCall` receives the abort signal. The approval wait ends in about 1 ms. The tool does not run. |
| 4 | `Agent` awaits each subscriber. A persisting subscriber finishes before the tool runs and before the next request. |
| 5 | An aborted tool gets a `toolResult` with `isError: true` and the thrown error text. The conversation continues after that. |
| 5b | For a tool call without a result, pi-ai inserts a tool message "No result provided". |

## Design consequences for MiniBot TS

1. **Retry.** Keep MiniBot's rule in the session layer: retry only when the failed reply has no visible output. Use `isRetryableAssistantError` from `pi-ai/utils/retry` to classify.
2. **Persistence.** Persist inside an `Agent` subscriber. Emit the MiniBot `RuntimeEvent` after the write. This keeps "persist first, then emit".
3. **Interrupted tools.** The tool wrapper turns an abort into MiniBot's `interrupted` result (effect unknown). The read-time projection stays for crashes; otherwise pi-ai inserts its own "No result provided".
4. **Abort leaves an extra message.** After an abort, `Agent` appends an empty assistant message with `stopReason: "error"` (not `"aborted"`) and `errorMessage: "This operation was aborted"`. pi-ai skips it in requests. MiniBot must not persist it, and must detect cancellation from its own abort flag, not from `stopReason`.
5. **Usage.** pi-ai `usage.input` excludes cached tokens. MiniBot `input_tokens` = `input + cacheRead + cacheWrite`. MiniBot `cached_input_tokens` = `cacheRead`.
6. **Defaults to override.** pi-ai sends `max_tokens` = the model maximum (384000). Pass MiniBot's `MINIBOT_MAX_OUTPUT_TOKENS` instead. On DeepSeek, `thinkingLevel: "medium"` becomes `reasoning_effort: "high"`.
7. **Model catalog.** pi-ai lists `deepseek-v4-pro` with a 1,000,000-token window and 384,000 output tokens. MiniBot's catalog says 1,048,576 and 393,216. Use pi-ai's catalog; keep MiniBot's env overrides.
