export class FlipkartScraperError extends Error {}

export type BlockReason =
  | "rate_limited"
  | "captcha"
  | "access_denied"
  | "login_wall"
  | "disallowed_redirect"
  | "timeout"
  | "network"
  | "cooldown";

/** CAPTCHA, login wall, rate limit, timeout or a redirect to a disallowed path. Never bypassed. */
export class FlipkartBlockedError extends FlipkartScraperError {
  reason: BlockReason;
  retryAfterSeconds: number | null;
  constructor(message: string, opts: { reason?: BlockReason; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.reason = opts.reason ?? "access_denied";
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

export class FlipkartNotFoundError extends FlipkartScraperError {}

/** Too many lookups already waiting; reported as 429, nothing is sent to Flipkart. */
export class ServerBusyError extends FlipkartScraperError {}
