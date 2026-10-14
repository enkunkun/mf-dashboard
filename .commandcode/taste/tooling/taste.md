# Tooling

- Prefers tools/skills/MCP servers be installed scoped to a single harness/tool (e.g. Command Code only) rather than into shared global directories (e.g. `~/.agents/skills`), so they don't silently affect every harness. Confidence: 0.85
- Requires zero data retention (ZDR) to be enforced across all LLM interactions and AI tooling — both proxy/provider routing (e.g. adding an `x-cmd-zdr` header to the provider config) and the CLI's own sessions (e.g. running `cmd` with `CMD_ZDR=1`, set persistently in a sourced env file) — rather than treating it as optional, and proactively verifies it is actually active. Confidence: 0.7
- Hands off secrets/API keys by copying them to the clipboard (referred to as "pb"/pasteboard) and expecting the agent to read them via `pbpaste` and store them in a sourced secrets file, rather than pasting the value into chat. Confidence: 0.55
- Reaches for the `rea` browser-automation tool (MCP/CDP) for web scraping and login-flow automation rather than ad-hoc solutions. Confidence: 0.6
