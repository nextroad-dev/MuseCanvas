import { initializeObservability } from '@musecanvas/observability';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  await initializeObservability(
    'musecanvas-api',
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
}
