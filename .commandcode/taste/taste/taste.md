# Taste
- Writes requests in Japanese and expects replies in Japanese. Confidence: 0.6
- Phrases requests tersely/fragmentarily — often just a topic ("opencode向けに、command codeのAPI") with the actual goal omitted, leaving the agent to infer intent and ask a clarifying question. Confidence: 0.5
- Builds functionality incrementally, extending an existing system one service/integration at a time (e.g. PayPay/Revolut done → next Mobile Suica) and reusing established implementation patterns. Confidence: 0.55
- Works with handoff memos: expects the agent to resume from the handoff memo and continue from its "次の一手" section, and to write back a memo covering purpose / files in progress / uncommitted changes / decisions made / next step. Confidence: 0.75
- Hands off work across different AI coding harnesses: asks the agent to pick up where another tool's session left off by giving just that session ID (e.g. "opencodeのセッションから引き継いで ses_..."), expecting the agent to recover the state itself by digging into that tool's own data (session DB, logs) when no usable handoff memo remains. Confidence: 0.6
- When resuming a stale session, wants a reconciliation first — an inventory of the outstanding/unfinished work ("残件を洗い出す") cross-checked against the *current* repo state, separating still-open items from already-done ones, rather than blindly continuing the last task. Confidence: 0.55
- Treats processing time as a signal — pushes back on operations that take too long and asks for the costly work (e.g. a batch analysis) to be done once at the end instead of repeated per item. Confidence: 0.6
