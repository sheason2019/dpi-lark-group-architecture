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

	if (opts.eventKeys.length === 0) {
		console.error("[lark-source] at least one --event-key (or positional EventKey) required");
		printUsage();
		process.exit(1);
	}

	return opts;
}

function printUsage() {
	process.stderr.write(`Usage: lark-source.js [--event-key <EventKey>]... [--as user|bot|auto]
                     [--max-events N] [--timeout D] [--quiet]
                     [-p key=value ...]

Bridges one or more lark-cli event consume streams to d-pi source
JSON-RPC notifications on stdout. Pass lark-cli stderr through
unchanged (prefixed with the EventKey).

First positional arg is treated as an EventKey for backward compat.
`);
}

// --- lark-cli spawn -------------------------------------------------------

function spawnLarkCli(eventKey, opts) {
	const args = ["event", "consume", eventKey, "--as", opts.as];
	if (opts.maxEvents !== undefined) args.push("--max-events", String(opts.maxEvents));
	if (opts.timeout !== undefined) args.push("--timeout", opts.timeout);
	if (opts.quiet) args.push("--quiet");
	for (const p of opts.extraParams) args.push("--param", p);

	const child = spawn("lark-cli", args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	child.on("error", (err) => {
		console.error(`[lark-source/${eventKey}] failed to spawn lark-cli: ${err.message}`);
		process.exit(1);
	});

	return child;
}

// --- Event validation -----------------------------------------------------

/**
 * Decide if a Lark event is valid and worth forwarding. Returns the
 * validation reason string if rejected, or null if accepted.
 *
 * Validation rules (must-have Lark fields, no semantic filtering):
 *   1. Must have `type` (event key, e.g. "im.message.receive_v1")
 *   2. Must have `chat_id` (oc_xxx)
 *   3. Must have `message_id` (om_xxx)
 *   4. Must have `sender_id` (ou_xxx)
 *
 * The bridge does NOT filter by `message_type`, content, sender, etc.
 * — the router agent decides what to do with each event.
 */
function validateEvent(event) {
	if (!event || typeof event !== "object") return "not an object";
	if (typeof event.type !== "string" || event.type.length === 0) return "missing type";
	if (typeof event.chat_id !== "string" || !event.chat_id.startsWith("oc_")) {
		return "missing or invalid chat_id";
	}
	if (typeof event.message_id !== "string" || !event.message_id.startsWith("om_")) {
		return "missing or invalid message_id";
	}
	if (typeof event.sender_id !== "string" || !event.sender_id.startsWith("ou_")) {
		return "missing or invalid sender_id";
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
 *     "id":   <event.event_id>,         // global dedup key
 *     "data": <entire original event>,  // full payload preserved
 *     "mode": "steer"                   // Lark = real-time user input
 *   }
 *
 * Mode is "steer" (interrupt the agent's current turn and inject
 * immediately). Lark messages are real-time user-facing input — the
 * user is actively waiting for a response, so we mirror the TUI's
 * Ctrl+Enter semantics rather than the Enter (queue) semantics.
 */
function toNotification(event) {
	const params = {
		type: event.type,
		id: event.event_id ?? event.message_id,
		data: event,
		mode: "steer",
	};
	return {
		jsonrpc: "2.0",
		method: "events.emit",
		params,
	};
}

// --- Main -----------------------------------------------------------------

function main() {
	const opts = parseArgs(process.argv);

	// Spawn one lark-cli per EventKey.
	const children = opts.eventKeys.map((key) => ({
		key,
		child: spawnLarkCli(key, opts),
	}));

	// Track exit codes per child; bridge exits when all have exited.
	const exitCodes = new Map(); // key -> code
	let exited = 0;

	for (const { key, child } of children) {
		child.on("exit", (code, signal) => {
			const ec = code !== null ? code : signal === "SIGTERM" ? 0 : 1;
			exitCodes.set(key, ec);
			exited++;
			console.error(
				`[lark-source/${key}] lark-cli exited code=${code} signal=${signal}`,
			);
			if (exited === children.length) {
				// Pick the worst exit code: first non-zero wins; else 0.
				let final = 0;
				for (const v of exitCodes.values()) {
					if (v !== 0) {
						final = v;
						break;
					}
				}
				// Flush stdout, then exit.
				process.exit(final || 0);
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

	// Tag each child's stderr with its EventKey and forward to our
	// stderr. Stderr MUST NOT mix with stdout (preserves JSON purity).
	for (const { key, child } of children) {
		const tag = `[lark-source/${key}] `;
		let carryover = "";
		child.stderr.on("data", (chunk) => {
			const text = carryover + chunk.toString("utf8");
			const lines = text.split("\n");
			carryover = lines.pop(); // last fragment may be incomplete
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

main();