#!/usr/bin/env node
/**
 * Bridge: lark-cli event consume -> d-pi source JSON-RPC 2.0 notifications.
 *
 * Spawns one `lark-cli event consume <EventKey>` subprocess per requested
 * EventKey, parses each NDJSON event on their stdout, validates it, and
 * emits a JSON-RPC 2.0 notification on this script's own stdout that
 * d-pi's source validator accepts.
 *
 * Contract for d-pi sources (see packages/d-pi/src/hub/source-validator.ts):
 *   - One notification per line, terminated by '\n'
 *   - Must be a JSON-RPC 2.0 notification: has `method`, NO `id`,
 *     NO `result`/`error`
 *   - `params.mode` is optional ("next" | "steer"); missing/invalid
 *     coerces to "next" by SourceManager. We always set it explicitly
 *     to "steer" for Lark messages.
 *
 * Contract for lark-cli event consume (see lark-event skill):
 *   - NDJSON, one Lark event per line on stdout
 *   - Stderr carries informational messages (e.g. "ready" markers);
 *     we prefix them with the EventKey and pass through unchanged so
 *     d-pi's source supervisor can see them. They MUST NOT bleed
 *     into stdout.
 *
 * Usage:
 *   lark-source.js [--event-key <EventKey>]... [--as user|bot|auto]
 *                 [--max-events N] [--timeout D] [--quiet] [-p key=value ...]
 *
 * Examples:
 *   # Single key (positional still supported for ergonomics)
 *   lark-source.js im.message.receive_v1 --as bot
 *
 *   # Multiple keys, multi-flag form
 *   lark-source.js --event-key im.message.receive_v1 \
 *                   --event-key im.message.reaction.created_v1 \
 *                   --as bot
 *
 *   # Register as a d-pi source
 *   command: "node"
 *   args: ["/abs/path/to/lark-source.js",
 *          "--event-key", "im.message.receive_v1",
 *          "--as", "bot"]
 *
 * Exit codes:
 *   0  - all lark-cli subprocesses exited cleanly (timeout / max-events)
 *   1  - bridge-level error (bad CLI args, lark-cli spawn failed)
 *   2  - at least one lark-cli subprocess exited non-zero (d-pi source
 *       supervisor will restart)
 */

"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { PassThrough } = require("node:stream");

