// Android browsers cannot launch the desktop native host. A Companion running
// on the device keeps its explicit, permission-guarded loopback transport.
// Desktop never selects this transport, even when its extension is absent.
const BASES = ["http://127.0.0.1:47631/v1", "http://localhost:47631/v1"];

export function usesAndroidLoopback(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  return platform === "Android" || /\bAndroid\b/i.test(navigator.userAgent);
}

async function assertAndroidPermission(requestAccess: boolean) {
  if (typeof window === "undefined" || !window.isSecureContext)
    throw new Error("bridge.error.secureContextRequired");
  if (!navigator.permissions?.query) return;
  for (const name of ["loopback-network", "local-network-access"]) {
    let state: PermissionState;
    try {
      state = (
        await navigator.permissions.query({
          name,
        } as unknown as PermissionDescriptor)
      ).state;
    } catch {
      continue;
    }
    if (state === "denied")
      throw new Error("bridge.error.localNetworkPermissionDenied");
    if (state === "prompt" && !requestAccess)
      throw new Error("bridge.error.localNetworkPermissionRequired");
    return;
  }
}

function addressSpace(): RequestInit {
  for (const space of ["loopback", "local"]) {
    try {
      const options = { targetAddressSpace: space } as RequestInit;
      if (
        (
          new Request(BASES[0], options) as Request & {
            targetAddressSpace?: string;
          }
        ).targetAddressSpace === space
      )
        return options;
    } catch {
      /* An older browser can still use literal loopback addresses. */
    }
  }
  return {};
}

export async function androidBridgeFetch(
  path: string,
  {
    body,
    token,
    signal,
    requestAccess = false,
  }: {
    body?: Record<string, unknown>;
    token?: string;
    signal?: AbortSignal;
    requestAccess?: boolean;
  } = {},
): Promise<Response> {
  if (!usesAndroidLoopback()) throw new Error("bridge.error.unavailable");
  await assertAndroidPermission(requestAccess);
  for (const base of BASES) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const requestSignal =
      signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, signal])
        : (signal ?? controller.signal);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(base + path, {
        ...addressSpace(),
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      await assertAndroidPermission(false);
      if (base === BASES.at(-1))
        throw new Error("bridge.error.unavailable", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("bridge.error.unavailable");
}

export async function readAndroidBridgeJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data?.message === "string" &&
      /^(bridge|webdav|upload)\.error\.[A-Za-z]+$/.test(data.message)
        ? data.message
        : "bridge.error.unavailable";
    throw new Error(message);
  }
  return data as T;
}
