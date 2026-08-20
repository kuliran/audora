import { v } from "convex/values";

export const acousticMetricSummaryValidator = v.object({
  paceWpm: v.optional(v.number()),
  articulationRateWpm: v.optional(v.number()),
  medianPitchHz: v.optional(v.number()),
  pitchRangeSemitones: v.optional(v.number()),
  pitchDirection: v.optional(
    v.union(
      v.literal("rising"),
      v.literal("level"),
      v.literal("falling"),
      v.literal("varied"),
      v.literal("unavailable")
    )
  ),
  volumeVariabilityDb: v.optional(v.number()),
  steadiness: v.optional(v.number()),
  voicedRatio: v.optional(v.number()),
  qualityFlags: v.optional(v.array(v.string())),
});

export const acousticMetricPhraseValidator = v.object({
  startTime: v.number(),
  endTime: v.number(),
  text: v.optional(v.string()),
  paceWpm: v.optional(v.number()),
  articulationRateWpm: v.optional(v.number()),
  medianPitchHz: v.optional(v.number()),
  pitchRangeSemitones: v.optional(v.number()),
  pitchDirection: v.optional(
    v.union(
      v.literal("rising"),
      v.literal("level"),
      v.literal("falling"),
      v.literal("varied"),
      v.literal("unavailable")
    )
  ),
  relativeVolumeDb: v.optional(v.number()),
  volumeVariabilityDb: v.optional(v.number()),
  steadiness: v.optional(v.number()),
  voicedRatio: v.optional(v.number()),
  qualityFlags: v.optional(v.array(v.string())),
});

export const acousticMetricSourceValidator = v.object({
  source: v.union(v.literal("mic"), v.literal("system")),
  speaker: v.optional(v.string()),
  scope: v.optional(
    v.union(v.literal("single_speaker"), v.literal("mixed_channel"))
  ),
  overall: v.optional(acousticMetricSummaryValidator),
  phrases: v.optional(v.array(acousticMetricPhraseValidator)),
});

export const acousticMetricsValidator = v.object({
  version: v.literal(1),
  sources: v.array(acousticMetricSourceValidator),
});

type QualityFields = {
  paceWpm?: number;
  articulationRateWpm?: number;
  medianPitchHz?: number;
  pitchRangeSemitones?: number;
  pitchDirection?:
    | "rising"
    | "level"
    | "falling"
    | "varied"
    | "unavailable";
  relativeVolumeDb?: number;
  volumeVariabilityDb?: number;
  steadiness?: number;
  voicedRatio?: number;
  qualityFlags?: string[];
};

export type AcousticMetricPhrase = QualityFields & {
  startTime: number;
  endTime: number;
  text?: string;
};

export type AcousticMetricSource = {
  source: "mic" | "system";
  speaker?: string;
  scope?: "single_speaker" | "mixed_channel";
  overall?: Omit<QualityFields, "relativeVolumeDb">;
  phrases?: AcousticMetricPhrase[];
};

export type AcousticMetrics = {
  version: 1;
  sources: AcousticMetricSource[];
};

const MAX_SOURCES = 2;
// Acoustic metrics live in one document per conversation. Keep the wire copy
// deliberately compact; the Mac retains the complete phrase set locally.
const MAX_PHRASES_PER_SOURCE = 200;
const MAX_FLAGS_PER_METRIC = 8;
const MAX_FLAG_LENGTH = 48;
const MAX_PHRASE_TEXT_LENGTH = 240;
const QUALITY_FLAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function requireRange(
  value: number | undefined,
  label: string,
  minimum: number,
  maximum: number
) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
}

