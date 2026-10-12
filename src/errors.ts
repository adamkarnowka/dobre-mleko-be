/** An error the API returns as `{ "error": code, "message": message, ...extra }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const notAuthorized = (message: string) => new HttpError(403, 'not_authorized', message);
export const invalidInput = (message: string) => new HttpError(422, 'invalid_input', message);
