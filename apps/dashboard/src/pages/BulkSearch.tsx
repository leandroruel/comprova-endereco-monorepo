import { useCallback, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DashboardLayout } from '@/components/layout'
import { Badge, Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'
import { CheckCircle2, Download, FileText, Upload, XCircle } from 'lucide-react'

const API_BASE = 'http://localhost:3000'
const API_KEY = 'cvk_-oHrqOQw3f50608XbFVB74C-OwyVSDTM'

interface BatchItem {
  position: number
  doc_type: string
  status: string
  verdict: string | null
  confidence: number | null
  explanation: string | null
  error_code: string | null
}

interface Batch {
  batch_id: string
  status: string
  total_items: number
  completed: number
  failed: number
  created_at: string
}

async function createBatch(documents: Array<{ type: 'CPF' | 'CNPJ'; value: string }>) {
  const res = await fetch(`${API_BASE}/v1/batches`, {
    method: 'POST',
    credentials: 'include',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents, mode: 'fast', legal_basis: 'FRAUD_PREVENTION' }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function listBatches(): Promise<{ batches: Batch[] }> {
  const res = await fetch(`${API_BASE}/v1/batches`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) return { batches: [] }
  return res.json()
}

async function getBatchItems(id: string): Promise<BatchItem[]> {
  const res = await fetch(`${API_BASE}/v1/batches/${id}`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) return []
  const data = await res.json()
  return data.items
}

function parseDocuments(text: string): Array<{ type: 'CPF' | 'CNPJ'; value: string }> {
  return text
    .split(/[\n,;]+/)
    .map((line) => line.trim().replace(/\D+/g, ''))
    .filter((digits) => digits.length === 11 || digits.length === 14)
    .map((digits) => ({
      type: digits.length === 11 ? ('CPF' as const) : ('CNPJ' as const),
      value: digits,
    }))
}

function exportBatch(id: string, format: 'csv' | 'json') {
  window.open(`${API_BASE}/v1/batches/${id}/export?format=${format}`, '_blank')
}

export function BulkSearchPage() {
  const [rawText, setRawText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const batches = useQuery({
    queryKey: ['batches'],
    queryFn: listBatches,
    refetchInterval: 3_000,
  })

  const mutation = useMutation({
    mutationFn: (docs: Array<{ type: 'CPF' | 'CNPJ'; value: string }>) => createBatch(docs),
    onSuccess: () => {
      setRawText('')
      void queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
  })

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true)
      setUploadError(null)
      try {
        const text = await file.text()
        const docs = parseDocuments(text)
        if (docs.length === 0) {
          setUploadError('Nenhum CNPJ/CPF válido encontrado no arquivo')
        } else {
          mutation.mutate(docs)
        }
      } catch {
        setUploadError('Erro ao ler o arquivo')
      } finally {
        setUploading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [mutation],
  )

  const handleTextareaSubmit = () => {
    const docs = parseDocuments(rawText)
    if (docs.length > 0) mutation.mutate(docs)
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Busca em lote</h1>
          <p className="text-sm text-muted-foreground">
            Envie múltiplos CNPJs/CPFs via CSV ou colagem — processamento em background
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const file = e.dataTransfer.files[0]
                  if (file) void handleFile(file)
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-12 text-center transition-colors hover:border-foreground/30 hover:bg-muted/30"
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? <Spinner /> : <Upload className="mb-3 h-8 w-8 text-muted-foreground/40" />}
                <p className="text-sm font-medium text-foreground">Arraste um arquivo CSV aqui</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  ou clique para selecionar (.csv, .txt — um CNPJ/CPF por linha)
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void handleFile(file)
                  }}
                />
              </div>
              {uploadError && <p className="mt-2 text-sm text-red-500">{uploadError}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <label className="mb-2 block text-xs font-medium text-muted-foreground">
                Ou cole os documentos (um por linha)
              </label>
              <textarea
                className="h-36 w-full rounded-lg border border-input bg-card p-3 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={'33986733000104\n52998224725\n11222333000181'}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
              />
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {parseDocuments(rawText).length} documento(s) válido(s)
                </span>
                <Button
                  size="sm"
                  disabled={mutation.isPending || parseDocuments(rawText).length === 0}
                  onClick={handleTextareaSubmit}
                >
                  {mutation.isPending ? <Spinner /> : 'Processar'}
                </Button>
              </div>
              {mutation.isError && (
                <p className="mt-2 text-sm text-red-500">
                  {mutation.error instanceof Error ? mutation.error.message : 'Erro'}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Lotes recentes</h2>
          {batches.isPending ? (
            <Card>
              <CardContent className="flex justify-center p-8">
                <Spinner />
              </CardContent>
            </Card>
          ) : batches.data?.batches.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-8 text-center">
                <FileText className="mb-2 h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">Nenhum lote ainda</p>
              </CardContent>
            </Card>
          ) : (
            batches.data?.batches.map((batch) => <BatchRow key={batch.batch_id} batch={batch} />)
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

function BatchRow({ batch }: { batch: Batch }) {
  const [expanded, setExpanded] = useState(false)
  const items = useQuery({
    queryKey: ['batch-items', batch.batch_id],
    queryFn: () => getBatchItems(batch.batch_id),
    enabled: expanded,
  })

  const progress =
    batch.total_items > 0 ? Math.round(((batch.completed + batch.failed) / batch.total_items) * 100) : 0

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{batch.batch_id.slice(0, 8)}…</span>
                <Badge
                  variant={
                    batch.status === 'completed'
                      ? 'success'
                      : batch.status === 'queued'
                        ? 'secondary'
                        : 'warning'
                  }
                >
                  {batch.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {batch.completed}/{batch.total_items} ok
                  {batch.failed > 0 && `, ${batch.failed} falhas`}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    batch.failed > 0 ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Ocultar' : 'Detalhes'}
            </Button>
            {batch.status === 'completed' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => exportBatch(batch.batch_id, 'csv')}>
                  <Download className="mr-1 h-3 w-3" /> CSV
                </Button>
                <Button size="sm" variant="ghost" onClick={() => exportBatch(batch.batch_id, 'json')}>
                  <Download className="mr-1 h-3 w-3" /> JSON
                </Button>
              </>
            )}
          </div>
        </div>

        {expanded && (
          <div className="mt-4 max-h-64 overflow-auto rounded-lg border border-border">
            {items.isPending ? (
              <div className="flex justify-center p-4">
                <Spinner />
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/50">
                  <tr className="text-left text-muted-foreground">
                    <th className="p-2 font-medium">#</th>
                    <th className="p-2 font-medium">Tipo</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2 font-medium">Veredito</th>
                    <th className="p-2 font-medium">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {(items.data ?? []).map((item) => (
                    <tr key={item.position} className="border-b border-border/40 last:border-0">
                      <td className="p-2 font-mono">{item.position + 1}</td>
                      <td className="p-2">{item.doc_type}</td>
                      <td className="p-2">
                        {item.status === 'completed' ? (
                          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        ) : item.status === 'failed' ? (
                          <XCircle className="h-3 w-3 text-red-500" />
                        ) : (
                          <Spinner />
                        )}
                      </td>
                      <td className="p-2">
                        {item.verdict && (
                          <Badge
                            variant={
                              item.verdict === 'CONFIRMED_COMMERCIAL'
                                ? 'success'
                                : item.verdict === 'NOT_FOUND' || item.verdict === 'INCONSISTENT'
                                  ? 'destructive'
                                  : 'secondary'
                            }
                          >
                            {item.verdict.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                        )}
                      </td>
                      <td className="p-2 font-mono">
                        {item.confidence !== null ? `${(item.confidence * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
