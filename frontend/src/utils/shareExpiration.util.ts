/** Use the viewer's device timezone. Language controls the format only. */
export function formatShareExpiration(
  expiration: Date | string,
  locale: string,
) {
  const date = new Date(expiration);
  return {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    }).format(date),
    iso: date.toISOString(),
  };
}

export function isShareExpired(expiration: Date | string, now = Date.now()) {
  const timestamp = new Date(expiration).getTime();
  return timestamp !== 0 && timestamp <= now;
}
