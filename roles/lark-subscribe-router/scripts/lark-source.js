#!/usr/bin/env node
/**
 * Bridge: lark-cli event consume -> d-pi source JSON-RPC 2.0 notifications.
 *
 * Spawns `lark-cli event consume <EventKey>` as a subprocess, parses each
 * NDJSON event on its stdout, validates it, and emits a JSON-RPC 2.0
 * notification on this script's own stdout that d-pi's source validator
 * accepts.
 *
 * Contract for d-pi sources (see packages/d-pi/src/hub/source-validator.ts):
 *   - One notification per line, terminated by '\n'
 *   - Must be a JSON-RPC 2.0 notification: has `method`, NO `id`, NO `result`/`error`
 *   - `params.mode` is optional ("next" | "steer"); missing/invalid coerces
 *     to "next" by SourceManager
 *
 * Contract for lark-cli event consume (see lark-event skill):
 *   - NDJSON, one Lark event per line on stdout
 *   - Stderr carries informational messages (e.g. "ready" markers); we
 *     pass these through unchanged so d-pi's source supervisor can see
 *     them, but they MUST NOT bleed into stdout.
 *
 * Usage:
 *   lark-source.js <EventKey> [--as user|bot|auto] [--max-events N] [--timeout D] [--quiet]
 *
 * Example (register as a d-pi source):
 *   command: "node"
 *   args:    ["/abs/path/to/lark-source.js", "im.message.receive_v1", "--as", "bot"]
 *
 * Exit codes:
 *   0  - lark-cli exited cleanly (e.g. --timeout reached, --max-events hit)
 *   1  - bridge-level error (bad CLI args, lark-cli spawn failed)
 *   2  - lark-cli exited with non-zero code (d-pi source supervisor restarts)
 */

"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

// --- CLI arg parsing ------------------------------------------------------

function parseArgs(argv) {
	const args = argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printUsage();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const opts = {
		eventKey: args[0],
		as: "auto",
		maxEvents: undefined,
		timeout: undefined,
		quiet: false,
		extraParams: [],
	};

	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		switch (a) {
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
				console.error(`[lark-source] unknown arg: ${a}`);
				printUsage();
				process.exit(1);
		}
	}

	if (!opts.eventKey) {
		console.error("[lark-source] missing required <EventKey>");
		process.exit(1);
	}

	return opts;
}

function printUsage() {
	process.stderr.write(`Usage: lark-source.js <EventKey> [--as user|bot|auto]
                     [--max-events N] [--timeout D] [--quiet]
                     [-p key=value ...]

Bridges lark-cli event consume <EventKey> to d-pi source JSON-RPC
notifications on stdout. Pass lark-cli stderr through unchanged.
`);
}

// --- lark-cli spawn -------------------------------------------------------

function spawnLarkCli(opts) {
	const args = ["event", "consume", opts.eventKey, "--as", opts.as];
	if (opts.maxEvents !== undefined) args.push("--max-events", String(opts.maxEvents));
	if (opts.timeout !== undefined) args.push("--timeout", opts.timeout);
	if (opts.quiet) args.push("--quiet");
	for (const p of opts.extraParams) args.push("--param", p);

	// We rely on the lark-event skill's stderr "ready" marker contract
	// (AI should NOT pass --quiet here because it silences the marker).
	// This script defaults to NOT passing --quiet for that reason.

	const child = spawn("lark-cli", args, { stdio: ["ignore", "pipe", "pipe"] });

	child.on("error", (err) => {
		console.error(`[lark-source] failed to spawn lark-cli: ${err.message}`);
		process.exit(1);
	});

	return child;
}

// --- Event validation -----------------------------------------------------

/**
 * Decide if a Lark event is valid and worth forwarding. Returns the
 * validation reason string if rejected, or null if accepted.
 *
 * Validation rules:
 *   1. Must have `type` (event key, e.g. "im.message.receive_v1")
 *   2. Must have `chat_id` (oc_xxx)
 *   3. Must have `message_id` (om_xxx) — unless the event type is
 *      something that legitimately has no message (e.g. chat member
 *      change). For now we require message_id; loosen per-type later.
 *   4. Must have `sender_id` (ou_xxx) — same reasoning.
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
 *     "mode": "next"                    // default routing
 *   }
 *
 * Mode is "next" (queue at agent's next turn) by default. To make a
 * specific event type urgent ("steer" — interrupt), fork this script
 * and override the `mode` field below.
 */
function toNotification(event) {
	const params = {
		type: event.type,
		id: event.event_id ?? event.message_id, // event_id preferred; fall back to message_id
		data: event,
		mode: "next",
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
	const child = spawnLarkCli(opts);

	// Let this script exit when lark-cli exits, with the same code.
	// d-pi's source supervisor will restart on non-zero exit, so any
	// abnormal exit from lark-cli will be recovered automatically.
	let childExitCode = null;
	child.on("exit", (code, signal) => {
		childExitCode = code !== null ? code : signal === "SIGTERM" ? 0 : 1;
		// Give the stdout stream a tick to flush, then exit.
		process.exit(childExitCode);
	});

	// Forward SIGINT/SIGTERM to lark-cli so it can shut down cleanly.
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			try {
				child.kill(sig);
			} catch {
				// already dead
			}
		});
	}

	// Mirror lark-cli stderr to our stderr so d-pi's source supervisor
	// can log it. This MUST stay separate from stdout to preserve
	// JSON-RPC output purity.
	child.stderr.pipe(process.stderr);

	// Read lark-cli stdout line-by-line and emit one JSON-RPC notification
	// per accepted event. Malformed lines are logged to stderr and
	// skipped — they don't crash the bridge.
	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

	let emitted = 0;
	let skipped = 0;
	const onLine = (line) => {
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
	};
	rl.on("line", onLine);
	rl.on("close", () => {
		// lark-cli stdout closed; exit handler will fire too, but if
		// we reach here before lark-cli's exit event, exit cleanly.
		console.error(
			`[lark-source] done. emitted=${emitted} skipped=${skipped} exit=${childExitCode}`,
		);
	});
}

main();