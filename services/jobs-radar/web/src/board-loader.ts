type API = (path: string, options?: RequestInit) => Promise<any>;

// Cancel superseded lists as the owner changes filters or pages.
export function createBoardLoader(api: API) {
  let controller: AbortController | undefined;
  return {
    jobs(params: URLSearchParams) {
      controller?.abort();
      controller = new AbortController();
      return api("/api/jobs?" + params, { signal: controller.signal });
    },
    cancel() {
      controller?.abort();
    },
  };
}
