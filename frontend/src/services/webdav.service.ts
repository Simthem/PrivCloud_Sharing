export type WebDavCredentials = {
  endpoint: string;
  username: string;
  password: string;
};

export type WebDavEntry = {
  id: string;
  name: string;
  href: string;
  isDirectory: boolean;
  size: number;
  contentType?: string;
  lastModified?: string;
};

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<d:propfind xmlns:d="DAV:">' +
  "<d:prop>" +
  "<d:displayname />" +
  "<d:resourcetype />" +
  "<d:getcontentlength />" +
  "<d:getcontenttype />" +
  "<d:getlastmodified />" +
  "</d:prop>" +
  "</d:propfind>";

function encodeBasicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `Basic ${btoa(binary)}`;
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim());
  if (url.protocol !== "https:") {
    throw new Error("webdav.error.https");
  }
  url.username = "";
  url.password = "";
  return url.href;
}

function asDirectoryUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function sameResource(a: URL, b: URL): boolean {
  const normalizePath = (path: string) => path.replace(/\/+$/, "") || "/";
  return (
    a.origin === b.origin &&
    normalizePath(a.pathname) === normalizePath(b.pathname)
  );
}

function entryNameFromHref(href: URL): string {
  const cleanPath = href.pathname.replace(/\/+$/, "");
  const raw = cleanPath.split("/").pop() || cleanPath || "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function firstText(parent: Element, localName: string): string | undefined {
  const node = parent.getElementsByTagNameNS("*", localName)[0];
  const text = node?.textContent?.trim();
  return text || undefined;
}

function parseMultiStatus(xml: string, baseUrl: string): WebDavEntry[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("webdav.error.invalidXml");
  }

  const rootUrl = new URL(baseUrl);
  const responses = Array.from(doc.getElementsByTagNameNS("*", "response"));
  const entries: WebDavEntry[] = [];

  for (const response of responses) {
    const hrefText = firstText(response, "href");
    if (!hrefText) continue;

    const href = new URL(hrefText, rootUrl.origin);
    if (sameResource(href, rootUrl)) continue;
    if (href.origin !== rootUrl.origin) continue;

    const resourceType = response.getElementsByTagNameNS(
      "*",
      "resourcetype",
    )[0];
    const isDirectory =
      !!resourceType?.getElementsByTagNameNS("*", "collection").length ||
      href.pathname.endsWith("/");
    const displayName = firstText(response, "displayname");
    const size = Number(firstText(response, "getcontentlength") || "0");

    entries.push({
      id: href.href,
      name: displayName || entryNameFromHref(href),
      href: href.href,
      isDirectory,
      size: Number.isFinite(size) ? size : 0,
      contentType: firstText(response, "getcontenttype"),
      lastModified: firstText(response, "getlastmodified"),
    });
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function webDavFetch(
  credentials: WebDavCredentials,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const endpoint = normalizeEndpoint(url);
  const response = await fetch(endpoint, {
    ...init,
    mode: "cors",
    credentials: "omit",
    headers: {
      Authorization: encodeBasicAuth(
        credentials.username,
        credentials.password,
      ),
      ...init.headers,
    },
  });

  if (response.status === 401 || response.status === 403) {
    response.body?.cancel();
    throw new Error("webdav.error.auth");
  }
  if (!response.ok && response.status !== 207) {
    response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }

  return response;
}

export async function listWebDavDirectory(
  credentials: WebDavCredentials,
  directoryUrl?: string,
): Promise<{ url: string; entries: WebDavEntry[] }> {
  const url = asDirectoryUrl(
    normalizeEndpoint(directoryUrl || credentials.endpoint),
  );
  const response = await webDavFetch(credentials, url, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml,text/xml",
    },
    body: PROPFIND_BODY,
  });

  const xml = await response.text();
  return {
    url,
    entries: parseMultiStatus(xml, url),
  };
}

export async function downloadWebDavFile(
  credentials: WebDavCredentials,
  entry: WebDavEntry,
  signal?: AbortSignal,
): Promise<File> {
  if (entry.isDirectory) {
    throw new Error("webdav.error.directory");
  }

  const response = await webDavFetch(credentials, entry.href, {
    method: "GET",
    signal,
  });
  const blob = await response.blob();
  return new File([blob], entry.name, {
    type: entry.contentType || blob.type || "application/octet-stream",
    lastModified: entry.lastModified
      ? Date.parse(entry.lastModified)
      : Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Server-side WebDAV proxy (bypasses CORS/CSP/PNA - works on all platforms)
// ---------------------------------------------------------------------------

export async function listWebDavViaProxy(
  credentials: WebDavCredentials,
  directoryUrl?: string,
): Promise<{ url: string; entries: WebDavEntry[] }> {
  const response = await fetch("/api/webdav/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      endpoint: credentials.endpoint,
      username: credentials.username,
      password: credentials.password,
      href: directoryUrl || undefined,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  let data: { url?: string; xml?: string; error?: string; status?: number };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`webdav.error.generic`);
  }
  if (data.error === "auth") throw new Error("webdav.error.auth");
  if (data.error) throw new Error(`HTTP ${data.status || "error"}`);
  return {
    url: data.url!,
    entries: parseMultiStatus(data.xml!, data.url!),
  };
}

export async function downloadWebDavViaProxy(
  credentials: WebDavCredentials,
  entry: WebDavEntry,
  signal?: AbortSignal,
): Promise<File> {
  if (entry.isDirectory) {
    throw new Error("webdav.error.directory");
  }

  const response = await fetch("/api/webdav/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      endpoint: credentials.endpoint,
      username: credentials.username,
      password: credentials.password,
      href: entry.href,
    }),
    signal,
  });

  if (response.status === 401) throw new Error("webdav.error.auth");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  return new File([blob], entry.name, {
    type: entry.contentType || blob.type || "application/octet-stream",
    lastModified: entry.lastModified
      ? Date.parse(entry.lastModified)
      : Date.now(),
  });
}