function validateQualityFields(fields: QualityFields, label: string) {
  requireRange(fields.paceWpm, `${label}.paceWpm`, 0, 1_000);
  requireRange(
    fields.articulationRateWpm,
    `${label}.articulationRateWpm`,
    0,
    1_000
  );
  requireRange(fields.medianPitchHz, `${label}.medianPitchHz`, 0, 2_000);
  requireRange(
    fields.pitchRangeSemitones,
    `${label}.pitchRangeSemitones`,
    0,
    72
  );
  requireRange(fields.relativeVolumeDb, `${label}.relativeVolumeDb`, -120, 120);
  requireRange(
    fields.volumeVariabilityDb,
    `${label}.volumeVariabilityDb`,
    0,
    120
  );
  requireRange(fields.steadiness, `${label}.steadiness`, 0, 1);
  requireRange(fields.voicedRatio, `${label}.voicedRatio`, 0, 1);

  if ((fields.qualityFlags?.length ?? 0) > MAX_FLAGS_PER_METRIC) {
    throw new Error(`${label}.qualityFlags contains too many entries`);
  }
  for (const flag of fields.qualityFlags ?? []) {
    if (
      flag.length > MAX_FLAG_LENGTH ||
      !QUALITY_FLAG_PATTERN.test(flag)
    ) {
      throw new Error(`${label}.qualityFlags contains an invalid flag`);
    }
  }
}

/**
 * Convex validators enforce the shape. These checks additionally keep local
 * analyzer bugs from persisting nonsensical or unexpectedly large payloads.
 */
export function validateAcousticMetrics(metrics: AcousticMetrics) {
  if (metrics.sources.length > MAX_SOURCES) {
    throw new Error(`acousticMetrics supports at most ${MAX_SOURCES} sources`);
  }

  const seenSources = new Set<string>();
  for (const sourceMetrics of metrics.sources) {
    if (seenSources.has(sourceMetrics.source)) {
      throw new Error(`Duplicate acoustic source: ${sourceMetrics.source}`);
    }
    seenSources.add(sourceMetrics.source);

    if ((sourceMetrics.speaker?.length ?? 0) > 80) {
      throw new Error("acousticMetrics speaker label is too long");
    }
    if (
      sourceMetrics.source === "system" &&
      sourceMetrics.scope !== "mixed_channel"
    ) {
      throw new Error(
        "System-audio acoustic metrics must use mixed_channel scope"
      );
    }
    if (sourceMetrics.overall) {
      validateQualityFields(
        sourceMetrics.overall,
        `acousticMetrics.${sourceMetrics.source}.overall`
      );
    }

    const phrases = sourceMetrics.phrases ?? [];
    if (phrases.length > MAX_PHRASES_PER_SOURCE) {
      throw new Error(
        `acousticMetrics.${sourceMetrics.source}.phrases contains too many entries`
      );
    }
    let previousStartTime = -1;
    for (let index = 0; index < phrases.length; index += 1) {
      const phrase = phrases[index];
      const label = `acousticMetrics.${sourceMetrics.source}.phrases[${index}]`;
      requireRange(phrase.startTime, `${label}.startTime`, 0, 24 * 60 * 60);
      requireRange(phrase.endTime, `${label}.endTime`, 0, 24 * 60 * 60);
      if (phrase.endTime < phrase.startTime) {
        throw new Error(`${label}.endTime must not precede startTime`);
      }
      if (phrase.startTime < previousStartTime) {
        throw new Error(`${label}.startTime must be ordered`);
      }
      previousStartTime = phrase.startTime;
      if ((phrase.text?.length ?? 0) > MAX_PHRASE_TEXT_LENGTH) {
        throw new Error(`${label}.text is too long`);
      }
      validateQualityFields(phrase, label);
    }
  }
}

function bucket(value: number | undefined, step: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value / step) * step;
}

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds * 10) / 10);
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded - minutes * 60;
  return `${minutes}:${remaining.toFixed(1).padStart(4, "0")}`;
}

function formatRatioBucket(value: number | undefined) {
  if (value === undefined) return undefined;
  if (value < 0.4) return "low";
  if (value < 0.7) return "moderate";
  return "high";
}

