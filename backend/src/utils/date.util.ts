import moment from "moment";

export const NEVER_EXPIRES_DATE = new Date(0);
export const NEVER_EXPIRES_CUTOFF_DATE = new Date(
  "1970-01-02T00:00:00.000Z",
);

export function parseRelativeDateToAbsolute(relativeDate: string) {
  if (relativeDate == "never") return NEVER_EXPIRES_DATE;

  return moment()
    .add(
      relativeDate.split("-")[0],
      relativeDate.split("-")[1] as moment.unitOfTime.DurationConstructor,
    )
    .toDate();
}

type Timespan = {
  value: number;
  unit: "minutes" | "hours" | "days" | "weeks" | "months" | "years";
};

const timespanUnitAliases: Record<string, Timespan["unit"]> = {
  minute: "minutes",
  minutes: "minutes",
  min: "minutes",
  mins: "minutes",
  heure: "hours",
  heures: "hours",
  hour: "hours",
  hours: "hours",
  h: "hours",
  jour: "days",
  jours: "days",
  day: "days",
  days: "days",
  j: "days",
  semaine: "weeks",
  semaines: "weeks",
  week: "weeks",
  weeks: "weeks",
  mois: "months",
  month: "months",
  months: "months",
  an: "years",
  ans: "years",
  année: "years",
  années: "years",
  year: "years",
  years: "years",
};

/**
 * Validate an administrator-supplied timespan before it reaches persistent
 * configuration. Keep this strict: stringToTimespan remains deliberately
 * tolerant when reading historical values, but silently turning a typo into
 * `0 days` could disable an expiration limit or immediately expire sessions.
 */
export function isValidTimespanString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\s+(\S+)$/u.exec(value.trim().toLowerCase());
  if (!match) return false;

  const amount = Number(match[1]);
  return (
    Number.isSafeInteger(amount) &&
    amount >= 0 &&
    amount <= 999_999 &&
    Object.prototype.hasOwnProperty.call(timespanUnitAliases, match[2])
  );
}

export function stringToTimespan(value: string): Timespan {
  const [time, rawUnit = "days"] = value.trim().toLowerCase().split(/\s+/);
  const unit = timespanUnitAliases[rawUnit] ?? "days";

  return {
    value: Number.isFinite(parseInt(time)) ? parseInt(time) : 0,
    unit,
  };
}

export function timespanToString(timespan: Timespan) {
  return `${timespan.value} ${timespan.unit}`;
}
