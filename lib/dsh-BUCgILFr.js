//#region src/host/dsh.ts
/** Object output schema (host-supported subset). */
const JSON_OBJECT_OUTPUT = {
	type: "object",
	properties: {},
	additionalProperties: true
};
function defineTool(def) {
	return def;
}
function registerToolSafe(ctx, definition) {
	try {
		ctx.tools.register(definition);
		return {
			name: definition.name,
			ok: true
		};
	} catch (error) {
		return {
			name: definition.name,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
function text(value) {
	if (typeof value === "string") return [{
		type: "text",
		text: value
	}];
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
//#endregion
export { text as i, defineTool as n, registerToolSafe as r, JSON_OBJECT_OUTPUT as t };