function formatCoverageBucket(value: number | undefined) {
  if (value === undefined) return undefined;
  if (value < 0.5) return "low";
  if (value < 0.8) return "partial";
  return "good";
}

function formatQualityFlags(flags: string[] | undefined) {
  if (!flags?.length) return undefined;
  return flags.map((flag) => flag.replace(/[_-]+/g, " ")).join(", ");
}

function formatFieldsForAI(fields: QualityFields, includeRelativeVolume: boolean) {
  const values: string[] = [];
  const pace = bucket(fields.paceWpm, 5);
  const articulationRate = bucket(fields.articulationRateWpm, 5);
  const pitchRange = bucket(fields.pitchRangeSemitones, 0.5);
  const volumeVariability = bucket(fields.volumeVariabilityDb, 0.5);
  const relativeVolume = bucket(fields.relativeVolumeDb, 1);
  const steadiness = formatRatioBucket(fields.steadiness);
  const voicedCoverage = formatCoverageBucket(fields.voicedRatio);
  const flags = formatQualityFlags(fields.qualityFlags);

  if (pace !== undefined) values.push(`delivery pace ~${pace} WPM`);
  if (articulationRate !== undefined) {
    values.push(`articulation rate ~${articulationRate} WPM`);
  }
  if (pitchRange !== undefined) values.push(`pitch range ~${pitchRange} semitones`);
  if (fields.pitchDirection && fields.pitchDirection !== "unavailable") {
    values.push(`pitch direction ${fields.pitchDirection}`);
  }
  if (includeRelativeVolume && relativeVolume !== undefined) {
    values.push(`relative volume ~${relativeVolume} dB`);
  }
  if (volumeVariability !== undefined) {
    values.push(`volume variability ~${volumeVariability} dB`);
  }
  if (steadiness) values.push(`cadence steadiness ${steadiness}`);
  if (voicedCoverage) values.push(`voiced coverage ${voicedCoverage}`);
  if (flags) values.push(`quality flags: ${flags}`);

  // Deliberately omit medianPitchHz: absolute pitch is not needed for coaching
  // and is more identifying than the relative pitch range sent above.
  return values;
}

function evenlySample<T>(values: T[], limit: number) {
  if (limit <= 0) return [];
  if (values.length <= limit) return values;
  if (limit === 1) return values.slice(0, 1);

  const selected: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(values[Math.round((index * (values.length - 1)) / (limit - 1))]);
  }
  return selected;
}

export function formatAcousticMetricsForAI(
  metrics: AcousticMetrics | undefined,
  maxPhrasesPerSource = 60
) {
  if (!metrics?.sources.length) return "";

  const lines = [
    "## LOCAL ACOUSTIC DELIVERY METRICS",
    "Values are rounded or categorical local measurements, not identity or emotion inferences.",
  ];

  for (const source of metrics.sources) {
    const sourceName = source.source === "mic" ? "Microphone" : "System audio";
    const scopeNote =
      source.source === "system" || source.scope === "mixed_channel"
        ? " (mixed channel; do not attribute metrics to an individual speaker)"
        : "";
    lines.push(`### ${sourceName}${scopeNote}`);

    if (source.overall) {
      const values = formatFieldsForAI(source.overall, false);
      if (values.length) lines.push(`- Overall: ${values.join("; ")}`);
    }

    const phrases = evenlySample(
      source.phrases ?? [],
      Math.max(0, maxPhrasesPerSource)
    );
    for (const phrase of phrases) {
      const values = formatFieldsForAI(phrase, true);
      if (!values.length) continue;
      const text = phrase.text?.replace(/\s+/g, " ").trim();
      const excerpt = text
        ? ` — ${text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text}`
        : "";
      lines.push(
        `- ${formatTimestamp(phrase.startTime)}–${formatTimestamp(phrase.endTime)}: ${values.join("; ")}${excerpt}`
      );
    }
  }

  return lines.length > 2 ? `${lines.join("\n")}\n` : "";
}
