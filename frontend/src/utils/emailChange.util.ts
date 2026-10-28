export type EmailChangeAction = { action: "confirm" | "cancel"; token: string };

export function parseEmailChangeFragment(
  fragment: string,
): EmailChangeAction | null {
  if (!fragment.startsWith("#") || fragment.length > 100) return null;
  const params = new URLSearchParams(fragment.slice(1));
  if (
    [...params.keys()].length !== 2 ||
    params.getAll("token").length !== 1 ||
    params.getAll("action").length !== 1
  )
    return null;
  const action = params.get("action");
  const token = params.get("token");
  if (
    (action !== "confirm" && action !== "cancel") ||
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    return null;
  return { action, token };
}
