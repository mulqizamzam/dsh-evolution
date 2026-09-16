//#region src/lib/caps.ts
/** Clamp text to a max length, appending an ellipsis if truncated. */
function clampText(input, max) {
	if (typeof input !== "string") return "";
	if (input.length <= max) return input;
	return input.slice(0, max - 3) + "...";
}
//#endregion
//#region src/host/types.ts
const DEFAULT_PROMOTION_POLICY = {
	minSuccessImprovement: .05,
	maxRegression: -.05,
	maxLatencyMultiplier: 3,
	minCandidateCases: 1,
	minRuns: 3
};
//#endregion
export { clampText as n, DEFAULT_PROMOTION_POLICY as t };
