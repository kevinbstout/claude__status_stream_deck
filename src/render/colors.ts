export const OK = "#00c853";
export const WARN = "#f4b675";
export const CRITICAL = "#d50000";
export const TRACK = "#2a2a2a";
export const TEXT = "#ffffff";
export const MUTED = "#8a8a8a";

export type Band = "ok" | "warn" | "critical" | "none";

/** Band a percentage against the fixed display thresholds. */
export function bandFor(value: number | undefined): Band {
	if (value === undefined || !Number.isFinite(value)) {
		return "none";
	}
	if (value >= 90) {
		return "critical";
	}
	if (value >= 70) {
		return "warn";
	}
	return "ok";
}

/** Band a percentage against user-configured thresholds, for the alert action. */
export function bandForThresholds(value: number | undefined, warnAt: number, criticalAt: number): Band {
	if (value === undefined || !Number.isFinite(value)) {
		return "none";
	}
	if (value >= criticalAt) {
		return "critical";
	}
	if (value >= warnAt) {
		return "warn";
	}
	return "ok";
}

export function colorFor(band: Band): string {
	switch (band) {
		case "critical":
			return CRITICAL;
		case "warn":
			return WARN;
		case "ok":
			return OK;
		default:
			return MUTED;
	}
}
