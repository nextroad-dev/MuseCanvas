import { context, propagation, trace, SpanStatusCode, type Span } from '@opentelemetry/api'

type ObservabilitySdk = import('@opentelemetry/sdk-trace').TracerProvider

let sdk: ObservabilitySdk | undefined
let initialized = false
let initializing: Promise<boolean> | undefined
let shutdownHookInstalled = false

const tracer = trace.getTracer('@musecanvas/observability')
const SAFE_WARNING = 'Observability initialization unavailable; continuing without telemetry.'

export function normalizeOtlpTraceEndpoint(endpoint: string): string | undefined {
  try {
    const parsed = new URL(endpoint)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash
    ) return undefined

    const path = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = path.endsWith('/v1/traces') ? path : `${path}/v1/traces`
    return parsed.toString()
  } catch {
    return undefined
  }
}

export async function initializeObservability(serviceName: string, endpoint?: string): Promise<boolean> {
  if (initialized) return true
  if (initializing) return initializing

  const configuredEndpoint = endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!configuredEndpoint) return false

  const normalizedEndpoint = normalizeOtlpTraceEndpoint(configuredEndpoint)
  if (!normalizedEndpoint) {
    console.warn(SAFE_WARNING)
    return false
  }

  initializing = (async () => {
    try {
      const [
        { TracerProvider, BatchSpanProcessor },
        { OTLPTraceExporter },
        { resourceFromAttributes },
        { AsyncLocalStorageContextManager },
        { W3CTraceContextPropagator },
      ] = await Promise.all([
        import('@opentelemetry/sdk-trace'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/context-async-hooks'),
        import('@opentelemetry/core'),
      ])
      const candidate = new TracerProvider({
        resource: resourceFromAttributes({ 'service.name': serviceName }),
        spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: normalizedEndpoint }) })],
      })
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
      propagation.setGlobalPropagator(new W3CTraceContextPropagator())
      trace.setGlobalTracerProvider(candidate)
      sdk = candidate
      initialized = true
      if (!shutdownHookInstalled) {
        process.once('beforeExit', () => { void shutdownObservability() })
        shutdownHookInstalled = true
      }
      return true
    } catch {
      console.warn(SAFE_WARNING)
      return false
    } finally {
      initializing = undefined
    }
  })()
  return initializing
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  run: () => Promise<T>,
): Promise<T> {
  if (!initialized) return run()

  return tracer.startActiveSpan(name, async (span: Span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value)
      return await run()
    } catch (error) {
      span.setAttribute('error.type', error instanceof Error ? error.constructor.name : typeof error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })
}

export async function shutdownObservability(): Promise<void> {
  if (!sdk) return
  const activeSdk = sdk
  sdk = undefined
  initialized = false
  try {
    await activeSdk.shutdown()
  } catch {
    console.warn(SAFE_WARNING)
  }
}
