/**
 * Electrobun RPC types for PearTube desktop.
 *
 * Binary backend traffic stays on the WebSocket relay. Publisher root
 * authorization is the only typed JSON request surface because it must cross
 * from the renderer into the privileged Bun process.
 */
export type PublisherRootRecordType =
  | 'publisher.namespace'
  | 'publisher.writer-admission'
  | 'publisher.writer-revocation'
  | 'publisher.root-transition'

export type PublisherBeginIntentParams = {
  publisherId: string
  recordType: PublisherRootRecordType
  body: number[]
  displaySummaryJson?: string | null
  intentExpiresAt: number
  issuedAt?: number | null
  expiresAt?: number | null
  expiresInMs?: number | null
  userInitiated: true
}

export type PublisherBeginIntentResponse = {
  intentId: string
  signerPublicKey: number[]
}

export type PublisherPreparedRecord = {
  intentId: string
  success: boolean
  publisherId: string
  recordType: PublisherRootRecordType
  unsignedBytes: number[]
  candidateRecordId: number[]
  signerPublicKey: number[]
  intentExpiresAt: number
  bodyLength: number
  issuedAt: number
  expiresAt: number
  displaySummaryJson?: string | null
  error?: string | null
}

export type PublisherSignedRecord = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  unsignedBytes: number[]
  candidateRecordId: number[]
  displaySummaryJson?: string | null
  signer: number[]
  signerPublicKey: number[]
  signature: number[]
  allowedSigners?: number[][] | null
}

export type PublisherCreateRootResponse = {
  publisherId: string
  publicKey: number[]
}

export type PublisherSignerRequestHandlers = {
  publisherCreateRoot(params: Record<string, never>): Promise<PublisherCreateRootResponse>
  publisherBeginUserIntent(params: PublisherBeginIntentParams): Promise<PublisherBeginIntentResponse>
  publisherSignPreparedRecord(params: {
    intentId: string
    prepared: PublisherPreparedRecord
  }): Promise<PublisherSignedRecord>
  publisherCompleteIntent(params: { intentId: string }): Promise<{ ok: true }>
  publisherCancelIntent(params: { intentId: string }): Promise<{ ok: true }>
}

export type PearTubeRPC = {
  // Handled by Bun (renderer calls these)
  bun: {
    requests: {
      startWorker: { params: { specifier: string }; response: { ok: boolean } }
      viewReady: { params: Record<string, never>; response: { blobServerPort: number | null } }
      publisherCreateRoot: {
        params: Record<string, never>
        response: PublisherCreateRootResponse
      }
      publisherBeginUserIntent: {
        params: PublisherBeginIntentParams
        response: PublisherBeginIntentResponse
      }
      publisherSignPreparedRecord: {
        params: { intentId: string; prepared: PublisherPreparedRecord }
        response: PublisherSignedRecord
      }
      publisherCompleteIntent: {
        params: { intentId: string }
        response: { ok: true }
      }
      publisherCancelIntent: {
        params: { intentId: string }
        response: { ok: true }
      }
    }
    messages: {
      workerWrite: { specifier: string; data: number[] }
    }
  }
  // Handled by Renderer (Bun calls these)
  webview: {
    requests: Record<string, never>
    messages: {
      onWorkerIPC: { specifier: string; data: number[] }
      onWorkerStdout: { specifier: string; data: string }
      onWorkerStderr: { specifier: string; data: string }
      onWorkerExit: { specifier: string; code: number }
    }
  }
}
