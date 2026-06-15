import moment from "moment";

export function parseRelativeDateToAbsolute(relativeDate: string) {
  if (relativeDate == "never") return moment(0).toDate();

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
