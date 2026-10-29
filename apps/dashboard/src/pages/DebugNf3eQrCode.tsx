import { useCallback, useRef, useState } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'
import { debugNf3eQrCode, type DebugNf3eQrCodeResponse } from '@/api/client'
import { DashboardLayout } from '@/components/layout'
import { Activity, FileText, Play, Search, Upload } from 'lucide-react'

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png']

type TraceLevel = 'info' | 'success' | 'warning' | 'error'

const LEVEL_COLORS: Record<TraceLevel, string> = {
  info: 'text-blue-700 bg-blue-50 border-blue-100',
  success: 'text-emerald-700 bg-emerald-50 border-emerald-100',
  warning: 'text-amber-700 bg-amber-50 border-amber-100',
  error: 'text-red-700 bg-red-50 border-red-100',
}

function levelColor(level: TraceLevel): string {
  return LEVEL_COLORS[level]
}

function TraceEvent({ event }: { readonly event: DebugNf3eQrCodeResponse['events'][number] }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-2 w-2 shrink-0 items-center justify-center rounded-full">
        <span className={cn('flex h-1.5 w-1.5 rounded-full', levelColor(event.level))} />
      </div>
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider">{event.code}</span>
          <Badge variant="outline" className="text-[10px]">
            {event.level}
          </Badge>
        </div>
        <p className="text-sm text-foreground">{event.message}</p>
        {event.details && (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer underline underline-offset-4 hover:text-foreground/70">
              Detalhes
            </summary>
            <pre className="mt-1 p-2 rounded bg-muted text-[10px] overflow-auto max-h-32">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

function ReferencePanel({ reference }: { readonly reference: DebugNf3eQrCodeResponse['reference'] }) {
  const statusColor = (status: string): string => {
    switch (status) {
      case 'found':
        return 'bg-emerald-50 text-emerald-700 border-emerald-100'
      case 'not_found':
        return 'bg-red-50 text-red-700 border-red-100'
      case 'unsupported':
        return 'bg-amber-50 text-amber-700 border-amber-100'
      case 'inconclusive':
        return 'bg-blue-50 text-blue-700 border-blue-100'
      default:
        return 'bg-muted text-muted-foreground border-muted'
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Referência fiscal extraída
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Status</p>
            <Badge variant="outline" className={statusColor(reference.status)}>
              {reference.status}
            </Badge>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Método</p>
            <span className="font-mono">{reference.method}</span>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Fonte</p>
            <span className="font-mono">{reference.source ?? '—'}</span>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Autorizador</p>
            <span className="font-mono">{reference.issuer ?? '—'}</span>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">UF</p>
            <span className="font-mono">{reference.uf ?? '—'}</span>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Document ID</p>
            <span className="font-mono">{reference.documentId ?? '—'}</span>
          </div>
        </div>
        {reference.url && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">URL do QR</p>
            <span className="font-mono text-[10px] break-all text-muted-foreground">{reference.url}</span>
          </div>
        )}
        {reference.limitations.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Limitações</p>
            <div className="flex flex-wrap gap-1">
              {reference.limitations.map((limitation) => (
                <Badge key={limitation} variant="outline" className="text-[10px]">
                  {limitation}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {reference.errorCodes.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Códigos de erro</p>
            <div className="flex flex-wrap gap-1">
              {reference.errorCodes.map((code) => (
                <Badge key={code} variant="destructive" className="text-[10px]">
                  {code}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {reference.fingerprint && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Fingerprint</p>
            <span className="font-mono text-[10px] truncate">{reference.fingerprint}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function DebugNf3eQrCodePage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [response, setResponse] = useState<DebugNf3eQrCodeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFile = useCallback((selectedFile: File | null) => {
    setFile(selectedFile)
    setError(null)
    setResponse(null)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setError(null)
    setResponse(null)
    try {
      const result = await debugNf3eQrCode(file)
      setResponse(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido ao processar o documento')
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const dropped = e.dataTransfer.files[0]
    if (dropped) handleFile(dropped)
  }

  const isAccepted = (f: File | null): boolean => f !== null && ACCEPTED_TYPES.includes(f.type)

  return (
    <DashboardLayout activePage="debug-nf3e-qrcode" onNavigate={onNavigate}>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">QRCode NF3e debugger</h1>
          <p className="text-sm text-muted-foreground">
            Envie um comprovante (PDF, JPEG ou PNG) e acompanhe cada passo da extração da referência fiscal
          </p>
        </div>

        <Card>
          <CardContent className="p-6">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed py-12 text-center transition-colors',
                isAccepted(file)
                  ? 'border-foreground/30 bg-muted/30 hover:border-foreground'
                  : 'border-border hover:border-foreground/30 hover:bg-muted/30',
              )}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? (
                <div className="mb-3 h-6 w-6">
                  <Spinner />
                </div>
              ) : (
                <Upload className="mb-3 h-8 w-8 text-muted-foreground/40" />
              )}
              <p className="text-sm font-medium text-foreground">
                {uploading ? 'Processando…' : 'Arraste um documento aqui'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isAccepted(file) ? file?.name : 'ou clique para selecionar (.pdf, .jpg, .png)'}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED_TYPES.join(',')}
                className="hidden"
                onChange={(e) => {
                  const selected = e.target.files?.[0] ?? null
                  handleFile(selected)
                }}
              />
              {!isAccepted(file) && file && (
                <p className="mt-2 text-sm text-red-500">
                  Tipo não suportado: {file.type}. Envie PDF, JPEG ou PNG.
                </p>
              )}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button disabled={uploading || !file || !isAccepted(file)} onClick={handleSubmit}>
                {uploading ? <Play className="mr-2 h-3 w-3" /> : 'Analisar documento'}
              </Button>
              {error && <span className="flex-1 text-sm text-red-500">{error}</span>}
            </div>
          </CardContent>
        </Card>

        {response && (
          <>
            <ReferencePanel reference={response.reference} />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-4 w-4" />
                  Trace de execução
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="border-t border-border max-h-[500px] overflow-auto">
                  {response.events.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <Search className="mb-2 h-6 w-6 opacity-50" />
                      <p>Nenhum evento registrado</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {response.events.map((event, index) => (
                        <div
                          key={index}
                          className="border-l-2 pl-4 py-2 border-l-transparent"
                          style={{
                            borderLeftColor:
                              event.level === 'error'
                                ? 'hsl(var(--destructive))'
                                : event.level === 'warning'
                                  ? 'hsl(var(--warning))'
                                  : event.level === 'success'
                                    ? 'hsl(var(--success))'
                                    : 'hsl(var(--primary))',
                          }}
                        >
                          <TraceEvent event={event} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
