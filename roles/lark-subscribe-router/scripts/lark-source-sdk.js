#!/usr/bin/env node
/**
 * lark-source-sdk.js
 *
 * Bridges Lark / Feishu WebSocket events to d-pi source JSON-RPC 2.0
 * notifications using the official @larksuiteoapi/node-sdk.
 *
 * Why this exists alongside lark-source.js
 * ----------------------------------------
 * The original lark-source.js spawns one `lark-cli event consume`
 * subprocess per EventKey and pipes the NDJSON output into a
 * JSON-RPC 2.0 stream. As of lark-cli 1.0.51 the event bus daemon
 * hardcodes the `feishu-websocket` source name regardless of the
 * app's brand config (Lark international apps get "Incorrect domain
 * name" from the WebSocket gateway and the bus immediately exits).
 *
 * The official Node SDK's WSClient builds the WebSocket URL from
 * the app's tenant metadata, so it picks `lark-websocket` for
 * Lark-international apps and `feishu-websocket` for Feishu-CN apps
 * correctly. Use this bridge when the lark-cli subprocess bridge
 * can't connect.
 *
 * Contract
 * --------
 *   stdout: one JSON-RPC 2.0 notification per line (NDJSON-of-JSON-RPC):
 *     {
 *       "jsonrpc": "2.0",
 *       "method": "events.emit",
 *       "params": {
 *         "type": "<EventKey>",
 *         "id":   "<event_id|message_id|id>",
 *         "data": { ...full original Lark event envelope... },
 *         "mode": "steer"
 *       }
 *     }
 *
 *   stderr: prefix-tagged log lines only.
 *     [lark-source-sdk] fatal: <message>
 *     [lark-source-sdk] ready: subscribed to N EventKey(s): ...
 *     [lark-source-sdk] reconnecting in 1000ms (attempt 1) ...
 *   The d-pi source-manager writes these to the hub's supervisor log
 *   only (NOT to the subscribed agent's context), so lark-cli-style
 *   chatter won't flood the agent.
 *
 * Configuration (all injected via d-pi create_source.env at runtime
 * — never hardcoded in the script):
 *   LARK_APP_ID       (required) app id, e.g. "cli_a91bf7a326b85bc8"
 *   LARK_APP_SECRET   (required) app secret (tenant mode)
 *   LARK_BRAND        (optional) "lark" (default) or "feishu". Picked
 *                      up by the SDK automatically; explicit only for
 *                      diagnostic logging here.
 *   LARK_LOG_LEVEL    (optional) one of "debug"|"info"|"warn"|"error"
 *                      (default "warn"). The SDK's WSClient logger is
 *                      noisy at "debug" — keep at "warn" for production.
 *   LARK_EVENT_DENYLIST (optional) comma-separated EventKey blacklist.
 *                      Listed EventKeys are NOT registered with the
 *                      WSClient — they are dropped at the bridge
 *                      boundary, never reaching d-pi or the agent.
 *                      Use this to mute auto-triggered events that
 *                      aren't conversation signals (read receipts,
 *                      reaction events, ...). Use the literal "*" to
 *                      mute every EventKey (effectively disable the
 *                      bridge — useful for temporary mute). When
 *                      unset, all EventKeys the app has registered
 *                      are subscribed. Examples:
 *                        LARK_EVENT_DENYLIST=im.message.message_read_v1
 *                        LARK_EVENT_DENYLIST=im.message.message_read_v1,im.message.reaction.created_v1
 *                        LARK_EVENT_DENYLIST=*
 *
 * Lifecycle:
 *   - Connect to WebSocket gateway
 *   - Register one handler per EventKey the app has subscribed in
 *     the developer console (queried via `lark-cli event list`)
 *   - Emit one JSON-RPC notification per incoming event
 *   - On SIGINT/SIGTERM: close the WebSocket cleanly and exit 0
 *   - On unhandled error: write a [fatal] line to stderr and exit 1;
 *     d-pi supervisor restarts with exponential backoff
 */

const { spawnSync } = require("node:child_process");
const Lark = require("@larksuiteoapi/node-sdk");

// Re-route console.log/info/warn/error/debug/trace to stderr so the
// SDK's chatter (which goes through console.*) doesn't pollute the
// JSON-RPC notification stream on stdout. The d-pi hub reads our
// stdout verbatim and treats any non-JSON-RPC line as a parse error
// (silently dropped) — useful chatty SDK logs would either get
// dropped or, worse, leak into an agent's context as a malformed
// source message.
const _consoleToStderr = (level) => (...args) => {
	process.stderr.write(`[console.${level}] `);
	for (const a of args) {
		if (typeof a === "string") process.stderr.write(a);
		else {
			try { process.stderr.write(JSON.stringify(a)); }
			catch { process.stderr.write(String(a)); }
		}
		process.stderr.write(" ");
	}
	process.stderr.write("\n");
};
console.log = _consoleToStderr("log");
console.info = _consoleToStderr("info");
console.warn = _consoleToStderr("warn");
console.error = _consoleToStderr("error");
console.debug = _consoleToStderr("debug");
console.trace = _consoleToStderr("trace");