// --- Shared stdin holder --------------------------------------------------
//
// lark-cli `event consume` exits on stdin EOF. To keep consume
// subprocesses alive, the bridge spawns ONE `tail -f /dev/null`
// process and shares its stdout across all lark-cli children.
// tail produces nothing and never closes its stdout, so every
// consumer sees an open-but-empty pipe forever (no EOF).
//
// Single tail per bridge (not per child) keeps the subprocess
// count at N+1 instead of 2N.
if (!globalThis.__larkSourceStdinHolder) {
	const tail = spawn("tail", ["-f", "/dev/null"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	tail.on("error", (err) => {
		process.stderr.write(
			`[lark-source] stdin holder (tail -f /dev/null) failed: ${err.message}\n`,
		);
		process.exit(1);
	});
	// If tail dies for any reason, the bridge can't keep lark-cli
	// alive — surface the failure and exit so d-pi supervisor
	// restarts us cleanly.
	tail.on("exit", (code, signal) => {
		process.stderr.write(
			`[lark-source] stdin holder exited unexpectedly code=${code} signal=${signal}\n`,
		);
		process.exit(1);
	});
	globalThis.__larkSourceStdinHolder = tail;
}

// --- CLI arg parsing ------------------------------------------------------

function parseArgs(argv) {
	const args = argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printUsage();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const opts = {
		eventKeys: [],
		as: "auto",
		maxEvents: undefined,
		timeout: undefined,
		quiet: false,
		extraParams: [],
	};

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		switch (a) {
			case "--event-key":
			case "-e":
				opts.eventKeys.push(args[++i]);
				break;
			case "--as":
				opts.as = args[++i];
				if (!["user", "bot", "auto"].includes(opts.as)) {
					console.error(`[lark-source] invalid --as value: ${opts.as}`);
					process.exit(1);
				}
				break;
			case "--max-events":
				opts.maxEvents = parseInt(args[++i], 10);
				break;
			case "--timeout":
				opts.timeout = args[++i];
				break;
			case "--quiet":
				opts.quiet = true;
				break;
			case "-p":
			case "--param":
				opts.extraParams.push(args[++i]);
				break;
			default:
				// Backward-compat: first positional arg is an EventKey.
				if (i === 0 && !a.startsWith("-")) {
					opts.eventKeys.push(a);
					break;
				}
				console.error(`[lark-source] unknown arg: ${a}`);
				printUsage();
				process.exit(1);
		}
	}

	// No --event-key is NOT an error: main() will fall through to
	// dynamic discovery via `lark-cli event list --json`. See
	// listAvailableEventKeys() below.
	return opts;
}

function printUsage() {
	process.stderr.write(`Usage: lark-source.js [--event-key <EventKey>]... [--as user|bot|auto]
                     [--max-events N] [--timeout D] [--quiet]
                     [-p key=value ...]

Bridges one or more lark-cli event consume streams to d-pi source
JSON-RPC notifications on stdout. Pass lark-cli stderr through
unchanged (prefixed with the EventKey).

EventKey resolution (in order):
  1. All --event-key flags (repeatable) → use exactly those
  2. First positional arg (backward compat) → treat as EventKey
  3. NONE of the above → query 'lark-cli event list --json' and
     subscribe to everything the app has registered

Example (typical: subscribe to everything the app registered):
  lark-source.js --as bot

Example (subscribe to specific events only):
  lark-source.js --event-key im.message.receive_v1 \
                  --event-key im.message.reaction.created_v1 \
                  --as bot
`);
}

// --- lark-cli spawn -------------------------------------------------------

function spawnLarkCli(eventKey, opts) {
	const args = ["event", "consume", eventKey, "--as", opts.as];
	if (opts.maxEvents !== undefined) args.push("--max-events", String(opts.maxEvents));
	if (opts.timeout !== undefined) args.push("--timeout", opts.timeout);
	if (opts.quiet) args.push("--quiet");
	for (const p of opts.extraParams) args.push("--param", p);

	// lark-cli `event consume` treats stdin EOF as a shutdown signal
	// (designed for AI subprocess callers that close stdin to signal
	// "I'm done"). In practice that means: any time lark-cli is
	// spawned without a real interactive stdin (TTY, terminal,
	// tail -f /dev/null, etc.) it sees an empty / closed pipe and
	// exits immediately with "Error: context canceled", even if we
	// pass --max-events. To keep lark-cli alive, every consume
	// subprocess inherits its stdin from a long-lived `tail -f
	// /dev/null` that the bridge owns — one tail process for the
	// whole bridge, shared across all consume children. tail never
	// produces data and never closes its stdout, so lark-cli reads
	// an open-but-empty pipe forever (no EOF). On bridge shutdown
	// the bridge kills lark-cli (SIGTERM) and the tail last.
	//
	// lark-cli's stderr is set to stdio: "pipe" so the bridge can
	// forward per-key lark-cli output (prefixed with EventKey) to
	// the bridge's own stderr. d-pi's source-manager only forwards
	// the bridge's stdout (JSON-RPC notifications) to subscribed
	// agents; bridge stderr is logged to the d-pi supervisor log
	// only. So lark-cli chatter won't flood the agent's context.
	const child = spawn("lark-cli", args, {
		stdio: [globalThis.__larkSourceStdinHolder.stdout, "pipe", "pipe"],
	});

	child.on("error", (err) => {
		console.error(`[lark-source/${eventKey}] failed to spawn lark-cli: ${err.message}`);
		process.exit(1);
	});

	return child;
}

// --- Dynamic EventKey discovery ------------------------------------------

/**
 * Query `lark-cli event list --json` to discover all EventKeys the
 * current app identity has registered. Spawns one short-lived lark-cli
 * subprocess, parses its stdout.
 *
 * Returns: array of EventKey strings, or rejects with an Error.
 *
 * Note: `lark-cli event list` is a static query of what the app has
 * registered in the developer console — it is NOT identity-aware, so
 * we do NOT pass `--as` here. `--as` is only for `event consume`.
 *
 * Tolerated output shapes:
 *   - top-level array:               ["im.message.receive_v1", ...]
 *   - {events: [...]}                (lark-cli --json wraps in `events`)
 *   - {data: [...]}                  (OAPI shape)
 *   - {EventKeys: [...]}             (alternative capitalisation)
 *   - array of objects with `key` or `eventKey` field
 */
function listAvailableEventKeys() {
	return new Promise((resolve, reject) => {
		const child = spawn("lark-cli", ["event", "list", "--json"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			// Capture internally for error reporting; do NOT forward
			// to our own stderr — d-pi would treat every line as a
			// source message and flood the subscribed agent.
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			reject(new Error(`failed to spawn lark-cli event list: ${err.message}`));
		});
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`lark-cli event list exited ${code}: ${stderr.slice(0, 300)}`,
					),
				);
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(stdout);
			} catch (err) {
				reject(
					new Error(`lark-cli event list returned invalid JSON: ${err.message}`),
				);
				return;
			}
			const arr = Array.isArray(parsed)
				? parsed
				: parsed.events || parsed.data || parsed.EventKeys || [];
			if (!Array.isArray(arr)) {
				reject(
					new Error(
						`lark-cli event list JSON shape not recognised (expected array or {events,data,EventKeys})`,
					),
				);
				return;
			}
			const keys = arr
				.map((item) =>
					typeof item === "string"
						? item
						: item?.key ?? item?.eventKey ?? item?.event_key ?? item?.name,
				)
				.filter((k) => typeof k === "string" && k.length > 0);
			if (keys.length === 0) {
				reject(
					new Error(`lark-cli event list returned zero EventKeys — app may have none registered`),
				);
				return;
			}
			// Dedupe (lark-cli list should be unique, but defensive)
			resolve([...new Set(keys)]);
		});
	});
}

