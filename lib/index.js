import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.js";
import { n as neutralizeDeep, t as neutralize } from "./sanitize-XEu8yO7t.js";
import { i as versionId, n as isoDateTime, r as newId, t as isSafeKey } from "./ids-BDx8N-Wv.js";
import { a as removeFile, i as readJsonlSafe, n as listDir, o as writeJsonAtomic, r as readJsonSafe, s as writeJsonlAtomic, t as cleanupTmpOrphans } from "./fsx-B43cc4kd.js";
import { i as text, n as defineTool, r as registerToolSafe, t as JSON_OBJECT_OUTPUT } from "./dsh-BUCgILFr.js";
import { t as clampText } from "./caps-BHV3EdjA.js";
import { n as verifyLiveProvenance, r as DEFAULT_PROMOTION_POLICY, t as createLiveProvenance } from "./provenance-CDbiC620.js";
import { t as containPath } from "./contain-C8mnY8eO.js";
import { n as evaluateExpectedOutput, t as classifyOutcome } from "./outcome-4bY69vEE.js";
import { n as sandbox_exports, t as getSandbox } from "./sandbox-D5ZkIMSm.js";
import { a as readArtifactManifest, n as artifactManifestPath, o as validateArtifact, r as artifactPluginPath, s as versionDir, t as artifactFilesDir } from "./artifact-CwjGEiXj.js";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import z from "schemastery";
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
* Profile-aware state root resolution.
*
* When a profile name is supplied, the state root is namespaced under it
* so that different DSH profiles (e.g. "web" vs "evo-live") keep fully
* independent mutable evolution state.  Without a profile name the legacy
* flat path is returned for backward compatibility.
*
* Precedence:
*   1. Explicit stateRoot in plugin config  (operator-authorized, always wins)
*   2. Profile-namespaced dshHomePath        (prevents cross-profile bleed)
*   3. Env fallback $DSH_HOME/dsh-evolution  (legacy, flat)
*/
function resolveStateRoot(get, fallbackRoot, profileName) {
	let base;
	if (fallbackRoot !== void 0 && fallbackRoot !== "") base = fallbackRoot;
	else try {
		const service = typeof get === "function" ? get("dshHomePath") : void 0;
		if (typeof service !== "function") base = envStateRoot();
		else {
			const value = service(STATE_DIR_NAME);
			base = typeof value === "string" && value !== "" ? value : envStateRoot();
		}
	} catch {
		base = envStateRoot();
	}
	return profileName ? join(base, profileName) : base;
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
//#region src/host/store.ts
/** Path to the single canonical active-version pointer file. */
const ACTIVE_VERSION_POINTER = "active-version.json";
/** Read the active pointer, normalising legacy (generation-free) files. */
async function readActivePointerSafe(path) {
	const raw = await readJsonSafe(path);
	if (!raw || typeof raw.versionId !== "string" || raw.versionId === "") return null;
	const generation = typeof raw.generation === "number" ? raw.generation : 0;
	return {
		versionId: raw.versionId,
		generation
	};
}
/** SCHEMA_VERSION: bumped when file layout changes. */
const SCHEMA_VERSION = 1;
/** Cache TTL for list operations: 5 seconds. Stale reads are acceptable because
*  every mutation path invalidates the cache before returning. */
const CACHE_TTL_MS = 5e3;
var EvolutionStore = class {
	root;
	nowFn;
	/** LRU-style cache: key → { timestamp, value }. Cleared on every mutation. */
	cache = /* @__PURE__ */ new Map();
	/** In-memory index: candidateId → [BenchmarkRun, ...]. Populated on first read, invalidated on mutation. */
	_benchmarkByCandidate = /* @__PURE__ */ new Map();
	/** In-memory index: versionId → [ExperienceRecord, ...]. Populated on first read, invalidated on mutation. */
	_experienceByVersion = /* @__PURE__ */ new Map();
	constructor(options) {
		this.root = resolveStateRoot(options.get, options.fallbackRoot, options.profileName);
		this.nowFn = options.now ?? (() => /* @__PURE__ */ new Date());
	}
	async init() {
		await ensureStateRoot(this.root);
		try {
			if (await readActivePointerSafe(this.activePointerPath())) return this.root;
		} catch {}
		const activeVersions = (await this.listVersions()).filter((v) => v.status === "active");
		if (activeVersions.length === 1) await writeJsonAtomic(this.activePointerPath(), {
			versionId: activeVersions[0].id,
			generation: 1
		});
		else if (activeVersions.length > 1) throw new Error("ambiguous legacy state at init: " + activeVersions.map((v) => v.id).join(", ") + " all have status=active; cannot bootstrap canonical pointer");
		this.invalidateCache();
		return this.root;
	}
	getRoot() {
		return this.root;
	}
	getCache(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
		this.cache.delete(key);
		return null;
	}
	setCache(key, value) {
		this.cache.set(key, {
			ts: Date.now(),
			value
		});
	}
	/** Invalidate every cached list entry. Called after any mutation. */
	invalidateCache() {
		this.cache.clear();
		this._benchmarkByCandidate.clear();
		this._experienceByVersion.clear();
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
		await this.appendExperienceJsonl(full);
		this.invalidateCache();
		return full;
	}
	/** Ensure the .jsonl file exists by migrating from individual .json files if needed. */
	async ensureJsonlExists() {
		const jsonlPath = join(this.experienceDir(), "experiences.jsonl");
		try {
			await (await import("node:fs/promises")).access(jsonlPath);
			return;
		} catch {}
		const files = await listDir(this.experienceDir(), Number.MAX_SAFE_INTEGER);
		const records = [];
		for (const f of files) {
			if (!f.endsWith(".json") || f === "experiences.jsonl") continue;
			const data = await readJsonSafe(join(this.experienceDir(), f));
			if (data && typeof data === "object" && "id" in data) records.push(data);
		}
		if (records.length > 0) await writeJsonlAtomic(jsonlPath, records);
	}
	async appendExperienceJsonl(record) {
		const jsonlPath = join(this.experienceDir(), "experiences.jsonl");
		try {
			await (await import("node:fs/promises")).appendFile(jsonlPath, JSON.stringify(record) + "\n", "utf8");
		} catch {
			await writeJsonlAtomic(jsonlPath, [record]);
		}
	}
	async getExperience(id) {
		if (!isSafeKey(id)) return null;
		return await readJsonSafe(join(this.experienceDir(), `${id}.json`));
	}
	async listExperiences(limit = 50) {
		const key = `listExperiences:${limit}`;
		const cached = this.getCache(key);
		if (cached !== null) return cached;
		const jsonlPath = join(this.experienceDir(), "experiences.jsonl");
		let records;
		try {
			await (await import("node:fs/promises")).access(jsonlPath);
			records = await readJsonlSafe(jsonlPath);
		} catch {
			await this.ensureJsonlExists();
			records = await readJsonlSafe(jsonlPath);
		}
		records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		const result = records.slice(0, limit);
		this.setCache(key, result);
		return result;
	}
	/**
	* Prune experience records based on TTL and count cap.
	* Removes records older than `retentionDays` and, if count exceeds `maxRecords`,
	* removes the oldest records until the cap is met.
	* Retained records are never rewritten — they remain byte-for-byte unchanged.
	* Missing or corrupt files are silently skipped (consistent with existing read semantics).
	*
	* @returns number of records removed
	*/
	async pruneExperiences(maxRecords, retentionDays) {
		const allFiles = await listDir(this.experienceDir(), 1e5);
		const records = [];
		for (const f of allFiles) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.experienceDir(), f));
			if (data && typeof data === "object" && "timestamp" in data) {
				const rec = data;
				if (typeof rec.id === "string" && typeof rec.timestamp === "string") records.push({
					id: rec.id,
					timestamp: rec.timestamp,
					file: f,
					record: rec
				});
			}
		}
		const cutoff = this.nowFn().getTime() - retentionDays * 24 * 60 * 60 * 1e3;
		records.sort((a, b) => {
			const t = a.timestamp.localeCompare(b.timestamp);
			return t !== 0 ? t : a.id.localeCompare(b.id);
		});
		let removed = 0;
		for (const r of records) if (new Date(r.timestamp).getTime() < cutoff) {
			await removeFile(join(this.experienceDir(), r.file));
			removed++;
		}
		const nonExpired = records.filter((r) => new Date(r.timestamp).getTime() >= cutoff);
		if (nonExpired.length > maxRecords) {
			const toRemove = nonExpired.slice(0, nonExpired.length - maxRecords);
			const kept = nonExpired.filter((r) => !toRemove.some((t) => t.id === r.id));
			const jsonlPath = join(this.experienceDir(), "experiences.jsonl");
			if (kept.length > 0) await writeJsonlAtomic(jsonlPath, kept.map((r) => r.record));
			else await removeFile(jsonlPath);
			for (const r of toRemove) {
				await removeFile(join(this.experienceDir(), r.file));
				removed++;
			}
		}
		this.invalidateCache();
		return removed;
	}
	/**
	* Return only experiences that were recorded while a specific version was
	* active.  Used by post-promotion monitoring to attribute outcomes to the
	* version that was mounted at the time.
	*
	* Uses the in-memory experience-by-version index (populated on first call,
	* invalidated on mutation) so repeated calls avoid re-filtering the full
	* experience set from disk.
	*/
	async listExperiencesByVersion(versionId, limit = 50) {
		let index = this._experienceByVersion.get(versionId);
		if (index === void 0) {
			index = (await this.listExperiences(limit * 10)).filter((e) => e.versionId === versionId);
			this._experienceByVersion.set(versionId, index);
		}
		return index.slice(0, limit);
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
		this.invalidateCache();
		return full;
	}
	async listPatterns(limit = 100) {
		const key = `listPatterns:${limit}`;
		const cached = this.getCache(key);
		if (cached !== null) return cached;
		const files = await listDir(this.patternDir(), limit);
		const patterns = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.patternDir(), f));
			if (data && typeof data === "object") patterns.push(data);
		}
		this.setCache(key, patterns);
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
		this.invalidateCache();
		return full;
	}
	async getCandidate(id) {
		if (!isSafeKey(id)) return null;
		return await readJsonSafe(join(this.candidateDir(), `${id}.json`));
	}
	async updateCandidate(id, updates) {
		if (!isSafeKey(id)) return null;
		const existing = await this.getCandidate(id);
		if (!existing) return null;
		const updated = {
			...existing,
			...updates,
			id,
			updatedAt: isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.candidateDir(), `${id}.json`), updated);
		this.invalidateCache();
		return updated;
	}
	async listCandidates(limit = 50) {
		const key = `listCandidates:${limit}`;
		const cached = this.getCache(key);
		if (cached !== null) return cached;
		const files = await listDir(this.candidateDir(), limit);
		const candidates = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.candidateDir(), f));
			if (data && typeof data === "object") candidates.push(data);
		}
		this.setCache(key, candidates);
		return candidates;
	}
	benchmarkDir() {
		return join(this.root, "benchmarks");
	}
	async addBenchmark(run, createdAt) {
		const full = {
			...run,
			id: newId(),
			createdAt: createdAt ?? isoDateTime(this.nowFn())
		};
		await writeJsonAtomic(join(this.benchmarkDir(), `${full.id}.json`), full);
		this.invalidateCache();
		return full;
	}
	async listBenchmarks(limit = 50) {
		const key = `listBenchmarks:${limit}`;
		const cached = this.getCache(key);
		if (cached !== null) return cached;
		const files = await listDir(this.benchmarkDir(), limit);
		const runs = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.benchmarkDir(), f));
			if (data && typeof data === "object") runs.push(data);
		}
		this.setCache(key, runs);
		return runs;
	}
	/**
	* Every benchmark record for one candidate, newest first.
	*
	* Uses an in-memory index (populated on first call, invalidated on mutation)
	* so subsequent lookups are O(1) instead of scanning every file on disk.
	*
	* @param forceRefresh when true, bypasses the cache and reads from disk.
	*   Use this in security-critical paths (promotion policy evaluation) where
	*   the on-disk record may have been tampered with outside the store API.
	*/
	async listBenchmarksByCandidate(candidateId, forceRefresh = false) {
		if (!forceRefresh) {
			const cached = this._benchmarkByCandidate.get(candidateId);
			if (cached !== void 0) return cached;
		}
		const files = await listDir(this.benchmarkDir(), Number.MAX_SAFE_INTEGER);
		const runs = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.benchmarkDir(), f));
			if (data && typeof data === "object" && data.candidateId === candidateId) runs.push(data);
		}
		runs.sort((x, y) => x.createdAt > y.createdAt ? -1 : 1);
		if (!forceRefresh) this._benchmarkByCandidate.set(candidateId, runs);
		return runs;
	}
	versionDir() {
		return join(this.root, "versions");
	}
	async getVersion(id) {
		if (!isSafeKey(id)) return null;
		return await readJsonSafe(join(this.versionDir(), `${id}.json`));
	}
	/**
	* The single canonical persisted active-version pointer file.
	* Stores `{ versionId, generation }` — the authoritative answer to
	* "which version is active?" and "how many times has the pointer been
	* mutated?".  When the file is missing (fresh state root, or legacy data),
	* this falls back to scanning version records for status='active'.
	*/
	activePointerPath() {
		return join(this.root, ACTIVE_VERSION_POINTER);
	}
	/**
	* Read the current active-version pointer, returning both the version and
	* the generation token.  Used by `createVersion` and `rollbackVersion` to
	* implement optimistic concurrency: the caller passes the observed
	* generation back when committing, and the store rejects the commit if
	* the pointer has been mutated by a concurrent operation in the meantime.
	*/
	async readPointer() {
		return readActivePointerSafe(this.activePointerPath());
	}
	/**
	* Check whether the pointer has been mutated since the given observed
	* generation.  Returns `{ ok: true }` when unchanged (generation matches
	* or the pointer is absent), and a conflict error otherwise.
	*/
	async checkPointerUnchanged(observedGeneration) {
		const current = await readActivePointerSafe(this.activePointerPath());
		if (current === null) {
			if (observedGeneration === 0) return { ok: true };
			return {
				ok: false,
				error: `active pointer deleted unexpectedly (observed generation ${observedGeneration}, now absent)`
			};
		}
		if (current.generation !== observedGeneration) return {
			ok: false,
			error: `active pointer changed concurrently: observed generation ${observedGeneration}, now ${current.generation} (points to ${current.versionId}); aborting to prevent stale overwrite`
		};
		return { ok: true };
	}
	async getActiveVersion() {
		const pointer = await readActivePointerSafe(this.activePointerPath());
		if (pointer) {
			const candidate = await this.getVersion(pointer.versionId);
			if (candidate) return candidate;
		}
		const activeVersions = (await this.listVersions()).filter((v) => v.status === "active");
		if (activeVersions.length === 1) {
			const newGeneration = ((await readActivePointerSafe(this.activePointerPath()))?.generation ?? 0) + 1;
			await writeJsonAtomic(this.activePointerPath(), {
				versionId: activeVersions[0].id,
				generation: newGeneration
			});
			return activeVersions[0];
		}
		if (activeVersions.length > 1) throw new Error("ambiguous active state: " + activeVersions.map((v) => v.id).join(", ") + " all have status=active; pointer is missing/corrupt and underlying state is ambiguous");
		return null;
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
			modules: data.modules,
			activeMetrics: data.activeMetrics
		};
		const pointerBefore = await readActivePointerSafe(this.activePointerPath());
		const observedGeneration = pointerBefore?.generation ?? 0;
		const oldActive = pointerBefore ? versions.find((v) => v.id === pointerBefore.versionId) ?? null : null;
		if (oldActive && !isSafeKey(oldActive.id)) throw new Error("corrupted active version record has an unsafe id: " + JSON.stringify(String(oldActive.id)));
		await writeJsonAtomic(join(this.versionDir(), `${version.id}.json`), version);
		const check = await this.checkPointerUnchanged(observedGeneration);
		if (!check.ok) {
			await removeFile(join(this.versionDir(), `${version.id}.json`));
			throw new Error("concurrent promotion/rollback conflict: " + check.error);
		}
		await writeJsonAtomic(this.activePointerPath(), {
			versionId: version.id,
			generation: observedGeneration + 1
		});
		if (oldActive && oldActive.id !== version.id) await writeJsonAtomic(join(this.versionDir(), `${oldActive.id}.json`), {
			...oldActive,
			status: "rolled-back"
		});
		this.invalidateCache();
		return version;
	}
	async listVersions(limit = 50) {
		const key = `listVersions:${limit}`;
		const cached = this.getCache(key);
		if (cached !== null) return cached;
		const files = await listDir(this.versionDir(), limit);
		const versions = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const data = await readJsonSafe(join(this.versionDir(), f));
			if (data && typeof data === "object") versions.push(data);
		}
		const sorted = versions.sort((a, b) => a.number - b.number);
		this.setCache(key, sorted);
		return sorted;
	}
	async rollbackVersion(versionId) {
		if (!isSafeKey(versionId)) return null;
		const target = await this.getVersion(versionId);
		if (!target) return null;
		if (!isSafeKey(target.id)) return null;
		const pointerBefore = await readActivePointerSafe(this.activePointerPath());
		const observedGeneration = pointerBefore?.generation ?? 0;
		const active = (pointerBefore ? await this.getVersion(pointerBefore.versionId) : await this.getActiveVersion()) ?? null;
		if (active && !isSafeKey(active.id)) throw new Error("corrupted active version record has an unsafe id: " + JSON.stringify(String(active.id)));
		if (active?.id === target.id) return {
			restored: target,
			deactivated: null,
			alreadyActive: true
		};
		const check = await this.checkPointerUnchanged(observedGeneration);
		if (!check.ok) throw new Error("concurrent promotion/rollback conflict: " + check.error);
		if (active) await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), {
			...active,
			status: "rolled-back"
		});
		await writeJsonAtomic(join(this.versionDir(), `${target.id}.json`), {
			...target,
			status: "active"
		});
		await writeJsonAtomic(this.activePointerPath(), {
			versionId: target.id,
			generation: observedGeneration + 1
		});
		this.invalidateCache();
		return {
			restored: target,
			deactivated: active,
			alreadyActive: false
		};
	}
	async updateVersion(id, updates) {
		if (!isSafeKey(id)) return null;
		const existing = await this.getVersion(id);
		if (!existing) return null;
		const updated = {
			...existing,
			...updates
		};
		await writeJsonAtomic(join(this.versionDir(), `${id}.json`), updated);
		this.invalidateCache();
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
				const expCfg = deps.cfg().experience;
				store.pruneExperiences(expCfg.maxRecords, expCfg.retentionDays).catch(() => {});
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
			description: `Recurring signature: ${signature}`,
			occurrences: data.count,
			evidenceIds: [...new Set(data.evidenceIds)],
			confidence: Math.min(.95, .4 + data.count * .05)
		});
	}
	const failed = experiences.filter((e) => !e.success);
	if (failed.length >= minOccurrences) {
		const steps = failed.map((e) => e.stepCount ?? 0).filter((n) => n > 0);
		if ((steps.length > 0 ? steps.reduce((s, n) => s + n, 0) / steps.length : 0) >= 10) patterns.push({
			type: "inefficiency",
			evidence: "INFERENCE",
			description: `Failed runs with high average step count; likely redundant or retried work.`,
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
//#region src/host/modules/benchmark/tools.ts
var tools_exports$2 = /* @__PURE__ */ __exportAll({ benchmarkTools: () => benchmarkTools });
/**
* Constrain a benchmark `cwd` input so it cannot escape the temp directory
* created by this benchmark run.
*
* The benchmark root (`tmpDir`) is what gets bind-mounted into the sandbox;
* every `cwd` value must resolve to a directory that sits strictly inside
* (or equal to) that root.  We reuse the lexical proof from `containPath`
* (resolve + relative + ".."-check) rather than a string-prefix comparison.
*
* Unlike `containPath` (which rejects the root itself — it is for files),
* the root directory is a valid `cwd`: `resolve(base, '.') === base` and
* `resolve(base, '')` returns `base`, both of which must be allowed.
*
* Symlink defense (HIGH-severity finding, Argus/BadSector):
*   After the lexical check passes, the target is stat()-checked.  If it is
*   a symlink, it is resolved to its real filesystem target via lstat+readlink,
*   and containment is re-checked against the real target.  This mirrors the
*   existing pattern in `readArtifactFile` (loader.ts:340–353) and closes the
*   TOCTOU symlink-follow vector on the benchmark tmpDir.
*
* @param tmpDir   the mkdtemp'd benchmark root
* @param cwdInput the caller-supplied `cwd` string (or undefined/empty → default)
* @returns the resolved absolute path when contained, `null` when it would
*          resolve outside `tmpDir` or when the input is malformed.
*/
async function containBenchmarkCwd(tmpDir, cwdInput) {
	if (cwdInput === void 0 || cwdInput === "" || cwdInput === "." || cwdInput === "./") return resolve(tmpDir);
	if (typeof cwdInput !== "string") return null;
	if (cwdInput.includes("\0")) return null;
	const base = resolve(tmpDir);
	const target = resolve(base, cwdInput);
	if (target === base) return base;
	const rel = relative(base, target);
	if (rel === "" || isAbsolute(rel)) return null;
	if (rel === ".." || rel.startsWith(".." + sep)) return null;
	try {
		if ((await lstat(target)).isSymbolicLink()) {
			const realTarget = await realpath(target).catch(() => target);
			const realRel = relative(base, realTarget);
			if (realRel === "" || isAbsolute(realRel)) return null;
			if (realRel === ".." || realRel.startsWith(".." + sep)) return null;
			return realTarget;
		}
	} catch {}
	return target;
}
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
	const all = [...files, ...tests];
	const targets = [];
	for (const f of all) {
		const target = containPath(candidateDir, f.path);
		if (target === null) throw new Error("candidate path escapes the benchmark directory: " + String(f.path));
		targets.push({
			target,
			content: f.content
		});
	}
	let count = 0;
	for (const { target, content } of targets) {
		const dir = dirname(target);
		await mkdir(dir, { recursive: true });
		await writeFile(target, content, "utf8");
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
			description: "Execute a command in a live sandbox against a candidate file set and return detailed execution results including stdout, stderr, exit code, and timing. When expectedExitCode is provided, it is used as the trusted oracle for task classification — independent of any candidate-generated metadata.",
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
					},
					expectedExitCode: {
						type: "number",
						description: "The operator-owned expected exit code for task success. When provided, the actual exit code is compared against this value to classify the outcome. Candidate-generated metadata is never read for this value."
					},
					expectedOutput: {
						type: "string",
						description: "The operator-owned expected stdout content (exact string or /regex/ literal). When provided, stdout is evaluated against it regardless of exit code. Supersedes exit-code-only classification when both are set. Candidate-generated metadata is never read for this value."
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
				const expectedExitCode = typeof a.expectedExitCode === "number" ? a.expectedExitCode : void 0;
				const expectedOutput = typeof a.expectedOutput === "string" ? a.expectedOutput : void 0;
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
					const cwdInput = typeof a.cwd === "string" ? a.cwd : "";
					const execCwd = await containBenchmarkCwd(tmpDir, cwdInput);
					if (execCwd === null) return neutralizeDeep({
						ok: false,
						error: "cwd escapes the benchmark directory: " + cwdInput
					});
					const result = await sandbox.exec(command, {
						cwd: execCwd,
						timeoutMs,
						allowNetwork
					});
					const outcome = classifyOutcome(result, expectedExitCode, expectedOutput);
					let evaluation;
					if (result.oomKilled) evaluation = "OOM kill: process terminated by resource limit; cannot evaluate";
					else if (result.timedOut) evaluation = "Timeout: execution exceeded " + timeoutMs + "ms; cannot evaluate";
					else if (result.exitCode === null && result.stderr.length > 0) evaluation = "Spawn failure: " + result.stderr.slice(0, 200);
					else if (typeof expectedOutput === "string") evaluation = evaluateExpectedOutput(result.stdout, expectedOutput).detail + (typeof expectedExitCode === "number" ? "; process: exit " + String(result.exitCode) + (result.exitCode === expectedExitCode ? " matches" : " does not match") + " expected " + expectedExitCode : "");
					else if (typeof expectedExitCode === "number") evaluation = result.exitCode === expectedExitCode ? "exit code " + result.exitCode + " matches expected " + expectedExitCode : "exit code " + result.exitCode + " does not match expected " + expectedExitCode;
					else evaluation = "legacy mode: exit code " + String(result.exitCode) + (result.exitCode === 0 ? " (exit-0 = success)" : " (non-zero exit = failure)");
					const executionResult = {
						caseId: "live-exec-" + candidateId,
						passed: outcome === "task-successful",
						score: outcome === "task-successful" ? 1 : 0,
						outcome,
						error: result.stderr || void 0,
						durationMs: result.durationMs,
						stdout: clampText(result.stdout, 1e4),
						stderr: clampText(result.stderr, 1e4),
						exitCode: result.exitCode,
						timedOut: result.timedOut,
						expectedExitCode,
						evaluation
					};
					const liveMetrics = {
						successRate: outcome === "task-successful" ? 1 : 0,
						avgScore: outcome === "task-successful" ? 1 : 0,
						errorRate: outcome === "execution-failure" ? 1 : 0,
						avgSteps: 0,
						avgDurationMs: result.durationMs
					};
					const createdAt = isoDateTime(/* @__PURE__ */ new Date());
					const persistedCommand = clampText(command, 500);
					const provenance = createLiveProvenance(candidateId, candidate.parentVersion, persistedCommand, createdAt);
					const record = await store.addBenchmark({
						mode: "live",
						candidateId,
						version: candidate.parentVersion,
						baseline: candidate.parentVersion,
						parentVersion: candidate.parentVersion,
						runs: 1,
						metrics: liveMetrics,
						thresholds: candidate.benchmarkConfig,
						command: persistedCommand,
						expectedExitCode,
						expectedOutput,
						provenance,
						passed: outcome === "task-successful",
						details: clampText("live sandbox execution (" + sandbox.name + "): exit " + String(result.exitCode) + (result.timedOut ? ", timed out" : "") + ", outcome=" + outcome + (typeof expectedExitCode === "number" ? ", expectedExit=" + expectedExitCode : "") + (typeof expectedOutput === "string" ? ", expectedOutput=(" + expectedOutput.slice(0, 60) + ")" : ""), 500)
					}, createdAt);
					await store.updateCandidate(candidateId, { status: outcome === "task-successful" ? "benchmarked" : "rejected" });
					return neutralizeDeep({
						ok: true,
						candidateId,
						command,
						sandbox: sandbox.name,
						executionResult,
						outcome,
						expectedExitCode,
						expectedOutput,
						filesWritten,
						benchmarkRunId: record.id,
						metrics: liveMetrics,
						passed: outcome === "task-successful",
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
			description: "Run an A/B benchmark comparing a candidate against its baseline by executing a command in a sandbox for multiple runs and computing comparative metrics. When expectedExitCode and/or expectedOutput are provided, they are used as the trusted oracles for both sides — independent of any candidate-generated metadata.",
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
					},
					expectedExitCode: {
						type: "number",
						description: "The operator-owned expected exit code for task success. When provided, the actual exit code is compared against this value to classify outcomes for both baseline and candidate."
					},
					expectedOutput: {
						type: "string",
						description: "The operator-owned expected stdout content (exact string or /regex/ literal). When provided, stdout is evaluated against it for both sides. Supersedes exit-code-only classification. Candidate-generated metadata is never read."
					},
					cwd: {
						type: "string",
						description: "Optional override for the working directory inside the temp dir. Defaults to the temp dir root."
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
				const expectedExitCode = typeof a.expectedExitCode === "number" ? a.expectedExitCode : void 0;
				const expectedOutput = typeof a.expectedOutput === "string" ? a.expectedOutput : void 0;
				const cwdInput = typeof a.cwd === "string" ? a.cwd : "";
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
					const sideCwd = await containBenchmarkCwd(dir, cwdInput);
					if (sideCwd === null) throw new Error("cwd escapes the benchmark directory: " + cwdInput);
					const results = [];
					for (let i = 0; i < runs; i++) {
						const execResult = await sandbox.exec(command, {
							cwd: sideCwd,
							timeoutMs,
							allowNetwork
						});
						const outcome = classifyOutcome(execResult, expectedExitCode, expectedOutput);
						let evaluation;
						if (typeof expectedOutput === "string") evaluation = evaluateExpectedOutput(execResult.stdout, expectedOutput).detail;
						results.push({
							caseId: `${sideLabel}-run-${i + 1}`,
							passed: outcome === "task-successful",
							score: outcome === "task-successful" ? 1 : 0,
							outcome,
							error: execResult.stderr || void 0,
							durationMs: execResult.durationMs,
							stdout: clampText(execResult.stdout, 1e4),
							stderr: clampText(execResult.stderr, 1e4),
							exitCode: execResult.exitCode,
							timedOut: execResult.timedOut,
							expectedExitCode,
							expectedOutput,
							evaluation
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
					const abRecordCreatedAt = isoDateTime(/* @__PURE__ */ new Date());
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
						createdAt: abRecordCreatedAt
					};
					const persistedAbCommand = clampText(command, 500);
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
						command: persistedAbCommand,
						expectedExitCode,
						expectedOutput,
						provenance: createLiveProvenance(candidateId, candidate.parentVersion, persistedAbCommand, abRecordCreatedAt) ?? void 0,
						passed,
						details: clampText(details, 500)
					}, abRecordCreatedAt);
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
		}),
		defineTool({
			name: "evo_benchmark_manifest",
			description: "Execute all benchmark cases declared in a candidate's manifest as real sandbox benchmarks. Each case's input field is the command to execute; expectedOutput and expectedExitCode are the per-case oracles. Results are persisted as a mode=manifest BenchmarkRun with caseResults. This provides candidate-declared functional evidence only; manifest evidence is diagnostic and does not independently satisfy promotion requirements — run evo_benchmark_live or evo_benchmark_ab for promotion-eligible evidence.",
			parameters: {
				type: "object",
				properties: {
					candidateId: {
						type: "string",
						description: "The candidate id whose manifest cases to execute."
					},
					allowNetwork: {
						type: "boolean",
						description: "Whether to allow network access in the sandbox. Defaults to false."
					},
					cwd: {
						type: "string",
						description: "Optional override for the working directory inside the temp dir. Defaults to the temp dir root."
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
				if (!candidateId) return neutralizeDeep({
					ok: false,
					error: "candidateId is required"
				});
				const candidate = await store.getCandidate(candidateId);
				if (!candidate) return neutralizeDeep({
					ok: false,
					error: "no candidate " + candidateId
				});
				if (candidate.status === "promoted") return neutralizeDeep({
					ok: false,
					error: "candidate already promoted"
				});
				const { readCandidateManifest } = await import("./manifest-D82S62if.js");
				if (((await readCandidateManifest(store.getRoot(), candidateId))?.benchmarkCases ?? []).length === 0) return neutralizeDeep({
					ok: false,
					error: "candidate has no benchmark cases in manifest"
				});
				const { runManifestCases } = await import("./manifest-D82S62if.js");
				const result = await runManifestCases(deps, candidate, {
					allowNetwork: typeof a.allowNetwork === "boolean" ? a.allowNetwork : void 0,
					cwd: typeof a.cwd === "string" ? a.cwd : void 0
				});
				if (!result.ok) return neutralizeDeep({
					ok: false,
					error: result.error,
					details: result.details
				});
				const createdAt = isoDateTime(/* @__PURE__ */ new Date());
				const provenance = createLiveProvenance(candidateId, candidate.parentVersion, "manifest-cases", createdAt);
				const record = await store.addBenchmark({
					mode: "manifest",
					candidateId,
					version: candidate.parentVersion,
					baseline: candidate.parentVersion,
					parentVersion: candidate.parentVersion,
					runs: result.totalCases,
					metrics: result.metrics,
					thresholds: candidate.benchmarkConfig,
					command: "manifest-cases",
					provenance,
					passed: result.passed,
					caseResults: result.caseResults,
					details: clampText(result.details, 500)
				}, createdAt);
				await store.updateCandidate(candidateId, { status: result.passed ? "benchmarked" : "rejected" });
				return neutralizeDeep({
					ok: true,
					candidateId,
					benchmarkRunId: record.id,
					totalCases: result.totalCases,
					successfulCases: result.successfulCases,
					failedCases: result.failedCases,
					executionFailures: result.executionFailures,
					metrics: result.metrics,
					passed: result.passed,
					caseResults: result.caseResults,
					details: result.details,
					evidenceMode: "manifest"
				});
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
	"evo_benchmark_ab",
	"evo_benchmark_manifest"
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
				const latestEvidence = (await store.listBenchmarks(500)).filter((b) => b.candidateId === candidateId).sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)[0];
				if (!latestEvidence || latestEvidence.mode !== "live") return neutralizeDeep({
					ok: false,
					error: "candidate has no live benchmark evidence; run evo_benchmark_live or evo_benchmark_ab before promoting (simulated evidence cannot promote)"
				});
				const policyResult = await evaluatePromotionPolicy(deps, candidate);
				if (!policyResult.ok) return neutralizeDeep({
					ok: false,
					error: policyResult.error
				});
				const versionNumber = (await store.listVersions(200)).reduce((max, v) => Math.max(max, v.number), 0) + 1;
				const plannedVersionId = "v" + String(versionNumber);
				const { materializeArtifact, validateArtifact } = await import("./artifact-CwjGEiXj.js").then((n) => n.i);
				const { activateVersion, activationState } = await Promise.resolve().then(() => loader_exports);
				const activeBeforeMaterialize = await store.getActiveVersion();
				try {
					await materializeArtifact(store.getRoot(), {
						id: plannedVersionId,
						number: versionNumber,
						label: candidate.name,
						createdAt: (/* @__PURE__ */ new Date()).toISOString(),
						status: "active",
						modules: [candidate.id]
					}, candidate, { baseVersionId: activeBeforeMaterialize?.id ?? null });
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
				const result = await executePromotion(deps, candidate, clampText(typeof a.reason === "string" ? a.reason : "", 500), plannedVersionId, policyResult.activeMetrics);
				const state = activationState();
				return neutralizeDeep({
					ok: true,
					version: result.version,
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
				const targetVersion = await store.getVersion(versionId);
				if (!targetVersion) {
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
				if (targetVersion.modules && targetVersion.modules.length > 0) {
					const { validateArtifact } = await import("./artifact-CwjGEiXj.js").then((n) => n.i);
					const validation = await validateArtifact(store.getRoot(), versionId);
					if (!validation.valid) return neutralizeDeep({
						ok: false,
						error: "rollback target " + versionId + " has an invalid artifact: " + validation.errors.join("; "),
						validationErrors: validation.errors
					});
				}
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
				const allBenchmarks = await store.listBenchmarks(500);
				const latest = allBenchmarks.filter((b) => b.candidateId === candidateId).sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)[0];
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
				const activeVersion = await store.getActiveVersion();
				let activeMetrics = null;
				if (activeVersion?.modules?.length) {
					const rawId = activeVersion.modules[0];
					const activeModuleId = typeof rawId === "object" && rawId !== null && "id" in rawId ? String(rawId.id) : String(rawId);
					const activeModuleBench = allBenchmarks.filter((b) => b.candidateId === activeModuleId).sort((x, y) => x.createdAt > y.createdAt ? -1 : 1)[0];
					if (activeModuleBench && activeModuleBench.mode !== "simulated") activeMetrics = activeModuleBench.metrics;
				}
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
				if (activeMetrics) {
					const activeSuccessRate = activeMetrics.successRate;
					checks.push({
						gate: "beats_active",
						pass: m.successRate > activeSuccessRate,
						actual: (m.successRate * 100).toFixed(1) + "%",
						threshold: (activeSuccessRate * 100).toFixed(1) + "% (must exceed active version)"
					});
				}
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
	evaluatePromotionPolicy: () => evaluatePromotionPolicy,
	executePromotion: () => executePromotion,
	name: () => name$7,
	readEndpoints: () => readEndpoints$5,
	runPromotionPolicy: () => runPromotionPolicy,
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
/**
* Evaluate the promotion policy for a candidate. This is the SINGLE policy
* authority for every promotion path — `evo_promote` and `evo_full_cycle` both
* route through here, so a rule enforced here is enforced everywhere.
*
* Two gates, in order:
*
*  1. **Evidence gate** — a candidate whose latest benchmark record has
*     `mode === 'simulated'` is rejected unconditionally, including when no
*     active version exists. Ratified as contract C-1 in `docs/CONTRACTS.md`.
*  2. **Comparative gate (`beats_active`)** — the candidate's live metrics must
*     strictly beat the active version's. Returns the captured active metrics
*     (for provenance) on success, or `undefined` when the gate is skipped
*     because there is no comparable active baseline (first version, or no
*     benchmark on the active module). Tie with active = reject (monotonicity).
*
* Returns { ok: false, error } when the candidate fails either gate.
*
* This is a PURE evaluation: it reads store state and returns a decision
* without creating any Version, updating any Candidate, or touching
* activation state. Callers must perform the mutation steps only when
* this returns ok:true.
*/
async function evaluatePromotionPolicy(deps, candidate) {
	const store = deps.store;
	const activeBeforePromote = await store.getActiveVersion();
	let capturedActiveMetrics;
	let activeModuleBenchRecord;
	if (activeBeforePromote?.modules?.length) {
		const activeModuleId = activeBeforePromote.modules[0];
		activeModuleBenchRecord = (await store.listBenchmarksByCandidate(activeModuleId, true))[0];
		if (activeModuleBenchRecord) capturedActiveMetrics = activeModuleBenchRecord.metrics;
	}
	const candidateLatest = (await store.listBenchmarksByCandidate(candidate.id, true))[0];
	if (candidateLatest && candidateLatest.mode === "simulated") return {
		ok: false,
		error: `promotion rejected: candidate has only simulated evidence (mode=simulated); run evo_benchmark_live or evo_benchmark_ab to produce execution evidence before promoting`
	};
	if (capturedActiveMetrics && candidateLatest && candidateLatest.mode !== "simulated") {
		if (candidateLatest.mode === "live") {
			const candidateSealed = candidateLatest.provenance !== void 0;
			const activeSealed = capturedActiveMetrics !== void 0 && (activeModuleBenchRecord?.provenance ?? void 0) !== void 0;
			if (candidateSealed || activeSealed) {
				if (!verifyLiveProvenance(candidateLatest)) return {
					ok: false,
					error: candidateLatest.provenance ? "provenance consistency mismatch: stored seal does not match the record fields; re-run evo_benchmark_live or evo_benchmark_ab to generate valid evidence" : "live benchmark provenance seal missing: no provenance on record; re-run evo_benchmark_live or evo_benchmark_ab to generate valid evidence"
				};
			}
		}
		const activeSuccessRate = capturedActiveMetrics.successRate;
		const candidateSuccessRate = candidateLatest.metrics.successRate;
		if (candidateSuccessRate <= activeSuccessRate) return {
			ok: false,
			error: `beats_active gate failed: candidate success rate ${(candidateSuccessRate * 100).toFixed(1)}% is not greater than active version ${(activeSuccessRate * 100).toFixed(1)}%`
		};
	}
	return {
		ok: true,
		activeMetrics: capturedActiveMetrics
	};
}
/**
* Execute the full promotion after the policy gate has passed.
* Creates the Version record, updates the Candidate status, materializes
* the artifact (if needed), and refreshes activation.
*/
async function executePromotion(deps, candidate, reason, plannedVersionId, capturedActiveMetrics) {
	const store = deps.store;
	if (plannedVersionId !== "" && !isSafeKey(plannedVersionId)) throw new Error("invalid planned version id: " + JSON.stringify(String(plannedVersionId)));
	const { materializeArtifact, validateArtifact } = await import("./artifact-CwjGEiXj.js").then((n) => n.i);
	const { refreshActivation } = await Promise.resolve().then(() => loader_exports);
	const baseVersionId = (await store.getActiveVersion())?.id;
	const { access } = await import("node:fs/promises");
	const manifestPath = join(store.getRoot(), "versions", plannedVersionId, "manifest.json");
	const artifactPreExists = plannedVersionId !== "" && await access(manifestPath).then(() => true).catch(() => false);
	let versionNumber;
	if (artifactPreExists) {
		const match = /^v(\d+)$/.exec(plannedVersionId);
		versionNumber = match ? parseInt(match[1], 10) : 0;
	} else {
		const versions = await store.listVersions(200);
		versionNumber = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.number)) + 1;
		const probeVersion = {
			id: "v" + String(versionNumber),
			number: versionNumber,
			label: candidate.name,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			status: "active",
			modules: [candidate.id]
		};
		const { rm } = await import("node:fs/promises");
		await rm(join(store.getRoot(), "versions", probeVersion.id), {
			recursive: true,
			force: true
		});
		await materializeArtifact(store.getRoot(), probeVersion, candidate, { baseVersionId });
		const validation = await validateArtifact(store.getRoot(), probeVersion.id);
		if (!validation.valid) {
			const { rm } = await import("node:fs/promises");
			await rm(join(store.getRoot(), "versions", probeVersion.id), {
				recursive: true,
				force: true
			});
			throw new Error("version artifact did not validate: " + validation.errors.join("; "));
		}
	}
	const version = await store.createVersion({
		label: candidate.name,
		reason,
		promotedFrom: candidate.parentVersion,
		modules: [candidate.id],
		activeMetrics: capturedActiveMetrics
	});
	await store.updateCandidate(candidate.id, { status: "promoted" });
	const { rm } = await import("node:fs/promises");
	const expectedArtifactPath = join(store.getRoot(), "versions", version.id);
	if (!await access(join(expectedArtifactPath, "manifest.json")).then(() => true).catch(() => false) && version.id !== plannedVersionId) await materializeArtifact(store.getRoot(), version, candidate, { baseVersionId });
	await refreshActivation(deps);
	return {
		ok: true,
		version
	};
}
/**
* Backward-compatible wrapper that combines evaluate + execute in one call.
* Used by evolution/tools.ts (evo_full_cycle).
*
* The policy gate runs first; if it passes, the mutation (version create,
* candidate status update, artifact materialize, activation refresh) follows.
* If the policy gate fails, NO version or candidate mutation occurs.
*/
async function runPromotionPolicy(deps, candidate, reason, plannedVersionId) {
	const evaluation = await evaluatePromotionPolicy(deps, candidate);
	if (!evaluation.ok) return evaluation;
	const { ok, version } = await executePromotion(deps, candidate, reason, plannedVersionId, evaluation.activeMetrics);
	return {
		ok,
		version
	};
}
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
				const [experiences, existingPatterns] = await Promise.all([store.listExperiences(500), store.listPatterns(500)]);
				if (experiences.length === 0) return neutralizeDeep({
					ok: false,
					steps,
					error: "no experiences recorded; record some first with evo_experience_record"
				});
				steps.push("analyze");
				const detected = detectPatterns(experiences, typeof a.minOccurrences === "number" ? Math.max(1, Math.floor(a.minOccurrences)) : 3);
				const existingDescriptions = new Set(existingPatterns.map((p) => p.description));
				const fresh = detected.filter((p) => !existingDescriptions.has(p.description));
				const persisted = fresh.length > 0 ? await Promise.all(fresh.map((p) => store.addPattern(p))) : [];
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
				const [versions, candidate] = await Promise.all([store.listVersions(200), store.getCandidate(generatedCandidateId)]);
				const versionNumber = versions.reduce((max, v) => Math.max(max, v.number), 0) + 1;
				const plannedVersionId = "v" + String(versionNumber);
				if (!candidate) {
					await store.updateCandidate(generatedCandidateId, { status: "rejected" });
					return neutralizeDeep({
						ok: false,
						steps,
						verdict: "REJECTED",
						candidateId: generatedCandidateId,
						reason: "candidate " + generatedCandidateId + " not found in store"
					});
				}
				const promoResult = await runPromotionPolicy(deps, candidate, clampText("auto: " + strongestPattern.description.slice(0, 80), 200), plannedVersionId);
				if (!promoResult.ok) {
					await store.updateCandidate(generatedCandidateId, { status: "rejected" });
					return neutralizeDeep({
						ok: false,
						steps,
						verdict: "REJECTED",
						candidateId: generatedCandidateId,
						pattern: strongestPattern.id,
						reason: "promotion failed: " + promoResult.error
					});
				}
				return neutralizeDeep({
					ok: true,
					steps,
					verdict: "PROMOTED",
					candidateId: generatedCandidateId,
					versionId: promoResult.version.id,
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
	const def = statusTool(deps.store, VERSION);
	const result = registerToolSafe(deps.ctx, def);
	if (!result.ok) deps.warn(`status: tool registration failed: ${result.error}`);
	deps.log("status: registered 1 tool");
}
//#endregion
//#region src/host/modules/builder/tools.ts
var tools_exports = /* @__PURE__ */ __exportAll({
	builderTools: () => builderTools,
	parseFileSetFromLLMResponse: () => parseFileSetFromLLMResponse,
	validateCandidateFileSet: () => validateCandidateFileSet
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
		maxTokens: 8192,
		reasoningEffort: "low"
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
	const nominalRoot = "/candidate-files";
	for (const file of allFiles) {
		if (containPath(nominalRoot, file.path) === null) errors.push("path escapes the candidate root: " + file.path);
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
	if (typeof fileSet.manifest.entryPoint === "string" && fileSet.manifest.entryPoint !== "" && containPath(nominalRoot, fileSet.manifest.entryPoint) === null) errors.push("path escapes the candidate root: " + fileSet.manifest.entryPoint);
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
* omit `tests` entirely. A single {path, content} OBJECT (not wrapped in an
* array) is also observed and must yield ONE file, not a two-entry map.
*/
function toFileArray(value) {
	if (Array.isArray(value)) {
		const out = [];
		for (const entry of value) {
			if (entry === null || typeof entry !== "object") continue;
			const e = entry;
			if (typeof e.path === "string") {
				out.push({
					path: e.path,
					content: typeof e.content === "string" ? e.content : ""
				});
				continue;
			}
			if (e.path !== null && typeof e.path === "object" && !Array.isArray(e.path)) {
				for (const [k, v] of Object.entries(e.path)) if (typeof v === "string") out.push({
					path: k,
					content: v
				});
			}
		}
		return out;
	}
	if (value !== null && typeof value === "object") {
		const obj = value;
		if (typeof obj.path === "string") return [{
			path: obj.path,
			content: typeof obj.content === "string" ? obj.content : ""
		}];
		if (obj.path !== null && typeof obj.path === "object" && !Array.isArray(obj.path)) {
			const recovered = Object.entries(obj.path).filter(([, v]) => typeof v === "string").map(([k, v]) => ({
				path: k,
				content: String(v)
			}));
			if (recovered.length > 0) return recovered;
		}
		return Object.entries(obj).filter(([, v]) => typeof v === "string").map(([k, v]) => ({
			path: k,
			content: v
		}));
	}
	return [];
}
/**
* Find `files`/`tests` arrays even when nested under a wrapper key.
*
* Real models sometimes wrap the payload: `{"manifest": {...}, "candidate": {"files": [...]}}`
* instead of putting `files` at the top level.  The original parser only read
* `root.files`, so this shape produced an empty file set and a hard parse failure.
*/
function findKeyDeep(obj, key, depth = 0) {
	if (depth > 3) return void 0;
	if (key in obj) return obj[key];
	for (const v of Object.values(obj)) if (v !== null && typeof v === "object" && !Array.isArray(v)) {
		const found = findKeyDeep(v, key, depth + 1);
		if (found !== void 0) return found;
	}
}
/** De-duplicate files by path, keeping the LAST occurrence (later wins). */
function dedupeFiles(files) {
	const byPath = /* @__PURE__ */ new Map();
	for (const f of files) byPath.set(f.path, f);
	return [...byPath.values()];
}
function normalizeFileSet(parsed) {
	const root = parsed ?? {};
	const manifest = root.manifest ?? root;
	const rawManifest = manifest;
	const cases = Array.isArray(manifest.benchmarkCases) ? manifest.benchmarkCases : [];
	const filesRaw = "files" in root ? root.files : findKeyDeep(root, "files");
	const testsRaw = "tests" in root ? root.tests : findKeyDeep(root, "tests");
	return {
		manifest: {
			...rawManifest,
			name: typeof manifest.name === "string" ? manifest.name : "candidate",
			version: typeof manifest.version === "string" ? manifest.version : "1.0.0",
			description: typeof manifest.description === "string" ? manifest.description : "",
			entryPoint: typeof manifest.entryPoint === "string" ? manifest.entryPoint : "src/index.ts",
			benchmarkCases: cases
		},
		files: dedupeFiles(toFileArray(filesRaw)),
		tests: dedupeFiles(toFileArray(testsRaw))
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
* Escape sequences JSON actually accepts. Anything else after a backslash
* inside a string is a hard parse error.
*/
const VALID_JSON_ESCAPES = /* @__PURE__ */ new Set([
	"\"",
	"\\",
	"/",
	"b",
	"f",
	"n",
	"r",
	"t",
	"u"
]);
/**
* Repair backslash escapes that JSON does not accept.
*
* Measured on a live model response: a TypeScript payload emitted `\order?`
* and `\n` sequences inside a JSON string, where `\o` is not a legal JSON
* escape. The document was otherwise complete (`finish_reason: stop`, no
* truncation) but `JSON.parse` rejected it with
* "Bad escaped character in JSON at position 1383" — so an entire candidate was
* lost to one character.
*
* A backslash that cannot start a valid escape is a literal backslash in the
* source the model meant to send, so it is doubled. Valid escapes are left
* untouched, and a `\` before a quote is always a real escape, never doubled.
* This only runs as a fallback after the untouched parse already failed.
*/
function repairInvalidEscapes(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (!inString) {
			if (ch === "\"") inString = true;
			out += ch;
			continue;
		}
		if (ch === "\"") {
			inString = false;
			out += ch;
			continue;
		}
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = text[i + 1];
		if (next === void 0) {
			out += ch;
			continue;
		}
		if (next === "u") {
			const hex = text.slice(i + 2, i + 6);
			if (/^[0-9a-fA-F]{4}$/.test(hex)) {
				out += text.slice(i, i + 6);
				i += 5;
				continue;
			}
			out += "\\\\";
			continue;
		}
		if (VALID_JSON_ESCAPES.has(next)) {
			out += ch + next;
			i += 1;
			continue;
		}
		out += "\\\\";
	}
	return out;
}
/**
* Repair mismatched brackets in an otherwise-parsable document.
*
* Measured live: a response truncated MID-document leaves a `{` open at the
* point where a `]` arrives (`..."content":"..." ]`) — the closer is owed
* THERE, not appended at the end, which is why a naive append-only repair
* still failed to parse.
*
* String-aware, so braces inside a file's content never affect the count.
* On a closer it closes any inner frames left open above the matching opener
* first (they are owed before this closer can land), and drops a closer with
* no matching opener at all — an extra one can only be spurious, and keeping
* it makes the document parse as "trailing content after JSON".
*
* A response cut in the middle of a string is missing real content: closing it
* would invent data, so it is returned unchanged and the caller falls through
* to the next attempt.
*/
function repairBrackets(text) {
	const stack = [];
	let out = "";
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "{") {
			stack.push("}");
			out += ch;
			continue;
		}
		if (ch === "[") {
			stack.push("]");
			out += ch;
			continue;
		}
		if (ch !== "}" && ch !== "]") {
			out += ch;
			continue;
		}
		const idx = stack.lastIndexOf(ch);
		if (idx === -1) return text;
		for (let k = stack.length - 1; k > idx; k -= 1) out += stack[k];
		out += ch;
		stack.length = idx;
	}
	if (inString) return text;
	while (stack.length > 0) out += stack.pop();
	return out;
}
/**
* Cheap structural gate: detect the unrepairable shapes that the live runs
* actually produced, so the caller can retry fast instead of after the whole
* repair ladder.
*
* Per candidate the scan is string-aware:
*  - ends inside an open string (inString=true at end of input) → shape 2;
*  - sees an extra closer (stack empty on a `}`/`]`) → shape 3;
*  - sees an UNESCAPED `"` that does not cleanly terminate the enclosing
*    string context — that is shape 1 and JSON.parse will reject it as
*    "unterminated string" or "expected property name".
*
* Returns the diagnosis as a message suffix, or null when every candidate is
* structurally clean.
*/
function diagnoseResponseShape(response) {
	if (response === "") return null;
	let inString = false;
	let escaped = false;
	const stack = [];
	let extraCloser = false;
	for (const ch of response) {
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			continue;
		}
		if (ch === "{") {
			stack.push("}");
			continue;
		}
		if (ch === "[") {
			stack.push("]");
			continue;
		}
		if (ch === "}" || ch === "]") {
			const idx = stack.lastIndexOf(ch);
			if (idx === -1) {
				extraCloser = true;
				continue;
			}
			stack.length = idx;
		}
	}
	if (inString) return "response truncated inside a string — closing it would invent data; retrying";
	if (extraCloser) return "response has an extra `}` or `]` with no matching opener — structural damage; retrying";
	return null;
}
/**
* Slice out the first COMPLETE JSON object using a string-aware brace scan.
*
* Measured live: a response ended `..."}]}\n  }\n}` — a valid object followed by
* two stray closers. `content.indexOf('{')` … `content.lastIndexOf('}')`
* therefore spans PAST the end of the object, and JSON.parse rejects the whole
* thing with "Unexpected non-whitespace character after JSON at position
* 5662". Scanning for the frame that actually closes at depth 0 recovers the
* real object (measured: parses with 2 files).
*
* Returns null when the document is never balanced, which is the truncation
* case the pre-flight gate reports instead.
*/
function extractFirstCompleteObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let inString = false;
	let escaped = false;
	let depth = 0;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}
/**
* Extract a candidate file set from a model response.
*/
function parseFileSetFromLLMResponse(content) {
	const attempts = [];
	const trimmed = content.trim();
	if (trimmed !== "") attempts.push(trimmed);
	for (const fence of content.matchAll(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g)) if (fence[1] && fence[1].trim() !== "") attempts.push(fence[1].trim());
	const firstBrace = content.indexOf("{");
	const lastBrace = content.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(content.slice(firstBrace, lastBrace + 1));
	const complete = extractFirstCompleteObject(content);
	if (complete !== null && !attempts.includes(complete)) attempts.push(complete);
	const shapeProblem = diagnoseResponseShape(trimmed);
	if (shapeProblem !== null) {
		const head = content.trim().slice(0, 200).replace(/\s+/g, " ");
		throw new Error(shapeProblem + " (length " + content.length + "); head: " + head);
	}
	const repairs = [
		(s) => s,
		stripTrailingCommas,
		repairInvalidEscapes,
		(s) => repairInvalidEscapes(stripTrailingCommas(s)),
		repairBrackets,
		(s) => repairBrackets(stripTrailingCommas(s)),
		(s) => repairBrackets(repairInvalidEscapes(s)),
		(s) => repairBrackets(repairInvalidEscapes(stripTrailingCommas(s)))
	];
	for (const attempt of attempts) for (const repair of repairs) try {
		const fileSet = normalizeFileSet(JSON.parse(repair(attempt)));
		if (fileSet.files.length > 0) return fileSet;
	} catch {}
	const head = content.trim().slice(0, 200).replace(/\s+/g, " ");
	throw new Error("no parseable JSON file set in the model response (length " + content.length + "); head: " + head);
}
/**
* Generation prompt, tightened against the failure shapes measured live.
*
* Measured over 20 live runs against the rotating 9Router backends
* (baseline, before this change): ~15% parse failures. Reading the captured
* bytes showed THREE distinct causes, and only one of them was "bad JSON":
*
*   1. finish_reason=length at 8192/8192 tokens (2 of 3 captured failures).
*      The model spent the whole budget and was cut off MID-STRING. Not a
*      JSON defect at all — a SIZE defect. The original prompt never said
*      how big the answer should be, so a backend that elaborated tests and
*      JSDoc ran out of room. Hence the explicit budget below.
*   2. structural drift (1 of 3): the model emitted a different shape, e.g.
*      `{"name":"compareIds","signature":...}` where a {path, content}
*      entry was required.
*   3. genuinely malformed JSON: an unescaped `"` inside a content string.
*
* So the rules below are ordered by what the measurements said mattered:
* size first, shape second, escaping third.
*/
function buildSystemPrompt() {
	return [
		"You generate one candidate improvement module for DSH, returned as a single JSON object.",
		"",
		"OUTPUT BUDGET — read this first:",
		"The entire response must stay UNDER 3000 characters.",
		"Write ONE source file and ONE test file. Keep each under 25 lines.",
		"No JSDoc blocks, no banner comments, no extra helper files, no second",
		"test file, no \"type\"/\"interface\" ceremony beyond what the code needs.",
		"A terse correct module beats a thorough one that gets cut off mid-string.",
		"",
		"The response must be EXACTLY this JSON shape and nothing else:",
		"{\"manifest\":{\"name\":\"kebab-case-name\",\"version\":\"1.0.0\",\"type\":\"verification-strategy\",",
		"\"description\":\"one short sentence\",\"entryPoint\":\"src/index.ts\",",
		"\"benchmarkCases\":[{\"id\":\"case-1\",\"description\":\"d\",\"input\":\"i\",",
		"\"expectedOutput\":\"o\",\"expectedExitCode\":0,\"timeoutMs\":10000,",
		"\"successCriteria\":\"s\"}]},",
		"\"files\":[{\"path\":\"src/index.ts\",\"content\":\"...\"}],",
		"\"tests\":[{\"path\":\"test/index.spec.ts\",\"content\":\"...\"}]}",
		"",
		"HARD RULES — each one is a failure shape observed in real responses:",
		"1. Output the JSON object and NOTHING else. No prose before or after it.",
		"   Do not restate these rules: a stray quote in the restatement is enough",
		"   to end the JSON string early.",
		"2. Every \"content\" value is a plain JSON string. Never embed a JavaScript",
		"   expression, a .replace() call, or template-literal syntax there — a",
		"   real response did, and it is unrecoverable.",
		"3. Inside a content string, every double quote MUST be written as \\\" and",
		"   every backslash as \\\\ . An unescaped quote ends the string early.",
		"4. files and tests are arrays of objects with EXACTLY the keys \"path\" and",
		"   \"content\" (both strings). No extra keys, no nested objects, no",
		"   signature/type/name descriptors.",
		"5. No trailing commas, no comments, no duplicate keys anywhere.",
		"6. Paths are relative, start with src/ or test/, end in .ts, and contain",
		"   neither ../ nor a leading /.",
		"7. manifest.type is exactly one of: policy, workflow, skill, routing-rule,",
		"   verification-strategy, retry-strategy, tool-selection-rule.",
		"8. manifest.entryPoint names one of the paths in \"files\".",
		"",
		"Respond now with only the JSON object."
	].join("\n");
}
function buildUserPrompt(patterns, experiences, parentVersion) {
	const clamp = (s) => s.length > 100 ? s.slice(0, 97) + "..." : s;
	const patternSummary = [...patterns].sort((a, b) => b.confidence - a.confidence).slice(0, 3).map((p) => "- Pattern " + p.id + " (" + p.type + "): " + clamp(p.description) + " (occ: " + p.occurrences + ")").join("\n");
	const recentFailures = experiences.filter((e) => !e.success).slice(0, 3).map((e) => "- Task " + clamp(e.taskId ?? "unknown") + ": " + clamp(e.summary ?? e.prompt ?? "no summary") + " | errors: " + clamp((e.errors ?? []).join(", "))).join("\n");
	let prompt = "Parent version: " + parentVersion + "\n\nOBSERVED PATTERNS:\n" + patternSummary + "\n\nRECENT FAILURES:\n" + (recentFailures || "(none)") + "\n\nGenerate a candidate module that addresses the observed patterns.";
	if (prompt.length > 1200) prompt = prompt.slice(0, 1197) + "...";
	return prompt;
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
			let lastParseError = "";
			try {
				fileSet = parseFileSetFromLLMResponse(llmResponse.content);
			} catch (error) {
				lastParseError = error instanceof Error ? error.message : String(error);
				let retry;
				try {
					retry = await callHostLLM(deps, systemPrompt, userPrompt, {
						provider: a.providerOverride,
						model: a.modelOverride
					});
				} catch (rErr) {
					return neutralizeDeep({
						ok: false,
						error: "LLM retry failed: " + (rErr instanceof Error ? rErr.message : String(rErr))
					});
				}
				try {
					fileSet = parseFileSetFromLLMResponse(retry.content);
				} catch (rErr) {
					const retryMsg = rErr instanceof Error ? rErr.message : String(rErr);
					return neutralizeDeep({
						ok: false,
						error: "Failed to parse LLM response (both attempts failed)",
						firstAttempt: lastParseError,
						retryAttempt: retryMsg
					});
				}
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
			const targets = [];
			for (const file of [...fileSet.files, ...fileSet.tests]) {
				const target = containPath(candidatesDir, file.path);
				if (target === null) return neutralizeDeep({
					ok: false,
					error: "candidate path escapes the candidate directory: " + file.path
				});
				targets.push({
					target,
					content: file.content
				});
			}
			for (const { target, content } of targets) {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content, "utf8");
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
* Clean up orphaned .staging directories from previously-crashed materializations.
* Safe to call on every refresh — only removes directories whose sibling (without
* the suffix) does not contain a valid manifest.  Never touches live artifacts.
*/
async function pruneStaleStaging(stateRoot) {
	try {
		const entries = await readdir(join(stateRoot, "versions"));
		for (const entry of entries) {
			if (!entry.endsWith(".staging") && !entry.endsWith(".new")) continue;
			const stem = entry.endsWith(".staging") ? entry.slice(0, -8) : entry.slice(0, -4);
			const siblingManifest = join(stateRoot, "versions", stem, "manifest.json");
			try {
				await readFile(siblingManifest, "utf8");
				continue;
			} catch {}
			await rm(join(stateRoot, "versions", entry), {
				recursive: true,
				force: true
			});
		}
	} catch {}
}
/**
* Bring the mounted plugin in line with the ACTIVE version. Called at boot and
* after every promotion/rollback. Never throws.
*/
async function refreshActivation(deps) {
	await pruneStaleStaging(deps.store.getRoot());
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
	lastCycleExperienceCount: -1,
	/** Timestamp of the last productive cycle (ms since epoch). Used for debounce. */
	lastCycleAt: 0
};
function resetAutoGuards() {
	guards.inFlight = false;
	guards.cyclesRun = 0;
	guards.lastCycleExperienceCount = -1;
	guards.lastCycleAt = 0;
}
function autoGuardState() {
	return { ...guards };
}
/** Deterministic description for a synthetic degradation pattern. */
function synthDegradationDescription(versionId, signals) {
	return "Degradation " + versionId + ": " + signals.join("; ");
}
/**
* Determine whether a candidate for the given degradation context already
* exists in a non-terminal status. Returns true if it does.
*/
async function degradationCandidateExists(deps, desc) {
	return (await deps.store.listCandidates(500)).some((c) => c.description === desc && c.status !== "promoted" && c.status !== "rejected");
}
/**
* Determine whether a synthetic pattern with the given description already
* exists in the store. Returns true if it does.
*/
async function syntheticPatternExists(deps, desc) {
	return (await deps.store.listPatterns(500)).some((p) => p.description === desc);
}
/**
* Check whether the active version has a degradation signal and whether a
* candidate for that signal already exists. Returns { versionId, evidenceIds,
* signals, total, description } when the version is degraded and no active
* candidate is already queued, or null otherwise.
*/
async function detectDegradationContext(deps) {
	const active = await deps.store.getActiveVersion();
	if (!active) return null;
	const records = await deps.store.listExperiencesByVersion(active.id, 500);
	if (records.length < 5) return null;
	const signal = detectVersionDegradation(records);
	if (!signal || !signal.isDegraded) return null;
	const desc = synthDegradationDescription(signal.versionId, signal.signals);
	if (await degradationCandidateExists(deps, desc)) return null;
	const evidenceIds = records.map((r) => r.id).filter((id) => typeof id === "string");
	const candidates = await deps.store.listCandidates(500);
	for (const c of candidates) {
		if (c.status === "promoted" || c.status === "rejected") continue;
		if (c.parentVersion !== signal.versionId) continue;
		if (!Array.isArray(c.evidenceIds) || c.evidenceIds.length === 0) continue;
		const candidateSet = new Set(c.evidenceIds);
		if (!evidenceIds.some((eid) => !candidateSet.has(eid))) return null;
	}
	const terminalEvidence = new Set(candidates.filter((c) => (c.status === "promoted" || c.status === "rejected") && c.parentVersion === signal.versionId && Array.isArray(c.evidenceIds) && c.evidenceIds.length > 0).flatMap((c) => c.evidenceIds));
	if (evidenceIds.every((eid) => terminalEvidence.has(eid))) return null;
	return {
		versionId: signal.versionId,
		evidenceIds,
		signals: signal.signals,
		total: signal.total,
		description: desc
	};
}
/**
* Create the synthetic degradation pattern if it does not already exist.
* Returns the pattern id, or null if the pattern was already present.
*/
async function ensureSyntheticPattern(deps, ctx) {
	if (await syntheticPatternExists(deps, ctx.description)) return null;
	return (await deps.store.addPattern({
		type: "failure",
		evidence: "FACT",
		description: ctx.description,
		occurrences: ctx.total,
		evidenceIds: ctx.evidenceIds,
		confidence: Math.min(.95, .5 + ctx.total * .02)
	})).id;
}
/**
* Run one degradation-driven synthesis when no pattern-driven patterns are
* available. Returns a non-null outcome only when a degradation-driven
* candidate was actually created; otherwise returns null so the caller can
* fall through to the generic "no patterns" response.
*
* Retry semantics: `ensureSyntheticPattern` persists the synthetic pattern
* even when generation later fails. That is intentional — it preserves
* provenance. The pattern is NOT a terminal dedup marker: a failed or
* rejected candidate does not permanently consume the degradation
* opportunity. The next cycle re-attempts generation using the existing
* pattern; a new candidate is only created if one is not already in flight
* or terminal (enforced by `degradationCandidateExists` inside
* `detectDegradationContext`).
*/
async function detectDegradationAndSynthesize(deps) {
	const cfg = deps.cfg().evolution;
	const ctx = await detectDegradationContext(deps);
	if (!ctx) return null;
	const genEnabled = cfg.generation.enabled;
	const patternId = await ensureSyntheticPattern(deps, ctx);
	if (!genEnabled) return {
		ran: true,
		reason: "degradation detected; generation disabled",
		patterns: patternId !== null ? 1 : 0,
		candidateId: void 0
	};
	let resolvedPatternId = patternId;
	if (resolvedPatternId === null) {
		const existing = (await deps.store.listPatterns(500)).find((p) => p.description === ctx.description);
		if (!existing) return {
			ran: true,
			reason: "degradation detected; pattern not found",
			patterns: 0
		};
		resolvedPatternId = existing.id;
	}
	const { builderTools } = await Promise.resolve().then(() => tools_exports);
	const build = builderTools(deps).find((t) => t.name === "evo_builder_generate");
	if (!build) return {
		ran: true,
		reason: "builder unavailable",
		patterns: 1
	};
	const built = await build.execute({
		patternIds: [resolvedPatternId],
		parentVersion: ctx.versionId
	}, { signal: AbortSignal.timeout(18e4) });
	if (built?.ok !== true || typeof built.candidateId !== "string") return {
		ran: true,
		reason: "generation failed: " + String(built?.error ?? "unknown"),
		patterns: patternId !== null ? 1 : 0
	};
	if (!cfg.promotion.enabled) return {
		ran: true,
		reason: "candidate generated; promotion disabled",
		patterns: patternId !== null ? 1 : 0,
		candidateId: built.candidateId
	};
	const { promoteTools } = await Promise.resolve().then(() => tools_exports$1);
	const decision = promoteTools(deps).find((t) => t.name === "evo_promote_decision");
	if (!decision) return {
		ran: true,
		reason: "promote module unavailable",
		patterns: patternId !== null ? 1 : 0
	};
	const verdict = await decision.execute({ candidateId: built.candidateId }, { signal: AbortSignal.timeout(6e4) });
	return {
		ran: true,
		reason: "candidate generated and evaluated from degradation signal",
		patterns: patternId !== null ? 1 : 0,
		candidateId: built.candidateId,
		verdict: verdict?.recommendation
	};
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
	if (Date.now() - guards.lastCycleAt < 2e3) return {
		ran: false,
		reason: "debounce: last cycle ran less than 2s ago"
	};
	guards.inFlight = true;
	let slotConsumed = false;
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
		const cycleActiveVersion = await deps.store.getActiveVersion();
		const cycleParentVersion = cycleActiveVersion ? cycleActiveVersion.id : "v0";
		if (fresh.length === 0) {
			const degraded = await detectDegradationAndSynthesize(deps);
			if (degraded) return degraded;
			return {
				ran: false,
				reason: "no actionable recurring pattern",
				patterns: 0
			};
		}
		guards.cyclesRun += 1;
		slotConsumed = true;
		guards.lastCycleAt = Date.now();
		deps.log("auto-cycle: " + fresh.length + " new pattern(s) from " + experiences.length + " experiences");
		const degradedCtx = await detectDegradationContext(deps);
		if (degradedCtx) {
			const synthId = await ensureSyntheticPattern(deps, degradedCtx);
			if (synthId !== null) fresh.unshift({
				id: synthId,
				confidence: Math.min(.95, .5 + degradedCtx.total * .02)
			});
			else {
				const existing = (await deps.store.listPatterns(500)).find((p) => p.description === degradedCtx.description);
				if (existing) fresh.unshift({
					id: existing.id,
					confidence: existing.confidence
				});
			}
			deps.log("auto-cycle: degradation signal detected for " + degradedCtx.versionId);
		}
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
		const built = await build.execute({
			patternIds: [strongest.id],
			parentVersion: cycleParentVersion
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
		if (slotConsumed) guards.cyclesRun -= 1;
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
			const storedCount = experiences.length;
			return neutralizeDeep({
				observedTurnsThisProcess: storedCount,
				ringBufferInFlight: observations.length,
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
			}).then(async () => {
				const expCfg = deps.cfg().experience;
				try {
					await deps.store.pruneExperiences(expCfg.maxRecords, expCfg.retentionDays);
				} catch {}
				runAutoCycle(deps);
			}).catch(() => {});
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
			await refreshActivation(deps);
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
	let profileName;
	try {
		const ctxRecord = ctx;
		const baseUrl = typeof ctxRecord.baseUrl === "string" ? ctxRecord.baseUrl : "";
		if (baseUrl) {
			const parts = new URL(baseUrl).pathname.split("/");
			const idx = parts.lastIndexOf("profiles");
			if (idx >= 0 && idx + 1 < parts.length) {
				const name = parts[idx + 1];
				if (name && /^[a-z0-9_-]+$/.test(name)) profileName = name;
			}
		}
	} catch {}
	const getFn = function(name2) {
		return ctx.get(name2);
	};
	const configuredRoot = resolved.stateRoot;
	const store = configuredRoot !== "" ? new EvolutionStore({
		get: getFn,
		fallbackRoot: configuredRoot
	}) : new EvolutionStore({
		get: getFn,
		profileName
	});
	const root = store.getRoot();
	try {
		await store.init();
		const cleaned = await cleanupTmpOrphans(root);
		if (cleaned > 0) log.info("cleaned " + cleaned + " tmp orphan(s) at startup");
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
