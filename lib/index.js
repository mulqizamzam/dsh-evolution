import { n as sandbox_exports, r as __exportAll, t as getSandbox } from "./sandbox-DEvCA9yT.js";
import { n as neutralizeDeep, t as neutralize } from "./sanitize-D6DxtaUR.js";
import { i as text, n as defineTool, r as registerToolSafe, t as JSON_OBJECT_OUTPUT } from "./dsh-BUCgILFr.js";
import { n as clampText, t as DEFAULT_PROMOTION_POLICY } from "./types-JHCVYcxw.js";
import { a as readArtifactManifest, n as artifactManifestPath, o as validateArtifact, r as artifactPluginPath, s as versionDir, t as artifactFilesDir } from "./artifact-CaFGU8H7.js";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import z from "schemastery";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
//#region src/lib/errors.ts
/** Extract an error message from an unknown thrown value. */
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}
function makeLogger(prefix) {
	return {
		info: (msg) => {},
		warn: (msg) => {}
	};
}
//#endregion
//#region src/lib/home.ts
/** Basename of this plugin's data directory inside the Harness home. */
const STATE_DIR_NAME = "dsh-evolution";
/**
* Resolve the state root.
* The host dshHomePath service wins; fallback is env-based.
*/
function resolveStateRoot(get, fallbackRoot = envStateRoot()) {
	try {
		const service = typeof get === "function" ? get("dshHomePath") : void 0;
		if (typeof service !== "function") return fallbackRoot;
		const value = service(STATE_DIR_NAME);
		return typeof value === "string" && value !== "" ? value : fallbackRoot;
	} catch {
		return fallbackRoot;
	}
}
/**
* Fallback root: $DSH_HOME/dsh-evolution, else $HOME/.dsh/dsh-evolution.
*/
function envStateRoot(env = process.env) {
	const configured = env.DSH_HOME;
	if (typeof configured === "string" && configured.trim() !== "") return join(configured.trim(), STATE_DIR_NAME);
	const home = env.HOME ?? env.USERPROFILE;
	if (typeof home === "string" && home !== "") return join(home, ".dsh", STATE_DIR_NAME);
	return join(".dsh", STATE_DIR_NAME);
}
/** mkdir -p; returns the path. */
async function ensureDir(path) {
	await mkdir(path, { recursive: true });
	return path;
}
/** Create the fixed scaffold every collection assumes exists. */
async function ensureStateRoot(root) {
	await ensureDir(root);
	await ensureDir(join(root, "experiences"));
	await ensureDir(join(root, "candidates"));
	await ensureDir(join(root, "versions"));
	await ensureDir(join(root, "benchmarks"));
	await ensureDir(join(root, "patterns"));
	await ensureDir(join(root, "tmp"));
	return root;
}
//#endregion
//#region src/host/config.ts
/**
* Conservative defaults: 20 completed experiences and 5 occurrences before the
* autonomous loop may act, generation and promotion both off until the operator
* turns them on, and at most 3 autonomous cycles per host process.
*/
const DEFAULT_CONFIG = {
	stateRoot: "",
	inject: { enabled: true },
	evolution: {
		enabled: true,
		autoRecord: true,
		autoTrigger: true,
		analysis: {
			minExperiences: 20,
			minOccurrences: 5
		},
		generation: { enabled: false },
		promotion: { enabled: false },
		maxCyclesPerProcess: 3
	},
	experience: {
		maxRecords: 1e4,
		retentionDays: 90
	},
	candidate: { maxActive: 10 },
	benchmark: {
		minRuns: 3,
		maxRuns: 10,
		improvementThreshold: .05,
		regressionThreshold: .1
	}
};
const Config = z.object({
	stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot),
	inject: z.object({ enabled: z.boolean().default(DEFAULT_CONFIG.inject.enabled) }).default(DEFAULT_CONFIG.inject),
	evolution: z.object({
		enabled: z.boolean().default(DEFAULT_CONFIG.evolution.enabled),
		autoRecord: z.boolean().default(DEFAULT_CONFIG.evolution.autoRecord),
		autoTrigger: z.boolean().default(DEFAULT_CONFIG.evolution.autoTrigger),
		analysis: z.object({
			minExperiences: z.number().default(DEFAULT_CONFIG.evolution.analysis.minExperiences),
			minOccurrences: z.number().default(DEFAULT_CONFIG.evolution.analysis.minOccurrences)
		}).default(DEFAULT_CONFIG.evolution.analysis),
		generation: z.object({ enabled: z.boolean().default(DEFAULT_CONFIG.evolution.generation.enabled) }).default(DEFAULT_CONFIG.evolution.generation),
		promotion: z.object({ enabled: z.boolean().default(DEFAULT_CONFIG.evolution.promotion.enabled) }).default(DEFAULT_CONFIG.evolution.promotion),
		maxCyclesPerProcess: z.number().default(DEFAULT_CONFIG.evolution.maxCyclesPerProcess)
	}).default(DEFAULT_CONFIG.evolution),
	experience: z.object({
		maxRecords: z.number().default(DEFAULT_CONFIG.experience.maxRecords),
		retentionDays: z.number().default(DEFAULT_CONFIG.experience.retentionDays)
	}).default(DEFAULT_CONFIG.experience),
	candidate: z.object({ maxActive: z.number().default(DEFAULT_CONFIG.candidate.maxActive) }).default(DEFAULT_CONFIG.candidate),
	benchmark: z.object({
		minRuns: z.number().default(DEFAULT_CONFIG.benchmark.minRuns),
		maxRuns: z.number().default(DEFAULT_CONFIG.benchmark.maxRuns),
		improvementThreshold: z.number().default(DEFAULT_CONFIG.benchmark.improvementThreshold),
		regressionThreshold: z.number().default(DEFAULT_CONFIG.benchmark.regressionThreshold)
	}).default(DEFAULT_CONFIG.benchmark)
});
const INJECT_LABEL = "evolution";
/**
* Parse a raw host config into a ResolvedConfig, applying defaults.
*
* Throws a descriptive Error when the input cannot be validated so callers
* can decide whether to fail boot or log a warning. This is an *intentional*
* surface: silent fallback to DEFAULT_CONFIG masked all malformed inputs
* until a P7 audit flagged it as a gap.
*/
function resolveConfig(raw) {
	return Config(raw);
}
//#endregion
//#region src/lib/ids.ts
/** Generate a short random id (12 hex chars). */
function newId() {
	return randomBytes(6).toString("hex");
}
/** ISO datetime string (UTC). */
function isoDateTime(date) {
	return (date ?? /* @__PURE__ */ new Date()).toISOString();
}
/** Generate a version id like v1, v2, v3. */
function versionId(n) {
	return `v${String(n)}`;
}
//#endregion
//#region src/lib/fsx.ts
/** Read a JSON file safely; returns null on ENOENT or parse failure. */
async function readJsonSafe(path) {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text);
	} catch {
		return null;
	}
}
/** Atomic JSON write: write to tmp then rename. */
async function writeJsonAtomic(path, data) {
	const tmp = path + ".tmp." + newId();
	await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	const { rename } = await import("node:fs/promises");
	await rename(tmp, path);
}
/** List files in a directory, sorted by mtime descending. */
async function listDir(dir, limit = 500) {
	try {
		const entries = await readdir(dir);
		const withMtime = [];
		for (const name of entries) try {
			const s = await stat(join(dir, name));
			if (s.isFile()) withMtime.push({
				name,
				mtime: s.mtimeMs
			});
		} catch {}
		withMtime.sort((a, b) => b.mtime - a.mtime);
		return withMtime.slice(0, limit).map((e) => e.name);
	} catch {
		return [];
	}
}
//#endregion
//#region src/host/store.ts
/** SCHEMA_VERSION: bumped when file layout changes. */
const SCHEMA_VERSION = 1;
var EvolutionStore = class {
	root;
	nowFn;
	constructor(options) {
		this.root = resolveStateRoot(options.get, options.fallbackRoot);
		this.nowFn = options.now ?? (() => /* @__PURE__ */ new Date());
	}
	async init() {
		await ensureStateRoot(this.root);
		return this.root;
	}
	getRoot() {
		return this.root;
	}
	experienceDir() {
		return join(this.root, "experiences");
	}
	async addExperience(record) {
		const full = {
			...record,
			id: newId(),
			timestamp: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.experienceDir(), `${full.id}.json`), full);
		return full;
	}
	async getExperience(id) {
		return await readJsonSafe(join(this.experienceDir(), `${id}.json`));
	}
	async listExperiences(limit = 50) {
		const files = await listDir(this.experienceDir(), limit);
		const records = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.experienceDir(), f));
			if (data && typeof data === "object") records.push(data);
		}
		return records;
	}
	/**
	* Return only experiences that were recorded while a specific version was
	* active.  Used by post-promotion monitoring to attribute outcomes to the
	* version that was mounted at the time.
	*/
	async listExperiencesByVersion(versionId, limit = 50) {
		return (await this.listExperiences(limit * 10)).filter((e) => e.versionId === versionId).slice(0, limit);
	}
	patternDir() {
		return join(this.root, "patterns");
	}
	async addPattern(pattern) {
		const full = {
			...pattern,
			id: newId(),
			createdAt: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.patternDir(), `${full.id}.json`), full);
		return full;
	}
	async listPatterns(limit = 100) {
		const files = await listDir(this.patternDir(), limit);
		const patterns = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.patternDir(), f));
			if (data && typeof data === "object") patterns.push(data);
		}
		return patterns;
	}
	candidateDir() {
		return join(this.root, "candidates");
	}
	async addCandidate(candidate) {
		const full = {
			...candidate,
			id: newId(),
			createdAt: isoDateTime(this.nowFn()),
			updatedAt: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.candidateDir(), `${full.id}.json`), full);
		return full;
	}
	async getCandidate(id) {
		return await readJsonSafe(join(this.candidateDir(), `${id}.json`));
	}
	async updateCandidate(id, updates) {
		const existing = await this.getCandidate(id);
		if (!existing) return null;
		const updated = {
			...existing,
			...updates,
			id,
			updatedAt: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.candidateDir(), `${id}.json`), updated);
		return updated;
	}
	async listCandidates(limit = 50) {
		const files = await listDir(this.candidateDir(), limit);
		const candidates = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.candidateDir(), f));
			if (data && typeof data === "object") candidates.push(data);
		}
		return candidates;
	}
	benchmarkDir() {
		return join(this.root, "benchmarks");
	}
	async addBenchmark(run) {
		const full = {
			...run,
			id: newId(),
			createdAt: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.benchmarkDir(), `${full.id}.json`), full);
		return full;
	}
	async listBenchmarks(limit = 50) {
		const files = await listDir(this.benchmarkDir(), limit);
		const runs = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.benchmarkDir(), f));
			if (data && typeof data === "object") runs.push(data);
		}
		return runs;
	}
	versionDir() {
		return join(this.root, "versions");
	}
	async getVersion(id) {
		return await readJsonSafe(join(this.versionDir(), `${id}.json`));
	}
	async getActiveVersion() {
		const versions = await this.listVersions();
		return versions.find((v) => v.status === "active") ?? versions[0] ?? null;
	}
	async createVersion(data) {
		const versions = await this.listVersions();
		const nextNumber = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.number)) + 1;
		const version = {
			id: versionId(nextNumber),
			number: nextNumber,
			label: data.label,
			createdAt: isoDateTime(this.nowFn()),
			promotedFrom: data.promotedFrom,
			benchmarkRunId: data.benchmarkRunId,
			reason: data.reason,
			status: "active",
			modules: data.modules
		};
		const active = await this.getActiveVersion();
		if (active) await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), {
			...active,
			status: "rolled-back"
		});
		await writeJsonAtomic(join(this.versionDir(), `${version.id}.json`), version);
		return version;
	}
	async listVersions(limit = 50) {
		const files = await listDir(this.versionDir(), limit);
		const versions = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.versionDir(), f));
			if (data && typeof data === "object") versions.push(data);
		}
		return versions.sort((a, b) => a.number - b.number);
	}
	async rollbackVersion(versionId) {
		const target = await this.getVersion(versionId);
		if (!target) return null;
		const active = await this.getActiveVersion();
		if (active?.id === target.id) return {
			restored: target,
			deactivated: null,
			alreadyActive: true
		};
		if (active) await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), {
			...active,
			status: "rolled-back"
		});
		await writeJsonAtomic(join(this.versionDir(), `${target.id}.json`), {
			...target,
			status: "active"
		});
		return {
			restored: target,
			deactivated: active,
			alreadyActive: false
		};
	}
	async updateVersion(id, updates) {
		const existing = await this.getVersion(id);
		if (!existing) return null;
		const updated = {
			...existing,
			...updates
		};
		await writeJsonAtomic(join(this.versionDir(), `${id}.json`), updated);
		return updated;
	}
};
//#endregion
//#region src/host/modules/experience/tools.ts
const RENDER$9 = (_args, value) => text(value);
function experienceTools(deps) {
	const store = deps.store;
	return [
		defineTool({
			name: "evo_experience_record",
			description: "Record a completed task as an experience record for later pattern analysis. Provide a success flag and optional metrics such as score, duration and step count.",
			parameters: {
				type: "object",
				properties: {
					taskId: {
						type: "string",
						description: "Optional task identifier linking this experience to a run."
					},
					prompt: {
						type: "string",
						description: "The task prompt or instruction; long text is clamped."
					},
					summary: {
						type: "string",
						description: "Short human summary of what happened."
					},
					success: {
						type: "boolean",
						description: "Whether the task succeeded."
					},
					score: {
						type: "number",
						description: "Optional quality score between 0 and 1."
					},
					durationMs: {
						type: "number",
						description: "Optional task duration in milliseconds."
					},
					stepCount: {
						type: "number",
						description: "Optional number of agent steps taken."
					},
					errors: {
						type: "array",
						items: { type: "string" },
						description: "Optional list of error messages encountered."
					},
					metadata: {
						type: "object",
						description: "Optional free-form metadata map."
					},
					versionId: {
						type: "string",
						description: "Optional evolution version ID active at the time of this outcome. Set by auto-observation; manual callers may pass it explicitly."
					}
				},
				required: ["success"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$9
			},
			execute: async (args) => {
				const a = args ?? {};
				const record = {
					taskId: typeof a.taskId === "string" ? a.taskId : void 0,
					prompt: typeof a.prompt === "string" ? clampText(a.prompt, 500) : void 0,
					summary: typeof a.summary === "string" ? clampText(a.summary, 500) : void 0,
					success: Boolean(a.success),
					score: typeof a.score === "number" ? a.score : void 0,
					durationMs: typeof a.durationMs === "number" ? a.durationMs : void 0,
					stepCount: typeof a.stepCount === "number" ? a.stepCount : void 0,
					errors: Array.isArray(a.errors) ? a.errors.map(String) : void 0,
					metadata: a.metadata && typeof a.metadata === "object" ? a.metadata : void 0,
					versionId: typeof a.versionId === "string" && a.versionId !== "" ? a.versionId : void 0
				};
				const created = await store.addExperience(record);
				return neutralizeDeep(created);
			}
		}),
		defineTool({
			name: "evo_experience_list",
			description: "List recent experience records, most recent first. Use this to survey collected task outcomes before analysis.",
			parameters: {
				type: "object",
				properties: { limit: {
					type: "number",
					description: "Maximum number of records to return. Defaults to 20."
				} },
				required: []
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$9
			},
			execute: async (args) => {
				const a = args ?? {};
				const limit = typeof a.limit === "number" ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 20;
				const records = await store.listExperiences(limit);
				return neutralizeDeep({
					count: records.length,
					records
				});
			}
		}),
		defineTool({
			name: "evo_experience_inspect",
			description: "Get the full detail of a single experience record by its id.",
			parameters: {
				type: "object",
				properties: { id: {
					type: "string",
					description: "The experience record id to inspect."
				} },
				required: ["id"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$9
			},
			execute: async (args) => {
				const a = args ?? {};
				const id = typeof a.id === "string" ? a.id : "";
				const record = await store.getExperience(id);
				return neutralizeDeep({
					found: record !== null,
					record
				});
			}
		})
	];
}
//#endregion
//#region src/host/modules/experience/index.ts
var experience_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$9,
	apply: () => apply$11,
	name: () => name$11,
	readEndpoints: () => readEndpoints$9,
	writeEndpoints: () => writeEndpoints$9
});
const name$11 = "experience";
const TOOLS$9 = [
	"evo_experience_record",
	"evo_experience_list",
	"evo_experience_inspect"
];
const readEndpoints$9 = {};
const writeEndpoints$9 = {};
function apply$11(deps) {
	for (const tool of experienceTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/analyze/tools.ts
const RENDER$8 = (_args, value) => text(value);
/** Minimum observations required before a version is considered to have enough data for a signal. */
const VERSION_OBSERVATION_MIN = 5;
/** Degradation thresholds — conservative so a single blip is not a signal. */
const DEGRADATION_SUCCESS_RATE_THRESHOLD = .6;
const DEGRADATION_ERROR_RATE_THRESHOLD = .3;
/**
* Compute a per-version degradation signal from the full experience set.
*
* Only flags a version as degraded when there are enough observations and the
* aggregate metrics cross the thresholds — not a single bad turn. This keeps
* the signal conservative and avoids noise from short observation windows.
*/
function detectVersionDegradation(experiences) {
	const byVersion = /* @__PURE__ */ new Map();
	for (const e of experiences) {
		if (!e.versionId) continue;
		const list = byVersion.get(e.versionId) ?? [];
		list.push(e);
		byVersion.set(e.versionId, list);
	}
	if (byVersion.size === 0) return null;
	let weakest = null;
	for (const [versionId, records] of byVersion) {
		if (records.length < VERSION_OBSERVATION_MIN) continue;
		const successRate = records.filter((r) => r.success).length / records.length;
		const errorRecords = records.filter((r) => !r.success);
		const errorRate = errorRecords.length / records.length;
		const stepCounts = errorRecords.map((r) => r.stepCount ?? 0).filter((n) => n > 0);
		const avgStepCount = stepCounts.length > 0 ? stepCounts.reduce((s, n) => s + n, 0) / stepCounts.length : 0;
		const signals = [];
		const isDegraded = successRate < DEGRADATION_SUCCESS_RATE_THRESHOLD || errorRate > DEGRADATION_ERROR_RATE_THRESHOLD;
		if (successRate < DEGRADATION_SUCCESS_RATE_THRESHOLD) signals.push("success-rate-low:" + (successRate * 100).toFixed(1) + "%");
		if (errorRate > DEGRADATION_ERROR_RATE_THRESHOLD) signals.push("error-rate-high:" + (errorRate * 100).toFixed(1) + "%");
		if (avgStepCount >= 15) signals.push("high-step-count:" + avgStepCount.toFixed(1));
		const signal = {
			versionId,
			total: records.length,
			successRate,
			errorRate,
			avgStepCount,
			isDegraded,
			signals
		};
		if (weakest === null || signal.total > weakest.total) weakest = signal;
	}
	return weakest;
}
/** Lightweight heuristic pattern detector over recorded experiences. */
function detectPatterns(experiences, minOccurrences) {
	const bySignature = /* @__PURE__ */ new Map();
	let successCount = 0;
	for (const e of experiences) {
		if (e.success) successCount++;
		const seed = Array.isArray(e.errors) && e.errors.length > 0 ? String(e.errors[0]) : e.summary ?? "unknown-outcome";
		const signature = clampText(seed, 80);
		const entry = bySignature.get(signature) ?? {
			count: 0,
			sample: signature,
			evidenceIds: []
		};
		entry.count++;
		if (e.id) entry.evidenceIds.push(e.id);
		bySignature.set(signature, entry);
	}
	const patterns = [];
	for (const [signature, data] of bySignature) {
		if (data.count < minOccurrences) continue;
		const isFailure = /fail|error|exception|reject|denied/i.test(signature);
		patterns.push({
			type: isFailure ? "failure" : "opportunity",
			evidence: "INFERENCE",
			description: `Recurring signature observed ${data.count} times: ${signature}`,
			occurrences: data.count,
			evidenceIds: [...new Set(data.evidenceIds)],
			confidence: Math.min(.95, .4 + data.count * .05)
		});
	}
	const failed = experiences.filter((e) => !e.success);
	if (failed.length >= minOccurrences) {
		const steps = failed.map((e) => e.stepCount ?? 0).filter((n) => n > 0);
		const avg = steps.length > 0 ? steps.reduce((s, n) => s + n, 0) / steps.length : 0;
		if (avg >= 10) patterns.push({
			type: "inefficiency",
			evidence: "INFERENCE",
			description: `Failed runs average ${avg.toFixed(1)} steps; likely redundant or retried work.`,
			occurrences: failed.length,
			evidenceIds: [...new Set(failed.map((e) => e.id).filter((id) => typeof id === "string"))],
			confidence: Math.min(.9, .3 + failed.length * .05)
		});
	}
	return patterns;
}
function analyzeTools(deps) {
	const store = deps.store;
	return [defineTool({
		name: "evo_analyze_patterns",
		description: "Analyze recorded experiences for recurring patterns such as repeated failures or inefficiencies. Detected patterns are persisted and returned.",
		parameters: {
			type: "object",
			properties: { minOccurrences: {
				type: "number",
				description: "Minimum times a signature must recur to be reported. Defaults to 3."
			} },
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$8
		},
		execute: async (args) => {
			const a = args ?? {};
			const min = typeof a.minOccurrences === "number" ? Math.max(1, Math.floor(a.minOccurrences)) : 3;
			const experiences = await store.listExperiences(500);
			const detected = detectPatterns(experiences, min);
			const existing = await store.listPatterns(500);
			const existingDescriptions = new Set(existing.map((p) => p.description));
			const fresh = detected.filter((p) => !existingDescriptions.has(p.description));
			const stored = [];
			for (const p of fresh) stored.push(await store.addPattern(p));
			return neutralizeDeep({
				analyzed: experiences.length,
				detected: fresh.length,
				patterns: stored
			});
		}
	}), defineTool({
		name: "evo_analyze_report",
		description: "Generate a summary report of all stored patterns grouped by type with average confidence.",
		parameters: {
			type: "object",
			properties: {},
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$8
		},
		execute: async () => {
			const patterns = await store.listPatterns(500);
			const byType = {};
			let confidenceSum = 0;
			for (const p of patterns) {
				byType[p.type] = (byType[p.type] ?? 0) + 1;
				confidenceSum += p.confidence;
			}
			const report = {
				totalPatterns: patterns.length,
				byType,
				averageConfidence: patterns.length > 0 ? confidenceSum / patterns.length : 0,
				patterns
			};
			return neutralizeDeep(report);
		}
	})];
}
//#endregion
//#region src/host/modules/analyze/index.ts
var analyze_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$8,
	apply: () => apply$10,
	name: () => name$10,
	readEndpoints: () => readEndpoints$8,
	writeEndpoints: () => writeEndpoints$8
});
const name$10 = "analyze";
const TOOLS$8 = ["evo_analyze_patterns", "evo_analyze_report"];
const readEndpoints$8 = {};
const writeEndpoints$8 = {};
function apply$10(deps) {
	for (const tool of analyzeTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/candidate/tools.ts
const RENDER$7 = (_args, value) => text(value);
const CANDIDATE_TYPES = [
	"policy",
	"workflow",
	"skill",
	"routing-rule",
	"verification-strategy",
	"retry-strategy",
	"tool-selection-rule"
];
function defaultBenchmarkConfig() {
	return {
		successRate: {
			min: .8,
			weight: 1
		},
		avgScore: {
			min: .7,
			weight: 1
		},
		errorRate: {
			max: .2,
			weight: 1
		},
		avgSteps: {
			max: 50,
			weight: .5
		},
		avgDurationMs: {
			max: 6e4,
			weight: .5
		}
	};
}
function candidateTools(deps) {
	const store = deps.store;
	return [
		defineTool({
			name: "evo_candidate_create",
			description: "Create a new candidate improvement module from observed evidence. Returns the created candidate in draft status.",
			parameters: {
				type: "object",
				properties: {
					type: {
						type: "string",
						enum: CANDIDATE_TYPES,
						description: "Kind of candidate improvement to propose."
					},
					name: {
						type: "string",
						description: "Short name for the candidate."
					},
					description: {
						type: "string",
						description: "What the candidate changes and why."
					},
					reason: {
						type: "string",
						description: "Rationale grounded in evidence."
					},
					evidenceIds: {
						type: "array",
						items: { type: "string" },
						description: "Ids of experiences or patterns supporting this candidate."
					},
					parentVersion: {
						type: "string",
						description: "Version this candidate is based on, e.g. v1."
					}
				},
				required: [
					"type",
					"name",
					"description",
					"reason",
					"parentVersion"
				]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$7
			},
			execute: async (args) => {
				const a = args ?? {};
				const typeRaw = typeof a.type === "string" ? a.type : "";
				const type = CANDIDATE_TYPES.includes(typeRaw) ? typeRaw : "policy";
				const candidate = await store.addCandidate({
					parentVersion: String(a.parentVersion ?? ""),
					type,
					name: clampText(String(a.name ?? ""), 200),
					description: clampText(String(a.description ?? ""), 1e3),
					reason: clampText(String(a.reason ?? ""), 1e3),
					evidenceIds: Array.from(new Set(Array.isArray(a.evidenceIds) ? a.evidenceIds.map(String) : [])),
					patternIds: Array.isArray(a.patternIds) ? a.patternIds.map(String) : [],
					files: [],
					tests: [],
					benchmarkConfig: defaultBenchmarkConfig(),
					status: "draft"
				});
				return neutralizeDeep(candidate);
			}
		}),
		defineTool({
			name: "evo_candidate_list",
			description: "List candidate improvement modules, optionally filtered by status, most recent first.",
			parameters: {
				type: "object",
				properties: {
					status: {
						type: "string",
						description: "Optional status filter: draft, validated, benchmarked, promoted, rejected."
					},
					limit: {
						type: "number",
						description: "Maximum number of candidates to return. Defaults to 50."
					}
				},
				required: []
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$7
			},
			execute: async (args) => {
				const a = args ?? {};
				const status = typeof a.status === "string" ? a.status : void 0;
				const limit = typeof a.limit === "number" ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 50;
				let candidates = await store.listCandidates(limit);
				if (status !== void 0) candidates = candidates.filter((c) => c.status === status);
				return neutralizeDeep({
					count: candidates.length,
					candidates
				});
			}
		}),
		defineTool({
			name: "evo_candidate_inspect",
			description: "Get the full detail of a single candidate module by its id.",
			parameters: {
				type: "object",
				properties: { id: {
					type: "string",
					description: "The candidate id to inspect."
				} },
				required: ["id"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$7
			},
			execute: async (args) => {
				const a = args ?? {};
				const id = typeof a.id === "string" ? a.id : "";
				const candidate = await store.getCandidate(id);
				return neutralizeDeep({
					found: candidate !== null,
					candidate
				});
			}
		})
	];
}
//#endregion
//#region src/host/modules/candidate/index.ts
var candidate_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$7,
	apply: () => apply$9,
	name: () => name$9,
	readEndpoints: () => readEndpoints$7,
	writeEndpoints: () => writeEndpoints$7
});
const name$9 = "candidate";
const TOOLS$7 = [
	"evo_candidate_create",
	"evo_candidate_list",
	"evo_candidate_inspect"
];
const readEndpoints$7 = {};
const writeEndpoints$7 = {};
function apply$9(deps) {
	for (const tool of candidateTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/benchmark/outcome.ts
/**
* Classify one sandbox execution into an end-to-end outcome using only the
* fields SandboxExecResult already carries — no invented signals.
*
* Rule order (first match wins):
*   1. OOM kill → execution-failure
*   2. Timeout → execution-failure
*   3. Spawn failure (exitCode null + non-empty stderr) → execution-failure
*   4. Non-zero exit code → unsuccessful-outcome (process ran, but did not
*      succeed; may still have emitted partial output)
*   5. Exit 0 → task-successful (the process completed; stdout presence is
*      intentionally NOT used as a success oracle because legitimate
*      benchmarks such as silent-build-tools may produce zero stdout on
*      success, and no task-specific expected-output evaluation exists in
*      the current runner.)
*
* IMPORTANT (P6 PARTIAL, see docs/AUDIT-2026-09-18.md §8):
*   The benchmark runner executes a single arbitrary shell command.
*   BenchmarkCase.expectedOutput / expectedExitCode are stored but NEVER
*   evaluated. Therefore task-successful currently means "the process exited
*   zero" — equivalent to the old `passed` field. The distinction between
*   execution-failure and unsuccessful-outcome IS new and useful: it separates
*   hard process errors (OOM/timeout/spawn-fail) from application-level
*   failure (non-zero exit) so the promotion gate can tell them apart.
*
* To make outcome a true end-to-end task oracle, the runner must:
*   (a) read manifest.benchmarkCases from candidates/<id>/manifest.json,
*   (b) run each case with its expectedOutput regex and expectedExitCode,
*   (c) map per-case results into BenchmarkExecutionResult.outcome.
*   None of (a)-(c) exists in the current codebase; adding them is a
*   structural change outside this mission's scope.
*/
function classifyOutcome(result) {
	if (result.oomKilled) return "execution-failure";
	if (result.timedOut) return "execution-failure";
	if (result.exitCode === null && result.stderr.length > 0) return "execution-failure";
	if (result.exitCode !== 0 && result.exitCode !== null) return "unsuccessful-outcome";
	return "task-successful";
}
//#endregion
//#region src/host/modules/benchmark/tools.ts
var tools_exports$2 = /* @__PURE__ */ __exportAll({ benchmarkTools: () => benchmarkTools });
const RENDER$6 = (_args, value) => text(value);
function emptyMetrics() {
	return {
		successRate: 0,
		avgScore: 0,
		errorRate: 0,
		avgSteps: 0,
		avgDurationMs: 0
	};
}
function mean(values) {
	if (values.length === 0) return 0;
	return values.reduce((s, n) => s + n, 0) / values.length;
}
/** Derive benchmark metrics from recorded experiences (proxy population). */
function computeMetrics(experienceCount, successCount, scores, errored, steps, durations) {
	const total = Math.max(1, experienceCount);
	return {
		successRate: successCount / total,
		avgScore: mean(scores),
		errorRate: errored / total,
		avgSteps: mean(steps),
		avgDurationMs: mean(durations)
	};
}
function evaluate(metrics, cfg) {
	const failed = [
		{
			label: "successRate >= " + cfg.successRate.min,
			pass: metrics.successRate >= cfg.successRate.min
		},
		{
			label: "avgScore >= " + cfg.avgScore.min,
			pass: metrics.avgScore >= cfg.avgScore.min
		},
		{
			label: "errorRate <= " + cfg.errorRate.max,
			pass: metrics.errorRate <= cfg.errorRate.max
		},
		{
			label: "avgSteps <= " + cfg.avgSteps.max,
			pass: metrics.avgSteps <= cfg.avgSteps.max
		},
		{
			label: "avgDurationMs <= " + cfg.avgDurationMs.max,
			pass: metrics.avgDurationMs <= cfg.avgDurationMs.max
		}
	].filter((c) => !c.pass).map((c) => c.label);
	return {
		passed: failed.length === 0,
		details: failed.length === 0 ? "All thresholds met." : "Failed: " + failed.join("; ")
	};
}
/** Derive metrics from a set of execution results. */
function metricsFromResults(results) {
	const total = Math.max(1, results.length);
	const successCount = results.filter((r) => r.outcome === "task-successful").length;
	const errored = results.filter((r) => r.outcome === "execution-failure").length;
	return computeMetrics(total, successCount, results.map((r) => r.score), errored, [], results.map((r) => r.durationMs));
}
/** Write candidate files (and tests) to a directory. Returns number of files written. */
async function writeCandidateFiles(candidateDir, files, tests) {
	let count = 0;
	const all = [...files, ...tests];
	for (const f of all) {
		const filePath = join(candidateDir, f.path);
		const dir = dirname(filePath);
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, f.content, "utf8");
		count++;
	}
	return count;
}
function benchmarkTools(deps) {
	const store = deps.store;
	const cfg = deps.cfg;
	return [
		defineTool({
			name: "evo_benchmark_run",
			description: "Run a benchmark comparison for a candidate against recorded experience metrics and its configured thresholds. Reports pass or fail.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id to benchmark."
					},
					runs: {
						type: "number",
						description: "Number of runs to report; clamped to configured min and max. Defaults to 3."
					}
				},
				required: ["candidateId"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$6
			},
			execute: async (args) => {
				const a = args ?? {};
				const candidateId = typeof a.candidateId === "string" ? a.candidateId : "";
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				if (candidate.status === "promoted") return neutralizeDeep({
					ok: false,
					error: "candidate already promoted"
				});
				const limits = cfg().benchmark;
				let runs = typeof a.runs === "number" ? Math.floor(a.runs) : limits.minRuns;
				runs = Math.max(limits.minRuns, Math.min(limits.maxRuns, runs));
				const experiences = await store.listExperiences(500);
				const successCount = experiences.filter((e) => e.success).length;
				const scores = experiences.map((e) => e.score).filter((s) => typeof s === "number");
				const errored = experiences.filter((e) => Array.isArray(e.errors) && e.errors.length > 0).length;
				const steps = experiences.map((e) => e.stepCount).filter((s) => typeof s === "number");
				const durations = experiences.map((e) => e.durationMs).filter((d) => typeof d === "number");
				const metrics = computeMetrics(experiences.length, successCount, scores, errored, steps, durations);
				const verdict = evaluate(metrics, candidate.benchmarkConfig);
				const run = await store.addBenchmark({
					mode: "simulated",
					candidateId,
					version: candidate.parentVersion,
					baseline: candidate.parentVersion,
					runs,
					metrics,
					passed: verdict.passed,
					details: clampText(verdict.details, 500)
				});
				await store.updateCandidate(candidateId, { status: verdict.passed ? "benchmarked" : "rejected" });
				return neutralizeDeep({
					ok: true,
					candidateId,
					benchmarkRunId: run.id,
					runs,
					metrics,
					passed: verdict.passed,
					details: verdict.details,
					evidenceMode: "simulated"
				});
			}
		}),
		defineTool({
			name: "evo_benchmark_compare",
			description: "Compare a stored benchmark run against its candidate thresholds, per metric and overall.",
			parameters: {
				type: "object",
				properties: { benchmarkId: {
					type: "string",
					description: "The benchmark run id to compare."
				} },
				required: ["benchmarkId"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$6
			},
			execute: async (args) => {
				const a = args ?? {};
				const benchmarkId = typeof a.benchmarkId === "string" ? a.benchmarkId : "";
				const run = (await store.listBenchmarks(500)).find((r) => r.id === benchmarkId);
				if (!run) return neutralizeDeep({
					ok: false,
					error: "no benchmark " + benchmarkId
				});
				const candidate = await store.getCandidate(run.candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + run.candidateId
				});
				const verdict = evaluate(run.metrics, candidate.benchmarkConfig);
				return neutralizeDeep({
					ok: true,
					benchmarkId,
					candidateId: run.candidateId,
					metrics: run.metrics,
					thresholds: candidate.benchmarkConfig,
					passed: verdict.passed,
					details: verdict.details
				});
			}
		}),
		defineTool({
			name: "evo_benchmark_live",
			description: "Execute a command in a live sandbox against a candidate file set and return detailed execution results including stdout, stderr, exit code, and timing.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id whose files to execute."
					},
					command: {
						type: "string",
						description: "The shell command to run in the sandbox (e.g. \"node test.js\")."
					},
					cwd: {
						type: "string",
						description: "Optional override for the working directory inside the temp dir. Defaults to the temp dir root."
					},
					timeoutMs: {
						type: "number",
						description: "Timeout in milliseconds. Defaults to 30000."
					},
					allowNetwork: {
						type: "boolean",
						description: "Whether to allow network access in the sandbox. Defaults to false."
					}
				},
				required: ["candidateId", "command"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$6
			},
			execute: async (args) => {
				const a = args ?? {};
				const candidateId = typeof a.candidateId === "string" ? a.candidateId : "";
				const command = typeof a.command === "string" ? a.command : "";
				const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : 3e4;
				const allowNetwork = typeof a.allowNetwork === "boolean" ? a.allowNetwork : false;
				if (!candidateId || !command) return neutralizeDeep({
					ok: false,
					error: "candidateId and command are required"
				});
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				const sandbox = getSandbox();
				if (!await sandbox.isAvailable()) return neutralizeDeep({
					ok: false,
					error: "sandbox not available"
				});
				const tmpDir = await mkdtemp(join(tmpdir(), "evo-bench-"));
				try {
					const filesDir = join(store.getRoot(), "candidates", candidateId);
					let filesWritten = 0;
					try {
						await access(filesDir);
						filesWritten = await writeCandidateFiles(tmpDir, candidate.files, candidate.tests);
					} catch {
						filesWritten = await writeCandidateFiles(tmpDir, candidate.files, candidate.tests);
					}
					if (filesWritten === 0) return neutralizeDeep({
						ok: false,
						error: "candidate has no files to execute"
					});
					const execCwd = typeof a.cwd === "string" && a.cwd ? join(tmpDir, a.cwd) : tmpDir;
					const result = await sandbox.exec(command, {
						cwd: execCwd,
						timeoutMs,
						allowNetwork
					});
					const passed = result.exitCode === 0 && !result.timedOut;
					const outcome = classifyOutcome(result);
					const executionResult = {
						caseId: "live-exec-" + candidateId,
						passed,
						score: outcome === "task-successful" ? 1 : 0,
						outcome,
						error: result.stderr || void 0,
						durationMs: result.durationMs,
						stdout: clampText(result.stdout, 1e4),
						stderr: clampText(result.stderr, 1e4),
						exitCode: result.exitCode,
						timedOut: result.timedOut
					};
					const liveMetrics = {
						successRate: outcome === "task-successful" ? 1 : 0,
						avgScore: outcome === "task-successful" ? 1 : 0,
						errorRate: outcome === "execution-failure" ? 1 : 0,
						avgSteps: 0,
						avgDurationMs: result.durationMs
					};
					const record = await store.addBenchmark({
						mode: "live",
						candidateId,
						version: candidate.parentVersion,
						baseline: candidate.parentVersion,
						parentVersion: candidate.parentVersion,
						runs: 1,
						metrics: liveMetrics,
						thresholds: candidate.benchmarkConfig,
						command: clampText(command, 500),
						passed,
						details: clampText("live sandbox execution (" + sandbox.name + "): exit " + String(result.exitCode) + (result.timedOut ? ", timed out" : "") + ", outcome=" + outcome, 500)
					});
					await store.updateCandidate(candidateId, { status: passed ? "benchmarked" : "rejected" });
					return neutralizeDeep({
						ok: true,
						candidateId,
						command,
						sandbox: sandbox.name,
						executionResult,
						outcome,
						filesWritten,
						benchmarkRunId: record.id,
						metrics: liveMetrics,
						passed,
						evidenceMode: "live"
					});
				} finally {
					await rm(tmpDir, {
						recursive: true,
						force: true
					});
				}
			}
		}),
		defineTool({
			name: "evo_benchmark_ab",
			description: "Run an A/B benchmark comparing a candidate against its baseline by executing a command in a sandbox for multiple runs and computing comparative metrics.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id to compare against baseline."
					},
					command: {
						type: "string",
						description: "The shell command to run in the sandbox for each execution (e.g. \"node test.js\")."
					},
					runs: {
						type: "number",
						description: "Number of runs for each side (baseline and candidate). Defaults to 3."
					},
					timeoutMs: {
						type: "number",
						description: "Timeout per execution in milliseconds. Defaults to 30000."
					},
					allowNetwork: {
						type: "boolean",
						description: "Whether to allow network access in the sandbox. Defaults to false."
					}
				},
				required: ["candidateId", "command"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$6
			},
			execute: async (args) => {
				const a = args ?? {};
				const candidateId = typeof a.candidateId === "string" ? a.candidateId : "";
				const command = typeof a.command === "string" ? a.command : "";
				const numRuns = typeof a.runs === "number" ? Math.max(1, Math.floor(a.runs)) : 3;
				const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : 3e4;
				const allowNetwork = typeof a.allowNetwork === "boolean" ? a.allowNetwork : false;
				if (!candidateId || !command) return neutralizeDeep({
					ok: false,
					error: "candidateId and command are required"
				});
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				const sandbox = getSandbox();
				if (!await sandbox.isAvailable()) return neutralizeDeep({
					ok: false,
					error: "sandbox not available"
				});
				async function setupSide(sideLabel, files, tests) {
					const dir = await mkdtemp(join(tmpdir(), `evo-ab-${sideLabel}-`));
					await writeCandidateFiles(dir, files, tests);
					return dir;
				}
				async function runSide(sideLabel, dir, runs) {
					const results = [];
					for (let i = 0; i < runs; i++) {
						const execResult = await sandbox.exec(command, {
							cwd: dir,
							timeoutMs,
							allowNetwork
						});
						const passed = execResult.exitCode === 0 && !execResult.timedOut;
						const outcome = classifyOutcome(execResult);
						results.push({
							caseId: `${sideLabel}-run-${i + 1}`,
							passed,
							score: outcome === "task-successful" ? 1 : 0,
							outcome,
							error: execResult.stderr || void 0,
							durationMs: execResult.durationMs,
							stdout: clampText(execResult.stdout, 1e4),
							stderr: clampText(execResult.stderr, 1e4),
							exitCode: execResult.exitCode,
							timedOut: execResult.timedOut
						});
					}
					return results;
				}
				const baselineId = candidate.parentVersion;
				let baselineCandidate = await store.getCandidate(baselineId);
				if (!baselineCandidate) {
					const activeVersion = await store.getActiveVersion();
					if (activeVersion) for (const modId of activeVersion.modules) {
						const mod = await store.getCandidate(modId);
						if (mod) {
							baselineCandidate = mod;
							break;
						}
					}
				}
				let baselineDir = null;
				let candidateDir = null;
				const allCaseResults = [];
				try {
					let baselineResults = [];
					if (baselineCandidate) {
						baselineDir = await setupSide("baseline", baselineCandidate.files, baselineCandidate.tests);
						baselineResults = await runSide("baseline", baselineDir, numRuns);
						allCaseResults.push(...baselineResults);
					}
					candidateDir = await setupSide("candidate", candidate.files, candidate.tests);
					const candidateResults = await runSide("candidate", candidateDir, numRuns);
					allCaseResults.push(...candidateResults);
					const baselineMetrics = baselineCandidate ? metricsFromResults(baselineResults) : emptyMetrics();
					const candidateMetrics = metricsFromResults(candidateResults);
					const successRateDelta = candidateMetrics.successRate - baselineMetrics.successRate;
					const scoreDelta = candidateMetrics.avgScore - baselineMetrics.avgScore;
					const errorRateDelta = candidateMetrics.errorRate - baselineMetrics.errorRate;
					const latencyDeltaMs = candidateMetrics.avgDurationMs - baselineMetrics.avgDurationMs;
					const policy = DEFAULT_PROMOTION_POLICY;
					const rejectionReasons = [];
					const baselinePassRate = baselineMetrics.successRate;
					if (successRateDelta < policy.maxRegression) rejectionReasons.push(`success rate regression: ${(successRateDelta * 100).toFixed(1)}% (max allowed: ${policy.maxRegression * 100}%)`);
					if (successRateDelta < policy.minSuccessImprovement && baselinePassRate > 0) rejectionReasons.push(`insufficient improvement: ${(successRateDelta * 100).toFixed(1)}% (min: ${policy.minSuccessImprovement * 100}%)`);
					if (baselineMetrics.avgDurationMs > 0) {
						const latencyMultiplier = candidateMetrics.avgDurationMs / baselineMetrics.avgDurationMs;
						if (latencyMultiplier > policy.maxLatencyMultiplier) rejectionReasons.push(`latency ${latencyMultiplier.toFixed(1)}x baseline (max: ${policy.maxLatencyMultiplier}x)`);
					}
					const candidatePassCount = candidateResults.filter((r) => r.passed).length;
					if (candidatePassCount < policy.minCandidateCases) rejectionReasons.push(`only ${candidatePassCount}/${numRuns} runs passed (min: ${policy.minCandidateCases})`);
					let verdict;
					if (rejectionReasons.length > 0) verdict = "baseline-wins";
					else if (successRateDelta > 0) verdict = "candidate-wins";
					else if (successRateDelta < 0) verdict = "baseline-wins";
					else verdict = "tie";
					const passed = verdict === "candidate-wins";
					const details = passed ? `Candidate wins: +${(successRateDelta * 100).toFixed(1)}% success, +${scoreDelta.toFixed(2)} score, ${latencyDeltaMs.toFixed(0)}ms latency delta.` : `Verdict: ${verdict}. ` + (rejectionReasons.length > 0 ? rejectionReasons.join("; ") : "No significant improvement.");
					const abRun = {
						id: candidateId + "-ab-" + Date.now(),
						candidateId,
						version: candidate.parentVersion,
						baseline: baselineCandidate?.id ?? "unknown",
						runs: numRuns,
						baselineMetrics,
						candidateMetrics,
						comparison: {
							successRateDelta,
							scoreDelta,
							errorRateDelta,
							latencyDeltaMs,
							verdict,
							rejectionReasons
						},
						caseResults: allCaseResults,
						passed,
						details: clampText(details, 500),
						createdAt: (/* @__PURE__ */ new Date()).toISOString()
					};
					const abRecord = await store.addBenchmark({
						mode: "live",
						candidateId,
						version: candidate.parentVersion,
						baseline: baselineCandidate?.id ?? "unknown",
						parentVersion: candidate.parentVersion,
						runs: numRuns,
						metrics: candidateMetrics,
						baselineMetrics,
						comparison: abRun.comparison,
						caseResults: allCaseResults,
						thresholds: candidate.benchmarkConfig,
						command: clampText(command, 500),
						passed,
						details: clampText(details, 500)
					});
					await store.updateCandidate(candidateId, { status: passed ? "benchmarked" : "rejected" });
					return neutralizeDeep({
						ok: true,
						benchmarkRunId: abRecord.id,
						abRun,
						summary: {
							baselineRuns: baselineCandidate ? numRuns : 0,
							candidateRuns: numRuns,
							verdict,
							passed
						},
						evidenceMode: "live"
					});
				} finally {
					if (baselineDir) await rm(baselineDir, {
						recursive: true,
						force: true
					});
					if (candidateDir) await rm(candidateDir, {
						recursive: true,
						force: true
					});
				}
			}
		})
	];
}
//#endregion
//#region src/host/modules/benchmark/index.ts
var benchmark_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$6,
	apply: () => apply$8,
	name: () => name$8,
	readEndpoints: () => readEndpoints$6,
	writeEndpoints: () => writeEndpoints$6
});
const name$8 = "benchmark";
const TOOLS$6 = [
	"evo_benchmark_run",
	"evo_benchmark_compare",
	"evo_benchmark_live",
	"evo_benchmark_ab"
];
const readEndpoints$6 = {};
const writeEndpoints$6 = {};
function apply$8(deps) {
	for (const tool of benchmarkTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/promote/tools.ts
var tools_exports$1 = /* @__PURE__ */ __exportAll({ promoteTools: () => promoteTools });
const RENDER$5 = (_args, value) => text(value);
function promoteTools(deps) {
	const store = deps.store;
	return [
		defineTool({
			name: "evo_promote",
			description: "Promote a benchmarked candidate to the active version. The previous active version is marked rolled-back. Only candidates in benchmarked status are accepted.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id to promote."
					},
					reason: {
						type: "string",
						description: "Short reason for promotion."
					}
				},
				required: ["candidateId"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$5
			},
			execute: async (args) => {
				const a = args ?? {};
				const candidateId = typeof a.candidateId === "string" ? a.candidateId : "";
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				if (candidate.status !== "benchmarked") return neutralizeDeep({
					ok: false,
					error: "candidate " + candidateId + " is " + candidate.status + "; must be benchmarked before promotion"
				});
				const { materializeArtifact, validateArtifact } = await import("./artifact-CaFGU8H7.js").then((n) => n.i);
				const { activateVersion, refreshActivation, activationState } = await Promise.resolve().then(() => loader_exports);
				const versionNumber = (await store.listVersions(200)).reduce((max, v) => Math.max(max, v.number), 0) + 1;
				const plannedVersionId = "v" + String(versionNumber);
				try {
					await materializeArtifact(store.getRoot(), {
						id: plannedVersionId,
						number: versionNumber,
						label: candidate.name,
						createdAt: (/* @__PURE__ */ new Date()).toISOString(),
						status: "active",
						modules: [candidate.id]
					}, candidate);
				} catch (error) {
					return neutralizeDeep({
						ok: false,
						error: "could not materialize the version artifact: " + String(error instanceof Error ? error.message : error)
					});
				}
				const validation = await validateArtifact(store.getRoot(), plannedVersionId);
				if (!validation.valid) return neutralizeDeep({
					ok: false,
					error: "version artifact did not validate",
					errors: validation.errors
				});
				if (await activateVersion(deps, plannedVersionId) === null) return neutralizeDeep({
					ok: false,
					error: "candidate refused by activation pre-flight; version not created",
					activationReason: activationState().reason
				});
				const version = await store.createVersion({
					label: candidate.name,
					reason: clampText(typeof a.reason === "string" ? a.reason : "", 500),
					promotedFrom: candidate.parentVersion,
					modules: [candidate.id]
				});
				await store.updateCandidate(candidateId, { status: "promoted" });
				if (version.id !== plannedVersionId) await materializeArtifact(store.getRoot(), version, candidate);
				await refreshActivation(deps);
				const state = activationState();
				return neutralizeDeep({
					ok: true,
					version,
					candidateId,
					activation: {
						mountedVersionId: state.activeVersionId,
						mountedTool: state.activeTool,
						reason: state.reason
					}
				});
			}
		}),
		defineTool({
			name: "evo_rollback",
			description: "Rollback to a previous version, making it the active version and marking the current active one rolled-back.",
			parameters: {
				type: "object",
				properties: { versionId: {
					type: "string",
					description: "The version id to roll back to, e.g. v1."
				} },
				required: ["versionId"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$5
			},
			execute: async (args) => {
				const a = args ?? {};
				const versionId = typeof a.versionId === "string" ? a.versionId : "";
				const result = await store.rollbackVersion(versionId);
				if (!result) return neutralizeDeep({
					ok: false,
					error: "no version " + versionId
				});
				if (result.alreadyActive) return neutralizeDeep({
					ok: false,
					error: "version " + versionId + " is already active; nothing to roll back"
				});
				const { refreshActivation, activationState } = await Promise.resolve().then(() => loader_exports);
				await refreshActivation(deps);
				const state = activationState();
				return neutralizeDeep({
					ok: true,
					versionId,
					restored: result.restored,
					deactivated: result.deactivated?.id ?? null,
					activation: {
						mountedVersionId: state.activeVersionId,
						mountedTool: state.activeTool,
						reason: state.reason
					}
				});
			}
		}),
		defineTool({
			name: "evo_promote_list",
			description: "List all versions ordered by number, showing status and promoted modules.",
			parameters: {
				type: "object",
				properties: { limit: {
					type: "number",
					description: "Maximum number of versions to return. Defaults to 50."
				} },
				required: []
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$5
			},
			execute: async (args) => {
				const a = args ?? {};
				const limit = typeof a.limit === "number" ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 50;
				const versions = await store.listVersions(limit);
				return neutralizeDeep({
					count: versions.length,
					versions
				});
			}
		}),
		defineTool({
			name: "evo_promote_decision",
			description: "Read the latest benchmark evidence for a candidate and apply the promotion policy. Returns a recommendation of promote or reject with the exact metrics that justify the decision.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id to evaluate for promotion."
					},
					allowSimulated: {
						type: "boolean",
						description: "Allow a decision from simulated evidence. Defaults to false: simulated runs are not execution evidence and cannot promote a candidate unless this is explicitly set."
					}
				},
				required: ["candidateId"]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$5
			},
			execute: async (args) => {
				const a = args ?? {};
				const candidateId = typeof a.candidateId === "string" ? a.candidateId : "";
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				const latest = (await store.listBenchmarks(500)).filter((b) => b.candidateId === candidateId).sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)[0];
				if (!latest) return neutralizeDeep({
					ok: false,
					error: "no benchmark evidence for candidate " + candidateId + "; run evo_benchmark_run or evo_benchmark_ab before requesting a promotion decision"
				});
				const evidenceMode = latest.mode ?? "simulated";
				if (evidenceMode !== "live" && a.allowSimulated !== true) return neutralizeDeep({
					ok: false,
					evidenceMode,
					benchmarkRunId: latest.id,
					error: "the latest benchmark evidence is SIMULATED, not execution evidence; run evo_benchmark_live or evo_benchmark_ab to produce live evidence, or pass allowSimulated true to decide on simulated data explicitly"
				});
				const policy = DEFAULT_PROMOTION_POLICY;
				const thresholdCfg = candidate.benchmarkConfig;
				const m = latest.metrics;
				const successDelta = m.successRate - thresholdCfg.successRate.min;
				const errorDelta = m.errorRate - thresholdCfg.errorRate.max;
				const latencyRatio = thresholdCfg.avgDurationMs.max > 0 ? m.avgDurationMs / thresholdCfg.avgDurationMs.max : 0;
				const checks = [];
				checks.push({
					gate: "benchmark_passed",
					pass: latest.passed,
					actual: String(latest.passed),
					threshold: "true"
				});
				checks.push({
					gate: "min_runs",
					pass: latest.runs >= policy.minRuns,
					actual: String(latest.runs),
					threshold: String(policy.minRuns)
				});
				checks.push({
					gate: "success_improvement",
					pass: successDelta >= policy.minSuccessImprovement,
					actual: (successDelta * 100).toFixed(1) + "%",
					threshold: (policy.minSuccessImprovement * 100).toFixed(1) + "%"
				});
				checks.push({
					gate: "max_regression",
					pass: m.errorRate <= thresholdCfg.errorRate.max + Math.abs(policy.maxRegression),
					actual: (m.errorRate * 100).toFixed(1) + "%",
					threshold: ((thresholdCfg.errorRate.max + Math.abs(policy.maxRegression)) * 100).toFixed(1) + "%"
				});
				checks.push({
					gate: "latency_multiplier",
					pass: latencyRatio <= policy.maxLatencyMultiplier,
					actual: latencyRatio.toFixed(2) + "x",
					threshold: policy.maxLatencyMultiplier + "x"
				});
				const failedChecks = checks.filter((c) => !c.pass);
				const promote = failedChecks.length === 0;
				return neutralizeDeep({
					ok: true,
					candidateId,
					recommendation: promote ? "PROMOTE" : "REJECT",
					evidenceMode,
					benchmarkRunId: latest.id,
					thresholds: thresholdCfg,
					parentVersion: candidate.parentVersion,
					metrics: m,
					deltas: {
						successDelta: parseFloat(successDelta.toFixed(4)),
						errorDelta: parseFloat(errorDelta.toFixed(4)),
						latencyRatio: parseFloat(latencyRatio.toFixed(4))
					},
					checks,
					rejectionReasons: failedChecks.map((c) => c.gate + ": " + c.actual + " (required " + c.threshold + ")"),
					passed: promote,
					details: promote ? "All policy gates passed. Candidate is eligible for promotion." : "Policy gates failed: " + failedChecks.map((c) => c.gate).join(", ")
				});
			}
		})
	];
}
//#endregion
//#region src/host/modules/promote/index.ts
var promote_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$5,
	apply: () => apply$7,
	name: () => name$7,
	readEndpoints: () => readEndpoints$5,
	writeEndpoints: () => writeEndpoints$5
});
const name$7 = "promote";
const TOOLS$5 = [
	"evo_promote",
	"evo_rollback",
	"evo_promote_list",
	"evo_promote_decision"
];
const readEndpoints$5 = {};
const writeEndpoints$5 = {};
function apply$7(deps) {
	for (const tool of promoteTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/evolution/tools.ts
const RENDER$4 = (_args, value) => text(value);
function candidateTypeFor(patternType) {
	switch (patternType) {
		case "failure": return "retry-strategy";
		case "inefficiency": return "workflow";
		case "opportunity": return "routing-rule";
		case "success": return "policy";
	}
}
function evolutionTools(deps) {
	const store = deps.store;
	return [
		defineTool({
			name: "evo_status",
			description: "Show current evolution status: the active version, and counts of experiences, patterns and candidates.",
			parameters: {
				type: "object",
				properties: {},
				required: []
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$4
			},
			execute: async () => {
				const [active, experiences, patterns, candidates] = await Promise.all([
					store.getActiveVersion(),
					store.listExperiences(5e3),
					store.listPatterns(5e3),
					store.listCandidates(5e3)
				]);
				return neutralizeDeep({
					activeVersion: active,
					counts: {
						experiences: experiences.length,
						patterns: patterns.length,
						candidates: candidates.length
					}
				});
			}
		}),
		defineTool({
			name: "evo_run_cycle",
			description: "Run one evolution cycle. With analyzeOnly true (default) it only detects and reports patterns. With analyzeOnly false it also creates draft candidates from detected patterns.",
			parameters: {
				type: "object",
				properties: { analyzeOnly: {
					type: "boolean",
					description: "When true, only analyze and report. When false, also create candidates. Defaults to true."
				} },
				required: []
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$4
			},
			execute: async (args) => {
				const analyzeOnly = (args ?? {}).analyzeOnly !== false;
				const detected = detectPatterns(await store.listExperiences(500), 3);
				const existing = await store.listPatterns(500);
				const existingDescriptions = new Set(existing.map((p) => p.description));
				const fresh = detected.filter((p) => !existingDescriptions.has(p.description));
				const persisted = [];
				for (const p of fresh) persisted.push(await store.addPattern(p));
				if (analyzeOnly) return neutralizeDeep({
					analyzed: true,
					created: 0,
					patterns: persisted
				});
				const active = await store.getActiveVersion();
				const parentVersion = active ? active.id : "v0";
				const created = [];
				for (const p of persisted) {
					const candidate = await store.addCandidate({
						parentVersion,
						type: candidateTypeFor(p.type),
						name: clampText("fix: " + p.description.slice(0, 120), 200),
						description: clampText(p.description, 1e3),
						reason: clampText("Generated from pattern " + p.id + " (occurrences " + p.occurrences + ").", 1e3),
						evidenceIds: Array.isArray(p.evidenceIds) ? p.evidenceIds : [],
						patternIds: [p.id],
						files: [],
						tests: [],
						benchmarkConfig: {
							successRate: {
								min: .8,
								weight: 1
							},
							avgScore: {
								min: .7,
								weight: 1
							},
							errorRate: {
								max: .2,
								weight: 1
							},
							avgSteps: {
								max: 50,
								weight: .5
							},
							avgDurationMs: {
								max: 6e4,
								weight: .5
							}
						},
						status: "draft"
					});
					created.push(candidate);
				}
				return neutralizeDeep({
					analyzed: true,
					created: created.length,
					patterns: persisted,
					candidates: created
				});
			}
		}),
		defineTool({
			name: "evo_full_cycle",
			description: "Run the complete autonomous evolution cycle: analyze experiences, detect patterns, generate a candidate via LLM, validate, sandbox-execute, benchmark, and promote or reject based on measured evidence. Requires LLM endpoint configuration.",
			parameters: {
				type: "object",
				properties: {
					apiUrl: {
						type: "string",
						description: "LLM API endpoint URL for candidate generation."
					},
					apiKey: {
						type: "string",
						description: "LLM API access token."
					},
					model: {
						type: "string",
						description: "LLM model identifier."
					},
					testCommand: {
						type: "string",
						description: "Command to execute in sandbox for benchmarking, e.g. node test.js."
					},
					minOccurrences: {
						type: "number",
						description: "Minimum pattern occurrences to trigger analysis. Defaults to 3."
					}
				},
				required: [
					"apiUrl",
					"apiKey",
					"model",
					"testCommand"
				]
			},
			output: {
				schema: JSON_OBJECT_OUTPUT,
				render: RENDER$4
			},
			execute: async (args) => {
				const a = args ?? {};
				const steps = [];
				const cfg = deps.cfg().evolution;
				if (!cfg.generation.enabled) return neutralizeDeep({
					ok: false,
					steps: ["observe"],
					error: "evo_full_cycle: autonomous candidate generation is disabled by config (evolution.generation.enabled = false)"
				});
				steps.push("observe");
				const experiences = await store.listExperiences(500);
				if (experiences.length === 0) return neutralizeDeep({
					ok: false,
					steps,
					error: "no experiences recorded; record some first with evo_experience_record"
				});
				steps.push("analyze");
				const detected = detectPatterns(experiences, typeof a.minOccurrences === "number" ? Math.max(1, Math.floor(a.minOccurrences)) : 3);
				const existing = await store.listPatterns(500);
				const existingDescriptions = new Set(existing.map((p) => p.description));
				const fresh = detected.filter((p) => !existingDescriptions.has(p.description));
				const persisted = [];
				for (const p of fresh) persisted.push(await store.addPattern(p));
				if (persisted.length === 0) return neutralizeDeep({
					ok: false,
					steps,
					error: "no new patterns detected; need more experiences with recurring signatures"
				});
				steps.push("propose");
				const active = await store.getActiveVersion();
				const parentVersion = active ? active.id : "v0";
				const strongestPattern = persisted.sort((a, b) => b.confidence - a.confidence)[0];
				const draftCandidate = await store.addCandidate({
					parentVersion,
					type: candidateTypeFor(strongestPattern.type),
					name: clampText("auto: " + strongestPattern.description.slice(0, 120), 200),
					description: clampText(strongestPattern.description, 1e3),
					reason: clampText("Auto-generated from pattern " + strongestPattern.id + " (confidence " + strongestPattern.confidence.toFixed(2) + ").", 1e3),
					evidenceIds: Array.isArray(strongestPattern.evidenceIds) ? strongestPattern.evidenceIds : [],
					patternIds: [strongestPattern.id],
					files: [],
					tests: [],
					benchmarkConfig: {
						successRate: {
							min: .8,
							weight: 1
						},
						avgScore: {
							min: .7,
							weight: 1
						},
						errorRate: {
							max: .2,
							weight: 1
						},
						avgSteps: {
							max: 50,
							weight: .5
						},
						avgDurationMs: {
							max: 6e4,
							weight: .5
						}
					},
					status: "draft"
				});
				steps.push("build");
				const { builderTools } = await Promise.resolve().then(() => tools_exports);
				const genTool = builderTools(deps).find((t) => t.name === "evo_builder_generate");
				if (!genTool) return neutralizeDeep({
					ok: false,
					steps,
					error: "builder module not available"
				});
				let buildResult;
				try {
					buildResult = await genTool.execute({
						patternIds: [strongestPattern.id],
						parentVersion,
						apiUrl: String(a.apiUrl),
						apiKey: String(a.apiKey),
						model: String(a.model)
					}, { signal: AbortSignal.timeout(18e4) });
				} catch (error) {
					return neutralizeDeep({
						ok: false,
						steps,
						error: "LLM candidate generation failed: " + (error instanceof Error ? error.message : String(error)),
						pattern: strongestPattern.id,
						draftCandidateId: draftCandidate.id
					});
				}
				if (!buildResult || buildResult.ok !== true) return neutralizeDeep({
					ok: false,
					steps,
					error: buildResult?.error ?? "unknown build error",
					pattern: strongestPattern.id,
					draftCandidateId: draftCandidate.id
				});
				const generatedCandidateId = String(buildResult.candidateId ?? "");
				steps.push("validate");
				const validation = buildResult.validation;
				if (validation && !validation.valid) {
					await store.updateCandidate(generatedCandidateId, { status: "rejected" });
					return neutralizeDeep({
						ok: false,
						steps,
						error: "candidate validation failed",
						validationErrors: validation.errors,
						candidateId: generatedCandidateId
					});
				}
				steps.push("sandbox");
				let benchResult = null;
				try {
					const { benchmarkTools } = await Promise.resolve().then(() => tools_exports$2);
					const liveTool = benchmarkTools(deps).find((t) => t.name === "evo_benchmark_live");
					if (liveTool) benchResult = await liveTool.execute({
						candidateId: generatedCandidateId,
						command: String(a.testCommand),
						timeoutMs: 3e4
					}, { signal: AbortSignal.timeout(12e4) });
				} catch {}
				steps.push("benchmark");
				let benchmarkPassed = false;
				if (benchResult && benchResult.ok === true) benchmarkPassed = Boolean(benchResult.passed);
				if (!benchResult || benchResult.ok !== true) try {
					const { benchmarkTools } = await Promise.resolve().then(() => tools_exports$2);
					const simTool = benchmarkTools(deps).find((t) => t.name === "evo_benchmark_run");
					if (simTool) benchmarkPassed = (await simTool.execute({
						candidateId: generatedCandidateId,
						runs: 3
					}, { signal: AbortSignal.timeout(3e4) }))?.passed === true;
				} catch {}
				steps.push("promote-or-reject");
				if (!cfg.promotion.enabled) {
					await store.updateCandidate(generatedCandidateId, { status: "rejected" });
					return neutralizeDeep({
						ok: false,
						steps,
						verdict: "REJECTED",
						candidateId: generatedCandidateId,
						reason: "promotion is disabled by config (evolution.promotion.enabled = false)"
					});
				}
				if (!benchmarkPassed) {
					await store.updateCandidate(generatedCandidateId, { status: "rejected" });
					return neutralizeDeep({
						ok: false,
						steps,
						verdict: "REJECTED",
						candidateId: generatedCandidateId,
						pattern: strongestPattern.id,
						reason: "benchmark did not pass",
						benchResult: benchResult ?? null
					});
				}
				await store.updateCandidate(generatedCandidateId, { status: "benchmarked" });
				const version = await store.createVersion({
					label: clampText("auto: " + strongestPattern.description.slice(0, 80), 200),
					reason: "Autonomous evolution cycle promoted candidate " + generatedCandidateId,
					promotedFrom: parentVersion,
					modules: [generatedCandidateId]
				});
				await store.updateCandidate(generatedCandidateId, { status: "promoted" });
				return neutralizeDeep({
					ok: true,
					steps,
					verdict: "PROMOTED",
					candidateId: generatedCandidateId,
					versionId: version.id,
					pattern: strongestPattern.id,
					benchResult: benchResult ?? null
				});
			}
		})
	];
}
//#endregion
//#region src/host/modules/evolution/index.ts
var evolution_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$4,
	apply: () => apply$6,
	name: () => name$6,
	readEndpoints: () => readEndpoints$4,
	writeEndpoints: () => writeEndpoints$4
});
const name$6 = "evolution";
const TOOLS$4 = ["evo_status", "evo_run_cycle"];
const readEndpoints$4 = {};
const writeEndpoints$4 = {};
function apply$6(deps) {
	for (const tool of evolutionTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/status/index.ts
var status_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply$5,
	name: () => name$5
});
const RENDER$3 = (_a, v) => text(v);
const name$5 = "status";
function statusTool(store, version) {
	return defineTool({
		name: "evo_health",
		description: "Check plugin health: state root, schema version, record counts, active version.",
		parameters: {
			type: "object",
			properties: {}
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$3
		},
		execute: async (_args, _exec) => {
			const [experiences, patterns, candidates, versions, activeVersion] = await Promise.all([
				store.listExperiences(1e4),
				store.listPatterns(),
				store.listCandidates(),
				store.listVersions(),
				store.getActiveVersion()
			]);
			return neutralizeDeep({
				status: "ok",
				plugin: "dsh-evolution",
				version,
				stateRoot: store.getRoot(),
				schemaVersion: 1,
				activeVersion: activeVersion?.id ?? "none",
				counts: {
					experiences: experiences.length,
					patterns: patterns.length,
					candidates: candidates.length,
					versions: versions.length
				}
			});
		}
	});
}
function apply$5(deps) {
	const def = statusTool(deps.store, "0.1.0");
	const result = registerToolSafe(deps.ctx, def);
	if (!result.ok) deps.warn(`status: tool registration failed: ${result.error}`);
	deps.log("status: registered 1 tool");
}
//#endregion
//#region src/host/modules/builder/tools.ts
var tools_exports = /* @__PURE__ */ __exportAll({
	builderTools: () => builderTools,
	parseFileSetFromLLMResponse: () => parseFileSetFromLLMResponse
});
/**
* Consume one host LLM stream completely.
*
* Reads the REAL chunk contract: `text-delta` for streamed text, `block-end`
* for adapters that deliver an assembled text block instead of deltas,
* `reasoning-delta` for thinking output, `usage` in input/output naming, and
* `finish` for the terminal reason (which may be a failure).
*/
async function consumeStream(iterable) {
	let text = "";
	let reasoning = "";
	let finishKind = "unknown";
	let failure = "";
	const usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		reasoningTokens: 0
	};
	const deltaIndexes = /* @__PURE__ */ new Set();
	for await (const chunk of iterable) {
		const type = chunk.type;
		if (type === "text-delta") {
			if (typeof chunk.text === "string") text += chunk.text;
			if (typeof chunk.index === "number") deltaIndexes.add(chunk.index);
		} else if (type === "reasoning-delta") {
			if (typeof chunk.text === "string") reasoning += chunk.text;
		} else if (type === "block-end") {
			const block = chunk.block;
			const index = typeof chunk.index === "number" ? chunk.index : -1;
			if (block?.type === "text" && typeof block.text === "string" && !deltaIndexes.has(index)) text += block.text;
		} else if (type === "usage") {
			const u = chunk.usage ?? {};
			usage.inputTokens = u.inputTokens ?? 0;
			usage.outputTokens = u.outputTokens ?? 0;
			usage.reasoningTokens = u.reasoningTokens ?? 0;
			usage.totalTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
		} else if (type === "finish") {
			const reason = chunk.reason ?? {};
			finishKind = typeof reason.kind === "string" ? reason.kind : "unknown";
			if ((reason.kind === "error" || reason.kind === "aborted") && typeof reason.failure?.message === "string") failure = reason.failure.message;
		}
	}
	return {
		text,
		reasoning,
		finishKind,
		failure,
		usage
	};
}
async function callHostLLM(deps, systemPrompt, userPrompt, overrides) {
	const selection = deps.ctx.get("agentDefaultModel")?.currentSelection();
	const provider = overrides?.provider ?? selection?.provider ?? "";
	const model = overrides?.model ?? selection?.model ?? "";
	if (!provider || !model) throw new Error("no configured LLM model; set provider/model in agent-default-model settings or pass overrides");
	const llm = deps.ctx.get("llm");
	if (!llm) throw new Error("LLM service not available on host context");
	const options = {
		provider,
		model,
		system: systemPrompt,
		messages: [{
			id: "evo-" + Date.now().toString(36),
			role: "user",
			content: [{
				type: "text",
				text: userPrompt
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-evolution"
			}
		}],
		maxTokens: 8192
	};
	let outcome = await consumeStream(llm.stream(options));
	if (outcome.failure !== "") throw new Error("LLM call failed (" + outcome.finishKind + "): " + outcome.failure);
	if (outcome.text.trim() === "") {
		const retry = await consumeStream(llm.stream({
			...options,
			system: systemPrompt + "\n\nIMPORTANT: reply with the JSON object only. No analysis, no preamble, and no markdown fences."
		}));
		if (retry.failure !== "") throw new Error("LLM call failed on retry (" + retry.finishKind + "): " + retry.failure);
		if (retry.text.trim() !== "") outcome = retry;
		else if (retry.reasoning.includes("{")) return {
			content: retry.reasoning,
			usage: retry.usage,
			rescuedFromReasoning: true
		};
	}
	if (outcome.text.trim() === "") throw new Error("the model returned no text (finish=" + outcome.finishKind + ", reasoningChars=" + outcome.reasoning.length + ", outputTokens=" + outcome.usage.outputTokens + ", reasoningTokens=" + outcome.usage.reasoningTokens + ")");
	return {
		content: outcome.text,
		usage: outcome.usage,
		rescuedFromReasoning: false
	};
}
function validateCandidateFileSet(fileSet) {
	const errors = [];
	const warnings = [];
	if (!fileSet.manifest.name) errors.push("manifest.name is required");
	if (!fileSet.manifest.description) errors.push("manifest.description is required");
	if (!fileSet.manifest.entryPoint) errors.push("manifest.entryPoint is required");
	if (!fileSet.manifest.type) errors.push("manifest.type is required");
	const allFiles = [...fileSet.files, ...fileSet.tests];
	for (const file of allFiles) {
		if (file.path.includes("..")) errors.push("path traversal in: " + file.path);
		if (file.path.startsWith("/")) errors.push("absolute path: " + file.path);
		const ext = file.path.split(".").pop()?.toLowerCase();
		if (ext && ![
			"ts",
			"js",
			"json",
			"md",
			"yml",
			"yaml",
			"txt"
		].includes(ext)) errors.push("unsupported file type: " + ext + " in " + file.path);
		if (file.path.endsWith(".sh") || file.path.endsWith(".exe")) errors.push("executable artifact not allowed: " + file.path);
	}
	const paths = allFiles.map((f) => f.path);
	const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
	if (dupes.length > 0) errors.push("duplicate files: " + dupes.join(", "));
	if (!allFiles.some((f) => f.path === fileSet.manifest.entryPoint)) warnings.push("entryPoint not found in candidate files");
	if (fileSet.tests.length === 0) warnings.push("no test files provided");
	if (fileSet.manifest.benchmarkCases.length === 0) errors.push("no benchmark cases defined");
	return {
		valid: errors.length === 0,
		errors,
		warnings
	};
}
/**
* Coerce a parsed object into the file-set shape. Real models return `files`
* as either an array of {path, content} or a plain path->content map, and may
* omit `tests` entirely.
*/
function toFileArray(value) {
	if (Array.isArray(value)) return value.filter((entry) => entry !== null && typeof entry === "object").filter((entry) => typeof entry.path === "string").map((entry) => ({
		path: String(entry.path),
		content: typeof entry.content === "string" ? entry.content : ""
	}));
	if (value !== null && typeof value === "object") return Object.entries(value).filter(([, v]) => typeof v === "string").map(([k, v]) => ({
		path: k,
		content: v
	}));
	return [];
}
function normalizeFileSet(parsed) {
	const root = parsed ?? {};
	const manifest = root.manifest ?? root;
	const rawManifest = manifest;
	const cases = Array.isArray(manifest.benchmarkCases) ? manifest.benchmarkCases : [];
	return {
		manifest: {
			...rawManifest,
			name: typeof manifest.name === "string" ? manifest.name : "candidate",
			version: typeof manifest.version === "string" ? manifest.version : "1.0.0",
			description: typeof manifest.description === "string" ? manifest.description : "",
			entryPoint: typeof manifest.entryPoint === "string" ? manifest.entryPoint : "src/index.ts",
			benchmarkCases: cases
		},
		files: toFileArray(root.files),
		tests: toFileArray(root.tests)
	};
}
/** Remove trailing commas that some models emit, without touching strings. */
function stripTrailingCommas(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			out += ch;
			escaped = true;
			continue;
		}
		if (ch === "\"") {
			inString = !inString;
			out += ch;
			continue;
		}
		if (!inString && ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j += 1;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}
/**
* Extract a candidate file set from a model response. Models wrap JSON in
* prose or fences, so try, in order: the raw text, every fenced block, and the
* outermost brace-balanced span — each with and without trailing-comma repair.
*/
function parseFileSetFromLLMResponse(content) {
	const attempts = [];
	const trimmed = content.trim();
	if (trimmed !== "") attempts.push(trimmed);
	for (const fence of content.matchAll(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g)) if (fence[1] && fence[1].trim() !== "") attempts.push(fence[1].trim());
	const firstBrace = content.indexOf("{");
	const lastBrace = content.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(content.slice(firstBrace, lastBrace + 1));
	for (const attempt of attempts) for (const variant of [attempt, stripTrailingCommas(attempt)]) try {
		const fileSet = normalizeFileSet(JSON.parse(variant));
		if (fileSet.files.length > 0) return fileSet;
	} catch {}
	const head = content.trim().slice(0, 200).replace(/\s+/g, " ");
	throw new Error("no parseable JSON file set in the model response (length " + content.length + "); head: " + head);
}
function buildSystemPrompt() {
	return "You are an expert DSH plugin developer. Generate a candidate improvement module.\n\nYou MUST return a single JSON object with this exact shape:\n{\n  \"manifest\": {\n    \"name\": \"short-name\",\n    \"version\": \"1.0.0\",\n    \"type\": \"<one of: policy, workflow, skill, routing-rule, verification-strategy, retry-strategy, tool-selection-rule>\",\n    \"description\": \"what this module does\",\n    \"entryPoint\": \"src/index.ts\",\n    \"benchmarkCases\": [\n      {\n        \"id\": \"case-1\",\n        \"description\": \"test case description\",\n        \"input\": \"the test input\",\n        \"expectedOutput\": \"regex pattern or exact string\",\n        \"expectedExitCode\": 0,\n        \"timeoutMs\": 10000,\n        \"successCriteria\": \"what success looks like\"\n      }\n    ]\n  },\n  \"files\": [\n    { \"path\": \"src/index.ts\", \"content\": \"...\" }\n  ],\n  \"tests\": [\n    { \"path\": \"test/index.spec.ts\", \"content\": \"...\" }\n  ]\n}\n\nRULES:\n- Files MUST use .ts or .js extension only\n- Paths MUST be relative (no leading /)\n- No path traversal (no ../)\n- Include at least one benchmark case\n- Include at least one test file\n- The module must be self-contained\n- Do NOT attempt to modify DSH core or other plugins\n- The entryPoint must exist in the files array\n\nReturn ONLY the JSON object. No markdown. No explanation.";
}
function buildUserPrompt(patterns, experiences, parentVersion) {
	const patternSummary = patterns.map((p) => "- Pattern " + p.id + " (" + p.type + "): " + p.description + " (occurrences: " + p.occurrences + ", confidence: " + p.confidence + ")").join("\n");
	const recentFailures = experiences.filter((e) => !e.success).slice(0, 10).map((e) => "- Task " + (e.taskId ?? "unknown") + ": " + (e.summary ?? e.prompt ?? "no summary") + " | errors: " + (e.errors ?? []).join(", ")).join("\n");
	return "Parent version: " + parentVersion + "\n\nOBSERVED PATTERNS:\n" + patternSummary + "\n\nRECENT FAILURES:\n" + (recentFailures || "(none)") + "\n\nGenerate a candidate module that addresses the observed patterns. The module should propose a concrete improvement to reduce the failure rate or improve efficiency.";
}
function builderTools(deps) {
	const store = deps.store;
	return [defineTool({
		name: "evo_builder_generate",
		description: "Use the configured DSH LLM to generate a candidate module from observed patterns and experiences. The LLM generates source files, tests, manifest, and benchmark cases. Generated files are validated for safety before acceptance. The LLM endpoint is read from the host agent-default-model settings; pass provider/model overrides for testing.",
		parameters: {
			type: "object",
			properties: {
				patternIds: {
					type: "array",
					items: { type: "string" },
					description: "Pattern ids to base the candidate on."
				},
				parentVersion: {
					type: "string",
					description: "Version to build against, e.g. v1."
				},
				providerOverride: {
					type: "string",
					description: "Optional provider override (default: host agent-default-model)."
				},
				modelOverride: {
					type: "string",
					description: "Optional model override (default: host agent-default-model)."
				}
			},
			required: ["patternIds", "parentVersion"]
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: (_a, v) => text(v)
		},
		execute: async (args) => {
			const a = args ?? {};
			const patternIds = a.patternIds ?? [];
			const patterns = (await store.listPatterns(500)).filter((p) => patternIds.includes(p.id));
			if (patterns.length === 0) return neutralizeDeep({
				ok: false,
				error: "no matching patterns found"
			});
			const experiences = await store.listExperiences(50);
			const systemPrompt = buildSystemPrompt();
			const userPrompt = buildUserPrompt(patterns, experiences, String(a.parentVersion));
			let llmResponse;
			try {
				llmResponse = await callHostLLM(deps, systemPrompt, userPrompt, {
					provider: a.providerOverride,
					model: a.modelOverride
				});
			} catch (error) {
				return neutralizeDeep({
					ok: false,
					error: "LLM call failed: " + (error instanceof Error ? error.message : String(error))
				});
			}
			let fileSet;
			try {
				fileSet = parseFileSetFromLLMResponse(llmResponse.content);
			} catch (error) {
				return neutralizeDeep({
					ok: false,
					error: "Failed to parse LLM response: " + (error instanceof Error ? error.message : String(error))
				});
			}
			const validation = validateCandidateFileSet(fileSet);
			if (!validation.valid) return neutralizeDeep({
				ok: false,
				error: "Candidate validation failed",
				errors: validation.errors
			});
			const resolvedEvidenceIds = /* @__PURE__ */ new Set();
			for (const p of patterns) if (Array.isArray(p.evidenceIds)) {
				for (const eid of p.evidenceIds) if (typeof eid === "string" && eid !== "") resolvedEvidenceIds.add(eid);
			}
			const candidate = await store.addCandidate({
				parentVersion: String(a.parentVersion),
				type: fileSet.manifest.type,
				name: fileSet.manifest.name,
				description: fileSet.manifest.description,
				reason: "LLM-generated from patterns: " + patterns.map((p) => p.id).join(", "),
				evidenceIds: [...resolvedEvidenceIds],
				patternIds,
				files: fileSet.files,
				tests: fileSet.tests,
				benchmarkConfig: {
					successRate: {
						min: .8,
						weight: 1
					},
					avgScore: {
						min: .7,
						weight: 1
					},
					errorRate: {
						max: .2,
						weight: 1
					},
					avgSteps: {
						max: 50,
						weight: .5
					},
					avgDurationMs: {
						max: 6e4,
						weight: .5
					}
				},
				status: "draft"
			});
			const candidatesDir = join(store.getRoot(), "candidates", candidate.id);
			await mkdir(candidatesDir, { recursive: true });
			for (const file of [...fileSet.files, ...fileSet.tests]) {
				const filePath = join(candidatesDir, file.path);
				await mkdir(dirname(filePath), { recursive: true });
				await writeFile(filePath, file.content, "utf8");
			}
			await writeFile(join(candidatesDir, "manifest.json"), JSON.stringify(fileSet.manifest, null, 2), "utf8");
			return neutralizeDeep({
				ok: true,
				candidateId: candidate.id,
				filesDir: candidatesDir,
				files: fileSet.files.map((f) => f.path),
				tests: fileSet.tests.map((f) => f.path),
				manifest: fileSet.manifest,
				validation,
				llmUsage: llmResponse.usage,
				rescuedFromReasoning: llmResponse.rescuedFromReasoning
			});
		}
	})];
}
//#endregion
//#region src/host/modules/builder/index.ts
var builder_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$3,
	apply: () => apply$4,
	name: () => name$4,
	readEndpoints: () => readEndpoints$3,
	writeEndpoints: () => writeEndpoints$3
});
const name$4 = "builder";
const TOOLS$3 = ["evo_builder_generate"];
const readEndpoints$3 = {};
const writeEndpoints$3 = {};
function apply$4(deps) {
	for (const tool of builderTools(deps)) registerToolSafe(deps.ctx, tool);
}
//#endregion
//#region src/host/modules/activation/loader.ts
/**
* Activation: making the ACTIVE version's artifact live inside a running host.
*
* Boot path: dsh-evolution's apply() calls {@link refreshActivation}, which
* reads the active version, validates its artifact, runs the sandbox
* pre-flight, and mounts the generated plugin through `ctx.plugin`.
*
* Runtime path: promotion and rollback call the same function, so the live
* process reflects the new active version without a restart.
*
* Safety: nothing here imports candidate code. The imported module is the
* host-authored `plugin.js`; candidate files only ever execute inside the
* sandbox (pre-flight and tool calls alike).
*/
var loader_exports = /* @__PURE__ */ __exportAll({
	activateVersion: () => activateVersion,
	activationState: () => activationState,
	createRuntimeService: () => createRuntimeService,
	deactivate: () => deactivate,
	refreshActivation: () => refreshActivation,
	setActivationSandbox: () => setActivationSandbox
});
const state = {
	activeVersionId: null,
	activeTool: null,
	reason: null,
	preflight: null
};
let mountedFiber = null;
let sandboxRef = null;
/**
* The sandbox used for pre-flight and for the activated tool. Falls back to the
* shared singleton, so activation never depends on module mount order.
*/
function runner() {
	return sandboxRef ?? getSandbox();
}
function activationState() {
	return {
		...state,
		preflight: state.preflight === null ? null : { ...state.preflight }
	};
}
function setActivationSandbox(runner) {
	sandboxRef = runner;
}
/**
* Run the version's code inside the sandbox and require a clean exit. This is
* real execution evidence, not a filesystem check.
*/
async function runInSandbox(deps, cwd, command, timeoutMs) {
	const sandbox = runner();
	try {
		if (!await sandbox.isAvailable()) return {
			ok: false,
			detail: "sandbox is not available on this host"
		};
		const result = await sandbox.exec(command, {
			cwd,
			timeoutMs
		});
		const ok = result.exitCode === 0 && !result.timedOut;
		return {
			ok,
			detail: command + " -> exit " + String(result.exitCode) + (result.timedOut ? " (timed out)" : "") + (ok ? "" : " :: " + (result.stderr || result.stdout).slice(0, 300))
		};
	} catch (error) {
		return {
			ok: false,
			detail: command + " failed: " + errorMessage(error)
		};
	}
}
/**
* Pre-flight an artifact before the host loads it:
*  1. the generated plugin must be syntactically valid JavaScript;
*  2. the candidate's own entry must execute cleanly in the sandbox.
* A candidate that cannot pass both is never activated.
*/
async function preflight(deps, versionId, manifest) {
	const root = deps.store.getRoot();
	const syntax = await runInSandbox(deps, versionDir(root, versionId), "node --check plugin.js", 15e3);
	if (!syntax.ok) return {
		ok: false,
		syntaxOk: false,
		behaviorOk: false,
		detail: "generated plugin.js failed syntax check: " + syntax.detail
	};
	const behavior = await runInSandbox(deps, artifactFilesDir(root, versionId), manifest.testCommand, 3e4);
	return {
		ok: behavior.ok,
		syntaxOk: true,
		behaviorOk: behavior.ok,
		detail: syntax.detail + " | " + behavior.detail
	};
}
/** Unmount whatever is currently active. Safe to call when nothing is mounted. */
async function deactivate(reason) {
	const fiber = mountedFiber;
	mountedFiber = null;
	state.activeVersionId = null;
	state.activeTool = null;
	state.preflight = null;
	state.reason = reason;
	if (fiber && typeof fiber.dispose === "function") try {
		await fiber.dispose();
	} catch {}
}
/**
* Load the artifact for one version and mount it.
* @returns the mounted tool name, or null with {@link activationState}.reason set.
*/
async function activateVersion(deps, versionId) {
	const root = deps.store.getRoot();
	await deactivate(null);
	const validation = await validateArtifact(root, versionId);
	if (!validation.valid) {
		state.reason = "artifact for " + versionId + " is not loadable: " + validation.errors.join("; ");
		return null;
	}
	const manifest = await readArtifactManifest(root, versionId);
	if (!manifest) {
		state.reason = "artifact manifest for " + versionId + " disappeared during validation";
		return null;
	}
	const flight = await preflight(deps, versionId, manifest);
	if (!flight.ok) {
		state.reason = "pre-flight refused " + versionId + ": " + flight.detail;
		return null;
	}
	const pluginPath = artifactPluginPath(root, versionId);
	let module;
	try {
		module = await import(pathToFileURL(pluginPath).href);
	} catch (error) {
		state.reason = "importing the generated plugin failed: " + errorMessage(error);
		return null;
	}
	const ctx = deps.ctx;
	if (typeof ctx.plugin !== "function") {
		state.reason = "the host context does not expose ctx.plugin; dynamic activation is unavailable";
		return null;
	}
	try {
		const fiber = ctx.plugin(module, {
			versionId,
			candidateId: manifest.candidateId,
			toolName: manifest.toolName,
			testCommand: manifest.testCommand
		});
		await fiber;
		mountedFiber = fiber;
	} catch (error) {
		state.reason = "mounting the generated plugin failed: " + errorMessage(error);
		return null;
	}
	state.activeVersionId = versionId;
	state.activeTool = manifest.toolName;
	state.reason = null;
	state.preflight = {
		syntaxOk: flight.syntaxOk,
		behaviorOk: flight.behaviorOk,
		detail: flight.detail
	};
	deps.log("activation: mounted " + manifest.toolName + " for " + versionId);
	return manifest.toolName;
}
/**
* Bring the mounted plugin in line with the ACTIVE version. Called at boot and
* after every promotion/rollback. Never throws.
*/
async function refreshActivation(deps) {
	try {
		const active = await deps.store.getActiveVersion();
		if (!active) {
			await deactivate("no active version");
			return;
		}
		if (!active.modules[0]) {
			await deactivate("active version " + active.id + " has no promoted module");
			return;
		}
		if (await activateVersion(deps, active.id) === null) deps.warn("activation: " + String(state.reason));
	} catch (error) {
		await deactivate("activation failed: " + errorMessage(error));
		deps.warn("activation: " + String(state.reason));
	}
}
function createRuntimeService(deps) {
	return { async runCandidate(request) {
		const root = deps.store.getRoot();
		const versionId = request.versionId;
		const manifest = await readArtifactManifest(root, versionId);
		if (!manifest) return {
			ok: false,
			error: "no artifact for version " + versionId,
			versionId
		};
		const sandbox = runner();
		if (!await sandbox.isAvailable()) return {
			ok: false,
			error: "sandbox is not available on this host",
			versionId
		};
		const command = request.command ?? manifest.testCommand;
		const cwd = artifactFilesDir(root, versionId);
		const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : 3e4;
		const result = await sandbox.exec(command, {
			cwd,
			timeoutMs
		});
		return {
			ok: true,
			passed: result.exitCode === 0 && !result.timedOut,
			versionId,
			candidateId: manifest.candidateId,
			tool: manifest.toolName,
			command,
			sandbox: sandbox.name,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			durationMs: result.durationMs,
			stdout: result.stdout.slice(0, 1e4),
			stderr: result.stderr.slice(0, 1e4)
		};
	} };
}
//#endregion
//#region src/host/modules/auto-experience/index.ts
var auto_experience_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$2,
	apply: () => apply$3,
	autoGuardState: () => autoGuardState,
	name: () => name$3,
	observeTurn: () => observeTurn,
	readEndpoints: () => readEndpoints$2,
	resetAutoGuards: () => resetAutoGuards,
	runAutoCycle: () => runAutoCycle,
	writeEndpoints: () => writeEndpoints$2
});
const name$3 = "auto-experience";
const TOOLS$2 = ["evo_auto_record", "evo_observe_state"];
const readEndpoints$2 = {};
const writeEndpoints$2 = {};
const RENDER$2 = (_a, v) => text(v);
/** Extract plain text from model-facing content blocks, skipping non-text. */
function textFromContent(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block && typeof block === "object" && block.type === "text") {
		const value = block.text;
		if (typeof value === "string") parts.push(value);
	}
	return parts.join("\n");
}
/**
* Project one completed turn onto an experience record using the REAL host
* contract: `turn/end` carries only `{ turn, reason }`, so everything else is
* derived from the session log the listener also receives.
*/
function observeTurn(session, event) {
	if (event.type !== "turn/end") return null;
	const turn = typeof event.data.turn === "number" ? event.data.turn : -1;
	const reason = event.data.reason ?? {};
	const events = Array.isArray(session.events) ? session.events : [];
	let promptText = "";
	let stepCount = 0;
	let turnStartTime = event.time;
	const toolCallNames = [];
	let inTurn = false;
	for (const item of events) {
		const itemTurn = typeof item.data?.turn === "number" ? item.data.turn : void 0;
		if (item.type === "turn/start") {
			inTurn = itemTurn === turn;
			if (inTurn) turnStartTime = item.time;
			continue;
		}
		if (item.type === "turn/end") {
			if (itemTurn === turn) break;
			inTurn = false;
			continue;
		}
		if (!inTurn) continue;
		if (item.type === "step/start") stepCount += 1;
		else if (item.type === "user/message") {
			if ((item.data?.source)?.kind === "user") promptText = textFromContent(item.data?.content);
		} else if (item.type === "tool/call") {
			const toolName = item.data?.name;
			if (typeof toolName === "string" && toolCallNames.length < 64) toolCallNames.push(toolName);
		}
	}
	const reasonKind = typeof reason.kind === "string" ? reason.kind : "unknown";
	const success = reasonKind === "completed";
	const errors = [];
	if (reasonKind === "error") {
		const message = reason.error?.message;
		errors.push(typeof message === "string" && message !== "" ? clampText(message, 500) : "turn failed");
	} else if (reasonKind === "aborted") errors.push("turn aborted");
	else if (reasonKind === "blocked") errors.push("turn blocked");
	else if (reasonKind === "max-tokens") errors.push("step reached output-token ceiling");
	return {
		sessionId: typeof session.header?.id === "string" ? session.header.id : "unknown-session",
		turn,
		prompt: promptText === "" ? void 0 : clampText(promptText, 2e3),
		success,
		reasonKind,
		errors: errors.length > 0 ? errors : void 0,
		stepCount,
		durationMs: Math.max(0, event.time - turnStartTime),
		toolCallNames
	};
}
/**
* Autonomous loop guards, one per host process. These bound the loop so a
* misconfiguration cannot spin: a single in-flight cycle, a hard per-process
* cycle cap, and a re-analysis interval measured in NEW experiences.
*/
const guards = {
	inFlight: false,
	cyclesRun: 0,
	lastCycleExperienceCount: -1
};
function resetAutoGuards() {
	guards.inFlight = false;
	guards.cyclesRun = 0;
	guards.lastCycleExperienceCount = -1;
}
function autoGuardState() {
	return { ...guards };
}
/**
* Run analysis (and optionally generation + promotion) when enough evidence
* exists. Deterministic host code owns every safety decision; the LLM only
* proposes. Never throws: the caller is an event listener.
*/
async function runAutoCycle(deps) {
	const cfg = deps.cfg().evolution;
	if (!cfg.enabled || !cfg.autoTrigger) return {
		ran: false,
		reason: "auto trigger disabled"
	};
	if (guards.inFlight) return {
		ran: false,
		reason: "a cycle is already running"
	};
	if (guards.cyclesRun >= cfg.maxCyclesPerProcess) return {
		ran: false,
		reason: "per-process cycle cap reached"
	};
	guards.inFlight = true;
	try {
		const experiences = await deps.store.listExperiences(cfg.analysis.minExperiences * 4);
		if (experiences.length < cfg.analysis.minExperiences) return {
			ran: false,
			reason: "not enough experiences: " + experiences.length + " of " + cfg.analysis.minExperiences
		};
		if (guards.lastCycleExperienceCount >= 0 && experiences.length - guards.lastCycleExperienceCount < cfg.analysis.minExperiences) return {
			ran: false,
			reason: "waiting for more new experiences"
		};
		const detected = detectPatterns(experiences, cfg.analysis.minOccurrences);
		const existing = await deps.store.listPatterns(500);
		const seen = new Set(existing.map((p) => p.description));
		const pending = detected.filter((p) => !seen.has(p.description));
		const fresh = [];
		for (const p of pending) {
			const storedPattern = await deps.store.addPattern(p);
			fresh.push({
				id: storedPattern.id,
				confidence: storedPattern.confidence
			});
		}
		guards.lastCycleExperienceCount = experiences.length;
		if (fresh.length === 0) return {
			ran: false,
			reason: "no actionable recurring pattern",
			patterns: 0
		};
		guards.cyclesRun += 1;
		deps.log("auto-cycle: " + fresh.length + " new pattern(s) from " + experiences.length + " experiences");
		if (!cfg.generation.enabled) return {
			ran: true,
			reason: "patterns recorded; generation disabled",
			patterns: fresh.length
		};
		const { builderTools } = await Promise.resolve().then(() => tools_exports);
		const build = builderTools(deps).find((t) => t.name === "evo_builder_generate");
		if (!build) return {
			ran: true,
			reason: "builder unavailable",
			patterns: fresh.length
		};
		const strongest = [...fresh].sort((a, b) => b.confidence - a.confidence)[0];
		const active = await deps.store.getActiveVersion();
		const built = await build.execute({
			patternIds: [strongest.id],
			parentVersion: active ? active.id : "v0"
		}, { signal: AbortSignal.timeout(18e4) });
		if (built?.ok !== true || typeof built.candidateId !== "string") return {
			ran: true,
			reason: "generation failed: " + String(built?.error ?? "unknown"),
			patterns: fresh.length
		};
		if (!cfg.promotion.enabled) return {
			ran: true,
			reason: "candidate generated; promotion disabled",
			patterns: fresh.length,
			candidateId: built.candidateId
		};
		const { promoteTools } = await Promise.resolve().then(() => tools_exports$1);
		const decision = promoteTools(deps).find((t) => t.name === "evo_promote_decision");
		if (!decision) return {
			ran: true,
			reason: "promote module unavailable",
			patterns: fresh.length
		};
		const verdict = await decision.execute({ candidateId: built.candidateId }, { signal: AbortSignal.timeout(6e4) });
		return {
			ran: true,
			reason: "candidate generated and evaluated",
			patterns: fresh.length,
			candidateId: built.candidateId,
			verdict: verdict?.recommendation
		};
	} catch (error) {
		return {
			ran: false,
			reason: "cycle failed: " + String(error instanceof Error ? error.message : error)
		};
	} finally {
		guards.inFlight = false;
	}
}
function apply$3(deps) {
	const store = deps.store;
	const recordTool = {
		name: "evo_auto_record",
		description: "Record a completed agent task as an experience record. The host also records turns automatically; use this for out-of-band observations.",
		parameters: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
					description: "Optional task or session identifier."
				},
				prompt: {
					type: "string",
					description: "The task prompt."
				},
				summary: {
					type: "string",
					description: "Short human summary."
				},
				success: {
					type: "boolean",
					description: "Whether the task succeeded."
				},
				errors: {
					type: "array",
					items: { type: "string" },
					description: "Error messages encountered."
				},
				durationMs: {
					type: "number",
					description: "Duration in milliseconds."
				},
				stepCount: {
					type: "number",
					description: "Number of agent steps."
				},
				score: {
					type: "number",
					description: "Optional quality score between 0 and 1."
				}
			},
			required: ["success"]
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$2
		},
		execute: async (args) => {
			const a = args ?? {};
			const record = await store.addExperience({
				taskId: typeof a.taskId === "string" ? a.taskId : void 0,
				prompt: typeof a.prompt === "string" ? clampText(a.prompt, 2e3) : void 0,
				summary: typeof a.summary === "string" ? clampText(a.summary, 500) : void 0,
				success: Boolean(a.success),
				errors: Array.isArray(a.errors) ? a.errors.map((e) => clampText(String(e), 500)) : void 0,
				durationMs: typeof a.durationMs === "number" ? a.durationMs : void 0,
				stepCount: typeof a.stepCount === "number" ? a.stepCount : void 0,
				score: typeof a.score === "number" ? a.score : void 0
			});
			return neutralizeDeep({
				ok: true,
				id: record.id
			});
		}
	};
	const stateTool = {
		name: "evo_observe_state",
		description: "Report the automatic observation state: how many turns were observed, the guard counters that bound the autonomous loop, and the configured thresholds.",
		parameters: {
			type: "object",
			properties: {},
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$2
		},
		execute: async () => {
			const cfg = deps.cfg().evolution;
			const experiences = await store.listExperiences(1e4);
			const observed = observations.length;
			return neutralizeDeep({
				observedTurnsThisProcess: observed,
				lastObservation: observations.length > 0 ? observations[observations.length - 1] : null,
				guards: autoGuardState(),
				thresholds: {
					minExperiences: cfg.analysis.minExperiences,
					minOccurrences: cfg.analysis.minOccurrences,
					generationEnabled: cfg.generation.enabled,
					promotionEnabled: cfg.promotion.enabled,
					maxCyclesPerProcess: cfg.maxCyclesPerProcess
				},
				storedExperiences: experiences.length
			});
		}
	};
	registerToolSafe(deps.ctx, recordTool);
	registerToolSafe(deps.ctx, stateTool);
	observations.length = 0;
	deps.ctx.on("session/event", ((session, event) => {
		try {
			if (!deps.cfg().evolution.enabled || !deps.cfg().evolution.autoRecord) return;
			const observed = observeTurn(session, event);
			if (!observed) return;
			if (observations.length < 50) observations.push(observed);
			const versionId = activationState().activeVersionId;
			store.addExperience({
				taskId: observed.sessionId + "#" + observed.turn,
				prompt: observed.prompt,
				summary: "turn ended: " + observed.reasonKind,
				success: observed.success,
				errors: observed.errors,
				durationMs: observed.durationMs,
				stepCount: observed.stepCount,
				versionId: versionId ?? void 0,
				metadata: {
					sessionId: observed.sessionId,
					turn: observed.turn,
					reason: observed.reasonKind,
					toolCalls: observed.toolCallNames
				}
			}).then(() => runAutoCycle(deps)).catch(() => {});
		} catch {}
	}));
	deps.log("auto-experience: registered evo_auto_record, evo_observe_state, session/event hook");
}
/** In-process observation ring, exposed for diagnostics via evo_observe_state. */
const observations = [];
//#endregion
//#region src/host/modules/activation/index.ts
/**
* Activation module: the boot-time and runtime side of candidate activation.
*
* It provides the `evolutionRuntime` service the generated artifact calls, and
* exposes diagnostics. The heavy lifting lives in ./artifact.ts (build the
* loadable package) and ./loader.ts (validate, pre-flight, mount).
*/
var activation_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS$1,
	apply: () => apply$2,
	name: () => name$2,
	readEndpoints: () => readEndpoints$1,
	writeEndpoints: () => writeEndpoints$1
});
const name$2 = "activation";
const TOOLS$1 = ["evo_activation_status", "evo_activation_refresh"];
const readEndpoints$1 = {};
const writeEndpoints$1 = {};
const RENDER$1 = (_a, v) => text(v);
function apply$2(deps) {
	setActivationSandbox(getSandbox());
	if (typeof deps.ctx.provide === "function") {
		const dispose = deps.ctx.provide("evolutionRuntime", createRuntimeService(deps));
		if (typeof deps.ctx.effect === "function" && typeof dispose === "function") deps.ctx.effect(() => dispose);
	} else deps.warn("activation: ctx.provide is unavailable; the generated plugin cannot reach the sandbox service");
	const statusTool = {
		name: "evo_activation_status",
		description: "Report which version artifact is currently mounted in this host, which tool it registered, and why activation did not happen when it did not.",
		parameters: {
			type: "object",
			properties: {},
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$1
		},
		execute: async () => {
			const root = deps.store.getRoot();
			const active = await deps.store.getActiveVersion();
			const state = activationState();
			return neutralizeDeep({
				mountedVersionId: state.activeVersionId,
				mountedTool: state.activeTool,
				reason: state.reason,
				preflight: state.preflight,
				activeVersionInStore: active ? active.id : null,
				activeModules: active ? active.modules : [],
				artifactPath: active ? artifactPluginPath(root, active.id) : null,
				artifactManifestPath: active ? artifactManifestPath(root, active.id) : null,
				artifactDir: active ? versionDir(root, active.id) : null
			});
		}
	};
	const refreshTool = {
		name: "evo_activation_refresh",
		description: "Re-read the active version and mount (or unmount) its artifact so the running host matches the promoted version.",
		parameters: {
			type: "object",
			properties: {},
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER$1
		},
		execute: async () => {
			await refreshActivation(deps);
			const state = activationState();
			return neutralizeDeep({
				mountedVersionId: state.activeVersionId,
				mountedTool: state.activeTool,
				reason: state.reason
			});
		}
	};
	registerToolSafe(deps.ctx, statusTool);
	registerToolSafe(deps.ctx, refreshTool);
	deps.log("activation: registered evo_activation_status, evo_activation_refresh");
}
//#endregion
//#region src/host/modules/version-history/index.ts
var version_history_exports = /* @__PURE__ */ __exportAll({
	TOOLS: () => TOOLS,
	apply: () => apply$1,
	name: () => name$1,
	readEndpoints: () => readEndpoints,
	writeEndpoints: () => writeEndpoints
});
const RENDER = (_args, value) => text(value);
const name$1 = "version-history";
const TOOLS = ["evo_version_history"];
const readEndpoints = {};
const writeEndpoints = {};
function apply$1(deps) {
	const tool = {
		name: "evo_version_history",
		description: "Return post-promotion observation history for one version, including attribution and a degradation signal when enough evidence exists.",
		parameters: {
			type: "object",
			properties: {
				versionId: {
					type: "string",
					description: "The version to query. Omit to get the currently active version (if any)."
				},
				limit: {
					type: "number",
					description: "Maximum observations to return. Defaults to 50, capped at 500."
				}
			},
			required: []
		},
		output: {
			schema: JSON_OBJECT_OUTPUT,
			render: RENDER
		},
		execute: async (args) => {
			const a = args ?? {};
			const limit = typeof a.limit === "number" ? Math.max(1, Math.min(500, Math.floor(a.limit))) : 50;
			await deps.store.listExperiences(500);
			let versionIdToQuery = typeof a.versionId === "string" && a.versionId !== "" ? a.versionId : void 0;
			if (!versionIdToQuery) versionIdToQuery = (await deps.store.getActiveVersion())?.id;
			if (!versionIdToQuery) return neutralizeDeep({
				ok: false,
				error: "no version specified and no active version found"
			});
			const records = await deps.store.listExperiencesByVersion(versionIdToQuery, limit);
			let signal = null;
			if (records.length > 0) signal = detectVersionDegradation(records);
			return neutralizeDeep({
				versionId: versionIdToQuery,
				observationCount: records.length,
				experiences: records,
				degradation: signal
			});
		}
	};
	registerToolSafe(deps.ctx, tool);
	deps.log("version-history: registered evo_version_history");
}
//#endregion
//#region src/host/index.ts
const name = "dsh-evolution";
const VERSION = "0.1.0";
const inject = [
	"tools",
	"settings",
	"agents"
];
const MODULES = [
	experience_exports,
	analyze_exports,
	candidate_exports,
	benchmark_exports,
	promote_exports,
	evolution_exports,
	status_exports,
	sandbox_exports,
	builder_exports,
	auto_experience_exports,
	activation_exports,
	version_history_exports
];
/**
* Plugin entry (HOST-API §1). The host calls `apply(ctx, config?)` where
* config is the row from cordis.patch.yml. We pass it through schemastery
* and register a live settings scope so the UI can hot-swap config.
*/
async function apply(rawContext, rawConfig = {}) {
	const log = makeLogger("dsh-evolution");
	const ctx = rawContext;
	try {
		await boot(ctx, rawConfig, log);
		log.info("ready: " + MODULES.map(function(m) {
			return m.name;
		}).join(", "));
	} catch (error) {
		const detail = errorMessage(error);
		console.error("[dsh-evolution] boot failed; registering status-only tool:", detail);
		log.warn("boot failed: " + detail);
		try {
			registerToolSafe(ctx, defineTool({
				name: "evo_status",
				description: "dsh-evolution failed to start; this status-only tool reports why. No other evo_* tool is available this session.",
				parameters: {
					type: "object",
					properties: {}
				},
				output: {
					schema: JSON_OBJECT_OUTPUT,
					render: function(_args, value) {
						return text(value);
					}
				},
				execute: async () => ({
					plugin: "dsh-evolution",
					state: "failed",
					error: neutralize(detail),
					hint: "Fix the cause and restart the host; plugin data on disk is untouched."
				})
			}));
		} catch {}
	}
}
async function boot(ctx, rawConfig, log) {
	let resolved = resolveConfig(rawConfig);
	try {
		const scope = ctx.settings.register("dsh-evolution", Config, {
			base: rawConfig,
			applies: "live"
		});
		try {
			resolved = resolveConfig(scope.get());
		} catch (error) {
			log.warn("settings scope read failed, using composed defaults: " + errorMessage(error));
		}
	} catch (error) {
		log.warn("settings.register unavailable: " + errorMessage(error));
	}
	try {
		ctx.on("settings/updated", (function(namespace, next) {
			if (namespace !== "dsh-evolution") return;
			try {
				resolved = resolveConfig(next);
				log.info("config swapped (live)");
			} catch (error) {
				log.warn("config swap failed, keeping previous: " + errorMessage(error));
			}
		}));
	} catch {}
	const root = resolved.stateRoot !== "" ? resolved.stateRoot : resolveStateRoot(function(name2) {
		return ctx.get(name2);
	});
	const store = new EvolutionStore({
		get: function(name2) {
			return ctx.get(name2);
		},
		fallbackRoot: root
	});
	try {
		await store.init();
		log.info("state ready at " + root);
	} catch (error) {
		log.warn("state scaffold failed: " + errorMessage(error));
	}
	const cfg = function() {
		return resolved;
	};
	const deps = {
		ctx,
		cfg,
		store,
		log: function(message) {
			log.info(message);
		},
		warn: function(message) {
			log.warn(message);
		}
	};
	for (const module of MODULES) try {
		module.apply(deps);
	} catch (error) {
		log.warn("module \"" + module.name + "\" failed, continuing: " + errorMessage(error));
	}
	try {
		const { refreshActivation, activationState } = await Promise.resolve().then(() => loader_exports);
		await refreshActivation(deps);
		const state = activationState();
		if (state.activeTool !== null) log.info("activated " + state.activeTool + " from " + String(state.activeVersionId));
		else log.info("no candidate activated: " + String(state.reason ?? "unknown"));
	} catch (error) {
		log.warn("activation failed at boot: " + errorMessage(error));
	}
}
//#endregion
export { Config, DEFAULT_CONFIG, EvolutionStore, INJECT_LABEL, MODULES, SCHEMA_VERSION, VERSION, apply, inject, name, resolveConfig };
