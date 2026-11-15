---
name: context-lens
description: Inspect live Antigravity conversation context occupancy, 6-category context breakdown, 52-week token usage history, and estimated API cost vs subscription value without patching the client. Use when the user asks about token consumption, context window usage, cache hit rate, model cost breakdown, or wants to open the Context Lens dashboard.
---

# Context Lens

Use this skill to read server-verified token counts and context breakdowns directly from Antigravity's on-disk `transcript.jsonl` logs and read-only `conversation_summaries.db`.

## Workflow

1. **Collect Exact Telemetry**: Run the bundled reporter script (relative to this `SKILL.md` directory) using `run_command`. Pass `--conversation <id>` if the active conversation UUID is known from your context or `transcriptPath`, and append `--json` if you need structured fields to format a custom answer:

   ```bash
   node ../../scripts/report.mjs --conversation "<conversation-id>" --json
   ```

   *(If running from the workspace root instead of the skill directory, use the absolute path to `scripts/report.mjs`.)*

2. **Present the Breakdown**:
   - Report **Current Context Window** (`input_tokens + cache_read_tokens` of the latest `PLANNER_RESPONSE`), **Cache Hit Rate**, **Median Generation Speed (tok/s)**, and the **6-Category Context Breakdown** (`System/Tools`, `User Prompts`, `Assistant Replies`, `Model Thinking`, `Tool Calls/Results`, `Media`).
   - Summarize **30-Day & All-Time Token Totals**, **Per-Model Breakdown**, and **Current Month / All-Time API Reference Cost** (noting clearly that API reference costs are estimates based on public list rates and unpriced sessions are tracked separately).

3. **Surface the UI Panel Appropriately**:
   - Check `sidecarEnabled` in the `--json` output (or Markdown footer):
     - If `sidecarEnabled` is `true`, offer the native Auxiliary Pane toggle pill once:
       `[Context Lens](sidecar://context-lens/dashboard/)`
     - If `sidecarEnabled` is `false`, do **not** emit a `sidecar://` pill. Instead link to `[context-lens](customization://context-lens)` so the user can enable the `Context Lens` sidecar, or mention they can launch the standalone browser dashboard with:
       `node <plugin-dir>/sidecars/dashboard/main.mjs --standalone`