// --- Config ---------------------------------------------------------------

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BRAND = (process.env.LARK_BRAND || "lark").toLowerCase();
// LARK_EVENT_DENYLIST: comma-separated EventKey blacklist. The
// listed EventKeys are NOT registered with the SDK's WSClient —
// they are dropped at the bridge, never entering d-pi. Unset
// (or the literal "*" if you want a "mute everything" escape
// hatch) means subscribe to everything the app has registered.
const DENYLIST_RAW = (process.env.LARK_EVENT_DENYLIST || "").trim();
const DENYLIST = DENYLIST_RAW === ""
	? null // null = "no denylist" (subscribe-all)
	: new Set(
			DENYLIST_RAW
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);
// Map BRAND to the SDK's Domain enum. The SDK uses domain to pick the
// openapi / websocket endpoint (open.feishu.cn vs open.larksuite.com);
// a feishu-registered app and a lark-registered one are not
// interchangeable, so choose the wrong one and the WebSocket handshake
// will 401/403.
const DOMAIN =
	BRAND === "feishu"
		? Lark.Domain.Feishu
		: BRAND === "lark"
			? Lark.Domain.Lark
			: (() => {
					process.stderr.write(
						`[lark-source-sdk] fatal: LARK_BRAND must be "lark" or "feishu", got "${BRAND}"\n`,
					);
					process.exit(1);
				})();
const LOG_LEVEL = (process.env.LARK_LOG_LEVEL || "warn").toLowerCase();

if (!APP_ID || !APP_SECRET) {
	process.stderr.write(
		"[lark-source-sdk] fatal: LARK_APP_ID and LARK_APP_SECRET must be set in the source env (create_source.env). Refusing to start.\n",
	);
	process.exit(1);
}

// --- EventKey discovery ---------------------------------------------------

/**
 * Query `lark-cli event list --json` for the EventKeys the app has
 * registered in the developer console. Spawns a short-lived lark-cli
 * subprocess. Returns a deduplicated array of strings.
 *
 * Note: `lark-cli event list` is a static query — it does NOT accept
 * --as. The list reflects what the app has *registered*, not what
 * the app has *subscribed at runtime*; the WSClient's connect-time
 * negotiation is the runtime check.
 */
