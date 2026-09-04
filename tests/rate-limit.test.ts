import { describe, expect, it } from "vitest";
import {
  batchSize, effectiveHourlyLimit, estimateDurationSeconds, formatDuration,
  MAX_ATTEMPTS, remainingAllowance, retryDelaySeconds, shouldRetry,
} from "@/lib/rate-limit";
import { isPermanentSmtpError, sanitizeErrorMessage } from "@/lib/mailer";

const FACTOR = 0.95;

describe("effectiveHourlyLimit", () => {
  it("applies the safety margin below the provider ceiling", () => {
    expect(effectiveHourlyLimit(5000, FACTOR)).toBe(4750);
  });

  it("never exceeds the configured ceiling", () => {
    expect(effectiveHourlyLimit(5000, FACTOR)).toBeLessThan(5000);
    expect(effectiveHourlyLimit(100, 1)).toBe(100);
  });

  it("returns zero for a nonsensical limit rather than sending unbounded", () => {
    expect(effectiveHourlyLimit(0, FACTOR)).toBe(0);
    expect(effectiveHourlyLimit(-5, FACTOR)).toBe(0);
    expect(effectiveHourlyLimit(Number.NaN, FACTOR)).toBe(0);
  });
});

describe("remainingAllowance", () => {
  it("subtracts what the rolling hour already used", () => {
    expect(remainingAllowance(5000, 1000, FACTOR)).toBe(3750);
  });

  it("clamps to zero once the budget is spent", () => {
    expect(remainingAllowance(5000, 4750, FACTOR)).toBe(0);
    expect(remainingAllowance(5000, 9999, FACTOR)).toBe(0);
  });
});

describe("batchSize", () => {
  const base = { maxPerHour: 5000, batchCap: 200, tickIntervalSeconds: 60, factor: FACTOR };

  it("spreads the hourly quota across ticks instead of bursting", () => {
    // 4750/hour over 60s ticks is ~80 per tick, not the full 200 cap.
    expect(batchSize({ ...base, sentInLastHour: 0 })).toBe(80);
  });

  it("is limited by the batch cap on a long tick interval", () => {
    expect(batchSize({ ...base, sentInLastHour: 0, tickIntervalSeconds: 3600 })).toBe(200);
  });

  it("is limited by the remaining allowance near the ceiling", () => {
    expect(batchSize({ ...base, sentInLastHour: 4730 })).toBe(20);
  });

  it("returns zero when the hourly limit is exhausted", () => {
    expect(batchSize({ ...base, sentInLastHour: 4750 })).toBe(0);
    expect(batchSize({ ...base, sentInLastHour: 5000 })).toBe(0);
  });

  it("never returns a negative batch", () => {
    expect(batchSize({ ...base, sentInLastHour: 999_999 })).toBe(0);
  });

  it("sums to at most the effective limit over an hour of ticks", () => {
    let sent = 0;
    for (let tick = 0; tick < 60; tick++) {
      sent += batchSize({ ...base, sentInLastHour: sent });
    }
    expect(sent).toBeLessThanOrEqual(effectiveHourlyLimit(5000, FACTOR));
    expect(sent).toBeLessThan(5000);
  });
});

describe("estimateDurationSeconds", () => {
  it("estimates a 20,000-recipient campaign at roughly four hours", () => {
    const seconds = estimateDurationSeconds(20_000, 5000, FACTOR);
    expect(seconds).toBeGreaterThan(4 * 3600);
    expect(seconds).toBeLessThan(4.5 * 3600);
  });

  it("is zero for an empty campaign", () => {
    expect(estimateDurationSeconds(0, 5000, FACTOR)).toBe(0);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "less than a minute"],
    [45, "about a minute"],
    [1800, "about 30 minutes"],
    [3600, "about 1 hour"],
    [15_000, "about 4h 10m"],
  ])("formats %i seconds", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe("retry policy", () => {
  it("backs off incrementally", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(300);
    expect(retryDelaySeconds(3)).toBe(900);
  });

  it("retries a temporary failure until the attempt limit", () => {
    expect(shouldRetry(1, false, 3)).toBe(true);
    expect(shouldRetry(2, false, 3)).toBe(true);
    expect(shouldRetry(3, false, 3)).toBe(false);
  });

  it("never retries a permanent failure", () => {
    expect(shouldRetry(1, true, 3)).toBe(false);
  });

  it("defaults to three attempts", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe("isPermanentSmtpError", () => {
  it("treats 5xx replies as permanent", () => {
    expect(isPermanentSmtpError({ responseCode: 550 })).toBe(true);
    expect(isPermanentSmtpError({ responseCode: 553 })).toBe(true);
  });

  it("treats 4xx replies and socket errors as temporary", () => {
    expect(isPermanentSmtpError({ responseCode: 421 })).toBe(false);
    expect(isPermanentSmtpError({ responseCode: 451 })).toBe(false);
    expect(isPermanentSmtpError({ code: "ETIMEDOUT" })).toBe(false);
  });

  it("defaults to temporary for an unknown error", () => {
    expect(isPermanentSmtpError(new Error("who knows"))).toBe(false);
    expect(isPermanentSmtpError(null)).toBe(false);
  });
});

describe("sanitizeErrorMessage", () => {
  const config = {
    host: "smtp-pulse.com", port: 587, security: "starttls" as const,
    user: "user@example.com", password: "sup3r-s3cret",
    fromEmail: "a@b.com", fromName: null, replyTo: null, maxEmailsPerHour: 5000,
  };

  it("redacts the SMTP password", () => {
    const message = sanitizeErrorMessage(new Error("auth failed for sup3r-s3cret"), config);
    expect(message).not.toContain("sup3r-s3cret");
    expect(message).toContain("***");
  });

  it("redacts the SMTP username", () => {
    expect(sanitizeErrorMessage(new Error("bad user@example.com"), config))
      .not.toContain("user@example.com");
  });

  it("redacts an AUTH command echoed back by the server", () => {
    expect(sanitizeErrorMessage(new Error("AUTH PLAIN dXNlcjpwYXNz"), config))
      .not.toContain("dXNlcjpwYXNz");
  });

  it("keeps the SMTP response code, which is the useful part", () => {
    const error = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
    expect(sanitizeErrorMessage(error, config)).toContain("550");
  });

  it("truncates a runaway error message", () => {
    expect(sanitizeErrorMessage(new Error("x".repeat(5000)), config).length).toBeLessThanOrEqual(500);
  });
});
