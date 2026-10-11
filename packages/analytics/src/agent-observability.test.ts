import { describe, expect, it } from "vitest";
import { isAgentObservabilityConfigured } from "./agent-observability.js";

describe("Agent Observability configuration", () => {
  it("requires generation ingest and OTLP credentials", () => {
    expect(isAgentObservabilityConfigured({})).toBe(false);
    expect(
      isAgentObservabilityConfigured({
        AGENTO11Y_ENDPOINT: "https://agento11y.example.net",
        AGENTO11Y_PROTOCOL: "http",
        AGENTO11Y_AUTH_MODE: "basic",
        AGENTO11Y_AUTH_TENANT_ID: "1234",
        AGENTO11Y_AUTH_TOKEN: "token",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.net/otlp",
      }),
    ).toBe(false);
    expect(
      isAgentObservabilityConfigured({
        AGENTO11Y_ENDPOINT: "https://agento11y.example.net",
        AGENTO11Y_PROTOCOL: "http",
        AGENTO11Y_AUTH_MODE: "basic",
        AGENTO11Y_AUTH_TENANT_ID: "1234",
        AGENTO11Y_AUTH_TOKEN: "token",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.net/otlp",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==",
      }),
    ).toBe(true);
  });
});
