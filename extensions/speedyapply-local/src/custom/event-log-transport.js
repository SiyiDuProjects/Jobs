// Exact server validation messages only. Never persist response bodies or
// exception strings: proxies and providers may echo private request data.
const rejectionReasons = new Map([
  ["History packet is too large", "packet_too_large"],
  ["Request too large", "packet_too_large"],
  ["Invalid browser control list", "invalid_list"],
  ["Invalid browser control shape", "invalid_shape"],
  ["Invalid browser control text", "invalid_text"],
  ["Invalid browser control integer", "invalid_integer"],
  ["Invalid browser control boolean", "invalid_boolean"],
  ["Credentials are not browser control data", "credential_data"],
  ["Invalid or credential-bearing page URL", "invalid_url"],
]);
export async function diagnosticRejection(response) {
  let reason = "http_error";
  try {
    reason = rejectionReasons.get((await response.json()).error) || reason;
  } catch {}
  return { status: response.status, reason };
}
export class DiagnosticUploadError extends Error {
  constructor(httpStatus, reason = "http_error") {
    super(
      httpStatus
        ? `Diagnostics upload failed (${httpStatus})`
        : "Diagnostics were not acknowledged",
    );
    this.httpStatus = httpStatus;
    this.reason = reason;
  }
}
export function transportFailure(error) {
  return error instanceof DiagnosticUploadError
    ? { httpStatus: error.httpStatus, reason: error.reason }
    : { reason: error?.name === "TimeoutError" ? "timeout" : "upload_failed" };
}
