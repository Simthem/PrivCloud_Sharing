export const config = { getBoolean: () => true, getString: () => "AQID" };
export function useConfig() {
  return config;
}
async function request(path, method = "GET", payload) {
  const response = await fetch("/api/" + path.replace(/^\//, ""), {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("API request failed");
  return { data: response.status === 204 ? undefined : await response.json() };
}
export const api = {
  get: (path) => request(path),
  post: (path, data) => request(path, "POST", data),
  delete: (path, options) => request(path, "DELETE", options?.data),
};
export const users = {
  getCurrentUserStrict: async () => (await request("users/me")).data,
  updateCurrentUser: async (data) =>
    (await request("users/me", "PATCH", data)).data,
};
export const toast = { success: () => {}, error: () => {} };
