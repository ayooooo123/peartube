/**
 * Electrobun RPC types for PearTube desktop.
 *
 * Binary backend traffic stays on the WebSocket relay. The renderer may ask
 * Bun for one narrow lifecycle workflow and may relay public backend records,
 * but it never receives a root signer or chooses root-operation bytes.
 */
export type PublisherRootRecordType =
  | 'publisher.namespace'
  | 'publisher.writer-admission'
  | 'publisher.writer-revocation'
  | 'publisher.root-transition'

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

export type PublisherProvisionResponse = {
  success: boolean
  publisherId: string
  catalogBootstrapKey: number[]
  localWriterKey: number[]
  localSignerKey: number[]
  writable: boolean
  namespaceInitialized: boolean
  admitted: boolean
  errorCode?: string | null
  error?: string | null
}

export type PublisherSubmitResponse = {
  intentId: string
  success: boolean
  valid: boolean
  complete: boolean
  reason?: string | null
  publisherId: string
  recordType: PublisherRootRecordType
  recordId: number[]
  transitionId?: number[] | null
  signer: number[]
  signerPublicKey: number[]
  signature: number[]
  pendingSignatureCount?: number | null
  pendingExpiresAt?: number | null
}

export type PublisherLifecycleResponse = {
  status: 'ready'
  publisherId: string
  catalogBootstrapKey: number[]
  writable: true
  admitted: true
}

export type PublisherLifecycleRequestHandlers = {
  publisherEnsureLocalCatalog(params: {
    action: 'ensure-local-publisher'
  }): Promise<PublisherLifecycleResponse>
}

type PublisherPrepareRequest = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  signerPublicKey: number[]
  body: number[]
  displaySummaryJson: string
  intentExpiresAt: number
  issuedAt: number
  expiresInMs: number
}

export type PearTubeRPC = {
  // Handled by Bun (renderer calls these)
  bun: {
    requests: {
      startWorker: { params: { specifier: string }; response: { ok: boolean } }
      viewReady: { params: Record<string, never>; response: { blobServerPort: number | null } }
      publisherEnsureLocalCatalog: {
        params: { action: 'ensure-local-publisher' }
        response: PublisherLifecycleResponse
      }
    }
    messages: {
      workerWrite: { specifier: string; data: number[] }
    }
  }
  // Handled by Renderer (Bun calls these). These methods relay public HRPC
  // records only; Bun independently constructs and validates every root intent.
  webview: {
    requests: {
      publisherProvisionCatalog: {
        params: { publisherId: string; genesisRootKey: number[] }
        response: PublisherProvisionResponse
      }
      publisherPrepareRootOperation: {
        params: PublisherPrepareRequest
        response: PublisherPreparedRecord
      }
      publisherSubmitRootOperation: {
        params: PublisherSignedRecord
        response: PublisherSubmitResponse
      }
    }
    messages: {
      onWorkerIPC: { specifier: string; data: number[] }
      onWorkerStdout: { specifier: string; data: string }
      onWorkerStderr: { specifier: string; data: string }
      onWorkerExit: { specifier: string; code: number }
    }
  }
}
