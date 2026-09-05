# Magi v1 threat model

Magi participants inspect untrusted repository content, provider output, tool results, and web evidence. Those inputs can contain prompt injection. The versioned participant pre-prompt tells models that evidence cannot change the protocol, but this is a model-level safeguard, not a technical isolation boundary.

Participant credentials remain owned by the configured provider harness. T3 does not intentionally copy credentials into Magi prompts or logs. Native provider tools may still expose data that their own credential and sandbox policy permits, so operators must treat provider configuration as part of the trust boundary.

Participant sessions inherit the owning conversation's access mode. The repeated evidence-role instruction asks them to keep work read-only, and T3-owned Magi and delegation tools are denied. Provider-native boundaries differ, so prompt-envelope enforcement does not claim to prevent every provider defect, credential read, mutation, or network request. Harness-native web access is not a network firewall.

Bounded roster size, turn limits, context limits, one transient retry, and explicit cancellation reduce denial-of-service exposure. Participant response arrays are intentionally unbounded so every active proposal and decision set can be represented without a protocol-imposed item ceiling; individual text fields remain length-bounded. Magi starts the complete roster concurrently without its own participant limit. Participant turns have no product deadline and may remain active until the provider finishes or the user stops the run. After 30 minutes without a terminal event, Magi checks authoritative provider-session liveness and continues waiting while the dispatched turn remains active; it never redispatches a still-active turn. Operators should use least-privilege provider credentials and review native harness policies.

Diagnostics omit prompt bodies and referenced tool-result bodies by default. Raw participant text remains durable audit data in the run detail and must be protected like conversation content.
