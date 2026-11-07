/** The largest length limit that can be set: one week. 0 means no limit at all. */
export const MAX_LENGTH_LIMIT_SEC = 604_800;

/** True when a track of `durationSec` is longer than `limitSec`. A limit of 0 means no limit. */
export function exceedsLengthLimit(durationSec: number, limitSec: number): boolean {
  return limitSec > 0 && durationSec > limitSec;
}

/** Valid limits: 0 (no limit) or from one minute to MAX_LENGTH_LIMIT_SEC. */
export function isValidLengthLimit(limitSec: number): boolean {
  return (
    Number.isInteger(limitSec) &&
    (limitSec === 0 || (limitSec >= 60 && limitSec <= MAX_LENGTH_LIMIT_SEC))
  );
}

/** "45 мин.", "10 ч", "без ограничения". */
export function describeLengthLimit(limitSec: number): string {
  if (limitSec === 0) {
    return 'без ограничения';
  }
  const minutes = Math.floor(limitSec / 60);
  return minutes % 60 === 0 && minutes >= 60
    ? `${String(minutes / 60)} ч`
    : `${String(minutes)} мин.`;
}
