import { Agento11yClient } from "@grafana/agento11y";
import { createAgento11yVercelAiSdk } from "@grafana/agento11y/vercel-ai-sdk";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const requiredEnvironment = [
  "AGENTO11Y_ENDPOINT",
  "AGENTO11Y_PROTOCOL",
  "AGENTO11Y_AUTH_MODE",
  "AGENTO11Y_AUTH_TENANT_ID",
  "AGENTO11Y_AUTH_TOKEN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
] as const;

export function isAgentObservabilityConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return requiredEnvironment.every((name) => Boolean(environment[name]));
}

const globalAgentObservability = globalThis as typeof globalThis & {
  __mfDashboardAgentObservability?: Promise<ReturnType<typeof createAgento11yVercelAiSdk> | null>;
};

async function initializeAgentObservability() {
  if (process.env.NODE_ENV === "test" || !isAgentObservabilityConfigured()) return null;

  const otel = new NodeSDK({
    serviceName: "mf-dashboard",
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30_000,
    }),
  });
  await otel.start();

  const client = new Agento11yClient({ contentCapture: "metadata_only" });
  const instrumentation = createAgento11yVercelAiSdk(client, {
    agentName: "mf-dashboard",
    agentVersion: process.env.APP_VERSION || process.env.GIT_SHA || "1.0.0",
    captureInputs: false,
    captureOutputs: false,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= client.shutdown().then(() => otel.shutdown());
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  return instrumentation;
}

export function getAgentObservabilityInstrumentation() {
  if (process.env.NODE_ENV === "test" || !isAgentObservabilityConfigured()) {
    return Promise.resolve(null);
  }

  globalAgentObservability.__mfDashboardAgentObservability ??= initializeAgentObservability();
  return globalAgentObservability.__mfDashboardAgentObservability;
}