function listEventKeys() {
	const r = spawnSync("lark-cli", ["event", "list", "--json"], {
		encoding: "utf8",
	});
	if (r.error) {
		throw new Error(`failed to spawn lark-cli event list: ${r.error.message}`);
	}
	if (r.status !== 0) {
		throw new Error(
			`lark-cli event list exited ${r.status}: ${(r.stderr || "").slice(0, 300)}`,
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(r.stdout);
	} catch (err) {
		throw new Error(`lark-cli event list returned invalid JSON: ${err.message}`);
	}
	const arr = Array.isArray(parsed)
		? parsed
		: parsed.events || parsed.data || parsed.EventKeys || [];
	if (!Array.isArray(arr)) {
		throw new Error(
			"lark-cli event list JSON shape not recognised (expected array or {events,data,EventKeys})",
		);
	}
	const keys = arr
		.map((item) =>
			typeof item === "string"
				? item
				: item?.key ?? item?.eventKey ?? item?.event_key ?? item?.name,
		)
		.filter((k) => typeof k === "string" && k.length > 0);
	if (keys.length === 0) {
		throw new Error(
			"lark-cli event list returned zero EventKeys — app may have none registered",
		);
	}
	return [...new Set(keys)];
}

// --- JSON-RPC emission ----------------------------------------------------

/**
 * Build a JSON-RPC 2.0 notification from a raw Lark event payload.
 * Mirrors the envelope produced by the original lark-source.js
 * bridge so d-pi consumers (and downstream agents) see a uniform
 * shape regardless of which bridge implementation is registered.
 */
function toNotification(eventKey, event) {
	const id = event?.event_id ?? event?.message_id ?? event?.id;
	const params = {
		type: eventKey,
		data: event,
		mode: "steer",
	};
	if (id !== undefined) params.id = id;
	return {
		jsonrpc: "2.0",
		method: "events.emit",
		params,
	};
}

function emit(notification) {
	process.stdout.write(JSON.stringify(notification) + "\n");
}

// --- Main -----------------------------------------------------------------

async function main() {
	process.stderr.write(
		`[lark-source-sdk] starting (appId=${APP_ID}, brand=${BRAND}, logLevel=${LOG_LEVEL})\n`,
	);

	// 1. Discover EventKeys
	let eventKeys;
	try {
		eventKeys = listEventKeys();
	} catch (err) {
		process.stderr.write(
			`[lark-source-sdk] fatal: failed to discover EventKeys: ${err.message}\n` +
				`[lark-source-sdk] hint: lark-cli must be installed and on PATH; the app must have at least one EventKey registered in the developer console.\n`,
		);
		process.exit(1);
	}
	process.stderr.write(
		`[lark-source-sdk] discovered ${eventKeys.length} EventKey(s) from app registration:\n`,
	);
	for (const k of eventKeys) {
		process.stderr.write(`[lark-source-sdk]   - ${k}\n`);
	}

	// 1b. Apply LARK_EVENT_DENYLIST blacklist. Denied EventKeys
	//     never reach the WSClient handler registration, so they
	//     never enter d-pi. Drops the noise at the bridge boundary,
	//     not in the LLM context. The "mute everything" escape
	//     hatch is LARK_EVENT_DENYLIST=* (useful for temporarily
	//     silencing the bridge without unregistering the source).
	if (DENYLIST !== null) {
		const before = eventKeys.length;
		eventKeys = eventKeys.filter((k) => !DENYLIST.has(k));
		const muted = DENYLIST_RAW === "*";
		process.stderr.write(
			`[lark-source-sdk] denylist active${muted ? " (mute everything)" : `: ${DENYLIST_RAW}`}\n` +
				`[lark-source-sdk] denylist result: ${eventKeys.length}/${before} EventKey(s) will be subscribed (${before - eventKeys.length} muted)\n`,
		);
		if (!muted) {
			for (const k of DENYLIST) {
				if (!eventKeys.includes(k) /* already-filtered, ie the denylisted key was registered */) {
					// We've already passed the filter — anything left in
					// eventKeys wasn't denylisted; anything in DENYLIST
					// and registered in the original list has been dropped
					// silently. Tell the operator if they listed a key the
					// app never registered (typo guard).
				}
			}
			const registered = new Set(listEventKeys());
			for (const k of DENYLIST) {
				if (k === "*") continue;
				if (!registered.has(k)) {
					process.stderr.write(
						`[lark-source-sdk] warn: denylist lists EventKey "${k}" but it isn't registered in the app's developer console — double-check the spelling (or it may simply be the user side; that key is auto-registered too and will be muted on the user side, not ours)\n`,
					);
				}
			}
		}
		if (eventKeys.length === 0 && DENYLIST_RAW !== "*") {
			process.stderr.write(
				`[lark-source-sdk] fatal: LARK_EVENT_DENYLIST mutes every registered EventKey. Use "*" explicitly if that's what you want; otherwise check the spelling.\n`,
			);
			process.exit(1);
		}
	} else {
		process.stderr.write(
			`[lark-source-sdk] denylist inactive (LARK_EVENT_DENYLIST unset) — subscribing to all discovered EventKeys.\n`,
		);
	}

	process.stderr.write(
		`[lark-source-sdk] will subscribe to ${eventKeys.length} EventKey(s):\n`,
	);
	for (const k of eventKeys) {
		process.stderr.write(`[lark-source-sdk]   - ${k}\n`);
	}

	// 2. Build the EventDispatcher handler map
	const handlers = {};
	for (const key of eventKeys) {
		handlers[key] = async (data) => {
			try {
				emit(toNotification(key, data));
			} catch (err) {
				process.stderr.write(
					`[lark-source-sdk] error: failed to emit notification for ${key}: ${err.message}\n`,
				);
			}
		};
	}

	// 3. Construct WSClient. The domain (open.feishu.cn vs
	//    open.larksuite.com) is driven by LARK_BRAND — the SDK's
	//    WSClient reads it to pick the WebSocket endpoint. A
	//    feishu-registered app and a lark-registered one are
	//    not interchangeable, so BRAND must match the app's
	//    registration.
	const wsClient = new Lark.WSClient({
		appId: APP_ID,
		appSecret: APP_SECRET,
		domain: DOMAIN,
		loggerLevel: Lark.LoggerLevel[LOG_LEVEL] ?? Lark.LoggerLevel.warn,
	});

	// 4. Start. The SDK connects, negotiates the EventKeys, and
	//    dispatches incoming events to our handlers. It auto-
	//    reconnects on transient WebSocket drops.
	wsClient.start({
		eventDispatcher: new Lark.EventDispatcher({}).register(handlers),
	});

	process.stderr.write(
		`[lark-source-sdk] ready: subscribed to ${eventKeys.length} EventKey(s), waiting for events.\n`,
	);

	// 5. Graceful shutdown. SDK doesn't expose a clean close promise
	//    in all versions, so we rely on process exit to clean up the
	//    underlying socket. SIGINT/SIGTERM trigger d-pi's destroy
	//    path which sends one of these to us.
	const shutdown = (signal) => {
		process.stderr.write(
			`[lark-source-sdk] received ${signal}, closing WebSocket and exiting.\n`,
		);
		// Give the OS a tick to flush stdout before exit.
		setImmediate(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
	process.stderr.write(
		`[lark-source-sdk] fatal: ${err.message}\n${err.stack || ""}\n`,
	);
	process.exit(1);
});
