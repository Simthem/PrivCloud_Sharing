// Sensitive operations answer 403 "step_up_required" with the scope to
// confirm. The dialog mounted for signed-in users confirms it, then the API
// client replays the request once.

const SCOPE = /^[a-z][a-z.]{2,48}(?::[A-Za-z0-9_-]{1,64})?$/;

type StepUpHandler = (_scope: string) => Promise<boolean>;

let handler: StepUpHandler | null = null;

/** The scope a refused request asks to confirm, or null for any other error. */
export function readStepUpScope(error: unknown): string | null {
  const response = (
    error as { response?: { status?: number; data?: unknown } } | null
  )?.response;
  const data = response?.data as { error?: unknown; scope?: unknown } | null;
  if (
    response?.status !== 403 ||
    data?.error !== "step_up_required" ||
    typeof data.scope !== "string" ||
    !SCOPE.test(data.scope)
  ) {
    return null;
  }
  return data.scope;
}

export function setStepUpHandler(next: StepUpHandler | null) {
  handler = next;
}

/** Whether the user confirmed (false without a dialog to ask). */
export function requestStepUp(scope: string): Promise<boolean> {
  return handler ? handler(scope) : Promise.resolve(false);
}
