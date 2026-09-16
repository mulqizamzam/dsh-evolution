import { n as neutralizeDeep } from "./sanitize-D6DxtaUR.js";
import { i as text, n as defineTool, r as registerToolSafe, t as JSON_OBJECT_OUTPUT } from "./dsh-BUCgILFr.js";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { constants } from "node:fs";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/host/modules/sandbox/tools.ts
const RENDER = (_args, value) => text(value);
const DEFAULT_TIMEOUT_MS = 3e4;
const MAX_TIMEOUT_MS = 12e4;
function sandboxTools(deps, runner) {
	return [defineTool({
		name: "evo_sandbox_exec",
		description: "Execute a shell command inside a sandboxed environment. Requires bubblewrap (bwrap), which supplies the filesystem and namespace isolation; the call is REFUSED when bwrap is unavailable, because the alternative runner would give a candidate-authored command no isolation at all. Returns stdout, stderr, exit code, and timing metadata.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command to execute."
				},
				cwd: {
					type: "string",
					description: "Working directory for the command. Defaults to /tmp."
				},
				timeoutMs: {
					type: "number",
					description: "Execution timeout in milliseconds. Capped at 120000. Defaults to 30000."
				},
				allowNetwork: {
					type: "boolean",
					description: "If true, network access is not restricted. Default false."
				},
				env: {
					type: "object",
					description: "Additional environment variables as key-value pairs.",
					additionalProperties: { type: "string" }
				}
			},
			required: ["command"]
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER
		},
		execute: async (args) => {
			const a = args ?? {};
			const command = typeof a.command === "string" ? a.command : "";
			if (!command) return neutralizeDeep({
				ok: false,
				error: "command is required and must be a non-empty string"
			});
			const cwd = typeof a.cwd === "string" && a.cwd.length > 0 ? a.cwd : "/tmp";
			const rawTimeout = typeof a.timeoutMs === "number" ? Math.floor(a.timeoutMs) : DEFAULT_TIMEOUT_MS;
			const timeoutMs = Math.min(Math.max(rawTimeout, 1e3), MAX_TIMEOUT_MS);
			const allowNetwork = a.allowNetwork === true;
			let env;
			if (a.env && typeof a.env === "object" && !Array.isArray(a.env)) {
				env = {};
				for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
			}
			const options = {
				cwd,
				timeoutMs,
				allowNetwork,
				env
			};
			if (!await runner.isAvailable()) return neutralizeDeep({
				ok: false,
				error: "sandbox is not available on this host"
			});
			deps.log("sandbox: exec \"" + command.slice(0, 120) + "\" in " + cwd);
			const result = await runner.exec(command, options);
			return neutralizeDeep({
				ok: true,
				sandbox: runner.name,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				timedOut: result.timedOut,
				oomKilled: result.oomKilled,
				durationMs: result.durationMs,
				signal: result.signal
			});
		}
	})];
}
//#endregion
//#region src/host/modules/sandbox/index.ts
var sandbox_exports = /* @__PURE__ */ __exportAll({
	BubblewrapSandbox: () => BubblewrapSandbox,
	NodeProcessSandbox: () => NodeProcessSandbox,
	TOOLS: () => TOOLS,
	apply: () => apply,
	getSandbox: () => getSandbox,
	name: () => name,
	readEndpoints: () => readEndpoints,
	writeEndpoints: () => writeEndpoints
});
const name = "sandbox";
const TOOLS = ["evo_sandbox_exec"];
const readEndpoints = {};
const writeEndpoints = {};
const ESSENTIAL_BINDS = [
	"/usr",
	"/lib",
	"/lib64",
	"/bin",
	"/sbin",
	"/etc/ld.so.cache",
	"/etc/ssl",
	"/etc/resolv.conf"
];
const MAX_OUTPUT = 1e5;
/**
* Directory holding the Node binary running this process. A version manager
* (nvm/volta/fnm) puts it outside the system paths, so an isolated sandbox that
* binds only /usr and /bin cannot execute `node` at all — the candidate would
* fail with 127 before any code ran. Bind it read-only and put it on PATH.
*/
const NODE_BIN_DIR = dirname(process.execPath);
var BubblewrapSandbox = class {
	name = "bubblewrap";
	async isAvailable() {
		try {
			await access("/usr/bin/bwrap", constants.X_OK);
			execSync("bwrap --version", {
				timeout: 2e3,
				stdio: "pipe"
			});
			return true;
		} catch {
			return false;
		}
	}
	async exec(command, options) {
		const args = [];
		args.push("--clearenv");
		for (const mount of ESSENTIAL_BINDS) try {
			await access(mount);
			args.push("--ro-bind", mount, mount);
		} catch {}
		try {
			await access(NODE_BIN_DIR);
			args.push("--ro-bind", NODE_BIN_DIR, NODE_BIN_DIR);
		} catch {}
		args.push("--tmpfs", "/tmp");
		args.push("--proc", "/proc");
		args.push("--dev", "/dev");
		if (options.cwd) {
			args.push("--bind", options.cwd, options.cwd);
			args.push("--chdir", options.cwd);
		}
		for (const m of options.readOnlyMounts ?? []) args.push("--ro-bind", m, m);
		for (const m of options.readWriteMounts ?? []) args.push("--bind", m, m);
		args.push("--unshare-pid");
		if (!options.allowNetwork) args.push("--unshare-net");
		for (const [key, value] of Object.entries(options.env ?? {})) args.push("--setenv", key, value);
		args.push("--setenv", "PATH", NODE_BIN_DIR + ":/usr/local/bin:/usr/bin:/bin");
		args.push("/bin/sh", "-c", command);
		return spawnWithTimeout("bwrap", args, options);
	}
};
var NodeProcessSandbox = class {
	name = "node-process";
	async isAvailable() {
		return true;
	}
	async exec(command, options) {
		const env = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: options.cwd ?? "/tmp",
			...options.env
		};
		return spawnWithTimeout("/bin/sh", ["-c", command], options, env);
	}
};
function spawnWithTimeout(bin, args, options, env) {
	return new Promise((resolve) => {
		const start = Date.now();
		let timedOut = false;
		let settled = false;
		let stdout = "";
		let stderr = "";
		const child = spawn(bin, args, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			detached: true,
			env
		});
		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		const finish = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const durationMs = Date.now() - start;
			const oomKilled = stderr.includes("Out of memory") || signal === "SIGKILL" && !timedOut;
			resolve({
				exitCode: code,
				stdout: stdout.slice(0, MAX_OUTPUT),
				stderr: stderr.slice(0, MAX_OUTPUT),
				timedOut,
				oomKilled,
				durationMs,
				signal: signal ?? void 0
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.pid !== void 0 ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			setTimeout(() => finish(null, "SIGKILL"), 500);
		}, options.timeoutMs);
		child.on("close", (code, signal) => finish(code, signal ?? void 0));
		child.on("error", (error) => {
			stderr += "sandbox spawn failed: " + error.message;
			finish(null);
		});
	});
}
let _sandbox;
function getSandbox() {
	if (!_sandbox) _sandbox = new BubblewrapSandbox();
	return _sandbox;
}
function apply(deps) {
	const sandbox = new BubblewrapSandbox();
	_sandbox = sandbox;
	for (const tool of sandboxTools(deps, sandbox)) registerToolSafe(deps.ctx, tool);
	deps.log("sandbox: registered evo_sandbox_exec");
}
//#endregion
export { sandbox_exports as n, __exportAll as r, getSandbox as t };
