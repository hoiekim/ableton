/**
 * Fetches JSON from the server's /api routes. The page is read from
 * dist/client on every load, so after a rebuild it can be newer than the
 * server still running, and a route that server doesn't have yet answers
 * with the page itself. Say so, rather than failing to read HTML as JSON.
 */
export const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("The server is older than this page. Restart it (bun run start) to load the latest build.");
  }
  if (!response.ok) throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
  return (await response.json()) as T;
};