// --- Event validation -----------------------------------------------------

/**
 * Decide if a line from lark-cli stdout is a Lark event worth forwarding.
 * Returns the rejection reason string, or null if accepted.
 *
 * PHILOSOPHY: this bridge is a protocol converter (Lark NDJSON → d-pi
 * JSON-RPC), NOT a filter. All Lark events pass through as-is. We only
 * reject lines that are clearly noise / not events:
 *   1. Not a JSON object
 *   2. Missing `type` (every Lark event has a type identifier like
 *      "im.message.receive_v1" or "im.chat.member.added_v1")
 *
 * We do NOT check chat_id, message_id, sender_id, etc. — events like
 * "im.chat.member.added_v1" legitimately have no message_id, and the
 * router agent is responsible for deciding what to do with each event.
 *
 * Filtering by event KIND (only messages, no reactions) is the router
 * agent's job, not the bridge's.
 */
function validateEvent(event) {
	if (!event || typeof event !== "object") return "not an object";
	if (typeof event.type !== "string" || event.type.length === 0) {
		return "missing or non-string type (not a Lark event)";
	}
	return null;
}

// --- JSON-RPC notification construction -----------------------------------

/**
 * Wrap a validated Lark event as a JSON-RPC 2.0 notification that d-pi's
 * source validator will accept and broadcast to subscribed agents.
 *
 * The notification's `params` shape:
 *   {
 *     "type": <event.type>,             // pass-through for downstream
 *     "id":   <event.event_id>,         // global dedup key (when present)
 *     "data": <entire original event>,  // FULL payload, as-is
 *     "mode": "steer"                   // Lark = real-time user input
 *   }
 *
 * - `data` is the entire Lark event verbatim. The bridge does NOT
 *   transform event content; the router agent reads `data.type` and
 *   other fields directly.
 * - `id` is included when the event has any of `event_id`, `message_id`,
 *   `id` (some events use a generic `id` field). Omitted when none
 *   are present.
 * - `mode: "steer"` because Lark is real-time user-facing input;
 *   mirror TUI Ctrl+Enter (interrupt) rather than Enter (queue).
 */
function toNotification(event) {
	const params = {
		type: event.type,
		data: event,
		mode: "steer",
	};
	const id = event.event_id ?? event.message_id ?? event.id;
	if (id !== undefined) params.id = id;
	return {
		jsonrpc: "2.0",
		method: "events.emit",
		params,
	};
}

