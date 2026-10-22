/**
 * Local bge-m3 embeddings. The model is not bundled: first use downloads the
 * quantized ONNX weights into DSH_HOME/memory/models through the proxy, then
 * caches them. Import of transformers is lazy so the plugin still loads, and
 * search still works via FTS, when the weight download has not finished.
 *
 * Do not set a process-wide undici dispatcher here — dsh-network-proxy owns
 * that. Downloads go through env.fetch only, and only when the undici package
 * is installed. Otherwise global fetch is used (the proxy plugin may already
 * route it).
 */

export const MODEL_ID = 'Xenova/bge-m3'
export const MODEL_DTYPE = 'q8'

function proxyUrl() {
  return process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || 'http://127.0.0.1:7890'
}

export function createEmbedder(options = {}) {
  const cacheDir = options.cacheDir
  const modelId = options.modelId ?? MODEL_ID
  const dtype = options.dtype ?? MODEL_DTYPE
  const logger = options.logger ?? console
  let state = 'idle'
  let error
  let pipe
  let loading

  async function load() {
    if (state === 'ready') return
    if (loading) return loading
    state = 'loading'
    loading = (async () => {
      try {
        const transformers = await import('@huggingface/transformers')
        const { pipeline, env } = transformers
        if (cacheDir) env.cacheDir = cacheDir
        env.allowLocalModels = true
        try {
          const undici = await import('undici')
          const dispatcher = new undici.ProxyAgent(proxyUrl())
          env.fetch = (url, init) => undici.fetch(url, { ...init, dispatcher })
        } catch {
          logger.info?.('undici not installed; model download uses global fetch')
        }
        pipe = await pipeline('feature-extraction', modelId, { dtype })
        state = 'ready'
        error = undefined
        logger.info?.(`bge-m3 ready (${modelId}, ${dtype})`)
      } catch (cause) {
        state = 'error'
        error = cause
        logger.warn?.(`bge-m3 unavailable, search will use FTS only: ${cause?.message ?? cause}`)
        throw cause
      } finally {
        loading = undefined
      }
    })()
    return loading
  }

  return {
    modelId,
    status() {
      return { state, model: modelId, dtype, error: error ? String(error.message ?? error) : undefined }
    },
    /** Start loading and forget the rejection; callers inspect status(). */
    warmup() {
      load().catch(() => {})
    },
    load,
    async embed(texts) {
      await load()
      if (state !== 'ready' || !pipe) throw new Error(error?.message ?? 'embedder not ready')
      const vectors = []
      for (const text of texts) {
        const result = await pipe(String(text), { pooling: 'cls', normalize: true })
        vectors.push(Float32Array.from(result.data))
      }
      return vectors
    },
  }
}