// --- Main -----------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv);

	// Resolve EventKeys. If --event-key / positional were given, use
	// those. Otherwise, dynamically discover via `lark-cli event list`
	// (this is the typical chat-bot case: subscribe to every event the
	// app has registered in the developer console).
	let eventKeys = opts.eventKeys;
	if (eventKeys.length === 0) {
		process.stderr.write(
			"[lark-source] No --event-key specified; querying `lark-cli event list --json` to discover all registered events...\n",
		);
		try {
			eventKeys = await listAvailableEventKeys();
		} catch (err) {
			process.stderr.write(
				`[lark-source] Failed to discover EventKeys: ${err.message}\n` +
					`[lark-source] Hint: pass --event-key <Key> explicitly, or fix the underlying lark-cli error above.\n`,
			);
			process.exit(1);
		}
		process.stderr.write(
			`[lark-source] Discovered ${eventKeys.length} EventKey(s) to subscribe:\n`,
		);
		for (const k of eventKeys) {
			process.stderr.write(`[lark-source]   - ${k}\n`);
		}
	}

	// Spawn one lark-cli per EventKey.
	const children = eventKeys.map((key) => ({
		key,
		child: spawnLarkCli(key, opts),
	}));

	// Track exit codes per child; bridge exits when all have exited.
	const exitCodes = new Map(); // key -> code
	let exited = 0;
	let anyClean = false; // at least one child exited 0 (success)

	for (const { key, child } of children) {
		child.on("exit", (code, signal) => {
			const ec = code !== null ? code : signal === "SIGTERM" ? 0 : 1;
			exitCodes.set(key, ec);
			exited++;
			if (ec === 0) anyClean = true;
			console.error(
				`[lark-source/${key}] lark-cli exited code=${code} signal=${signal}`,
			);
			if (exited === children.length) {
				// Final exit code policy: the bridge is healthy if AT
				// LEAST ONE child ran cleanly (i.e. we proved the
				// lark-cli / Lark connection works). lark-cli can
				// refuse to subscribe to EventKeys the app hasn't
				// enabled in the developer console — that's a server
				// validation/auth error in the lark-cli output, NOT
				// a bridge bug. Propagating the worst code would
				// cause d-pi's supervisor to keep restarting the
				// bridge in a loop, flooding the agent with
				// "restarting" logs.
				//
				// If ALL children failed (no event ever made it
				// through), propagate the worst non-zero code so
				// d-pi surfaces a real error.
				let final = 0;
				if (!anyClean) {
					for (const v of exitCodes.values()) {
						if (v !== 0) {
							final = v;
							break;
						}
					}
				}
				// Flush stdout, then exit.
				process.exit(final);
			}
		});
	}

	// Forward SIGINT/SIGTERM to all lark-cli subprocesses.
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			for (const { child } of children) {
				try {
					child.kill(sig);
				} catch {
					// already dead
				}
			}
		});
	}

	// Forward each lark-cli's stderr (prefixed with EventKey) to the
	// bridge's own stderr. lark-cli's chatter is short-lived (startup
	// + a few heartbeats), and d-pi's source-manager logs our stderr
	// to its supervisor log only (NOT to the subscribed agent's
	// context — that's the fix in d-pi source-manager). The tags let
	// us tell which lark-cli produced which line when debugging.
	for (const { key, child } of children) {
		if (!child.stderr) continue;
		const tag = `[lark-source/${key}] `;
		let carryover = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			const text = carryover + chunk;
			const lines = text.split("\n");
			carryover = lines.pop() || "";
			for (const line of lines) {
				process.stderr.write(tag + line + "\n");
			}
		});
		child.stderr.on("end", () => {
			if (carryover.length > 0) {
				process.stderr.write(tag + carryover + "\n");
			}
		});
	}


	// Merge all children's stdout into one readline interface. Events
	// from different EventKeys interleave on this single line stream;
	// the JSON-RPC envelope includes params.type so consumers can
	// distinguish them.
	const mergedStdout = new PassThrough();
	// With many concurrent EventKeys (dynamic discovery may spawn 10+),
	// each child adds unpipe/error/close/finish listeners to the
	// PassThrough; raise the cap to silence the leak warning.
	mergedStdout.setMaxListeners(0);
	for (const { child } of children) {
		child.stdout.pipe(mergedStdout);
	}

	const rl = createInterface({ input: mergedStdout, crlfDelay: Infinity });

	let emitted = 0;
	let skipped = 0;
	rl.on("line", (line) => {
		if (line.length === 0) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch (err) {
			console.error(`[lark-source] skip: not valid JSON: ${err.message}`);
			skipped++;
			return;
		}

		const reason = validateEvent(event);
		if (reason) {
			console.error(`[lark-source] skip: ${reason}: ${line.slice(0, 120)}`);
			skipped++;
			return;
		}

		const notification = toNotification(event);
		process.stdout.write(JSON.stringify(notification) + "\n");
		emitted++;
	});
	rl.on("close", () => {
		console.error(
			`[lark-source] done. emitted=${emitted} skipped=${skipped}`,
		);
	});
}

main().catch((err) => {
	process.stderr.write(`[lark-source] fatal: ${err.message}\n${err.stack}\n`);
	process.exit(1);
});