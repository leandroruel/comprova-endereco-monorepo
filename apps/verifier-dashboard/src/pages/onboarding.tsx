import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createOrganization, completeOnboarding, getTermsVersion } from '@/api/client'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Input,
  Separator,
  Spinner,
} from '@/components/ui'
import {
  Mail,
  FileText,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  LayoutDashboard,
} from 'lucide-react'

interface OrganizationSummary {
  tenantId: string
  onboardingStatus: string
  termsVersion: string | null
  role: string | null
}

interface OnboardingPageProps {
  user: { id: string; email: string; name: string; role: string }
  organizations: OrganizationSummary[]
  activeOrgId: string | null
  onOrganizationCreated: (newOrg: {
    tenantId: string
    name: string
    onboardingStatus: string
    termsVersion: string | null
    role: string | null
  }) => void
  onComplete: () => void
}

export function OnboardingPage({
  user,
  organizations,
  activeOrgId,
  onOrganizationCreated,
  onComplete,
}: OnboardingPageProps) {
  const [step, setStep] = useState<'welcome' | 'create' | 'terms' | 'complete'>('welcome')
  const [name, setName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [document, setDocument] = useState('')
  const [termsVersion, setTermsVersion] = useState<string>('1.0.0')
  const [termsVersionError, setTermsVersionError] = useState<Error | null>(null)
  const [termsApproved, setTermsApproved] = useState<boolean>(false)
  const [termsDocumentHash, setTermsDocumentHash] = useState<string | null>(null)
  const [termsAccepted, setTermsAccepted] = useState(false)

  // A versão vigente dos termos de onboarding é definida exclusivamente pelo
  // servidor. Se a consulta falhar, os termos não estiverem aprovados ou não
  // houver documento oficial (hash ausente), o fluxo de aceite é bloqueado.
  // Não há fallback silencioso nem texto genérico apresentado como termo oficial.
  useEffect(() => {
    getTermsVersion()
      .then(({ version, approved, documentHash }) => {
        setTermsVersion(version)
        setTermsApproved(approved)
        setTermsDocumentHash(documentHash)
        setTermsVersionError(null)
      })
      .catch((err) => {
        setTermsVersionError(err instanceof Error ? err : new Error(String(err)))
      })
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const queryClient = useQueryClient()

  const createOrgMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: (newOrg) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onOrganizationCreated({
        tenantId: newOrg.tenantId,
        name: newOrg.name,
        onboardingStatus: newOrg.onboardingStatus,
        termsVersion: newOrg.termsVersion,
        role: newOrg.role,
      })
      setStep('terms')
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Erro ao criar organização')
    },
  })

  const completeMutation = useMutation({
    mutationFn: ({
      tenantId,
      tv,
      termsDocumentHash,
    }: {
      tenantId: string
      tv: string
      termsDocumentHash: string | null
    }) => completeOnboarding(tenantId, tv, termsDocumentHash),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onComplete()
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Erro ao concluir onboarding')
    },
  })

  const hasPendingOrg = organizations.some((o) => o.onboardingStatus === 'pending')
  const hasCompletedOrg = organizations.some((o) => o.onboardingStatus === 'completed')

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    // Não permite criar organização sem a versão vigente dos termos definida
    // pelo servidor (falha na consulta bloqueia o fluxo).
    if (termsVersionError) {
      setError('Não foi possível carregar a versão dos termos do servidor. Tente novamente.')
      setLoading(false)
      return
    }
    // Não permite criar organização sem termos jurídicos aprovados nem sem
    // documento oficial disponível.
    if (!termsApproved) {
      setError(
        'O conteúdo jurídico dos termos ainda não foi aprovado. A criação de organização está bloqueada até que os termos sejam aprovados.',
      )
      setLoading(false)
      return
    }
    if (!termsDocumentHash) {
      setError(
        'Não há documento oficial de termos disponível. A criação de organização está bloqueada até que o documento seja publicado.',
      )
      setLoading(false)
      return
    }
    try {
      await createOrgMutation.mutateAsync({
        name,
        legalName: legalName || undefined,
        document: document || undefined,
        termsVersion,
      })
    } finally {
      setLoading(false)
    }
  }

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    // Onboarding atua sobre a organização ativa selecionada, sem fallback
    // automático para a primeira da lista.
    const org = organizations.find((o) => o.tenantId === activeOrgId && o.onboardingStatus === 'pending')
    if (!org) {
      setError('Nenhuma organização pendente selecionada.')
      setLoading(false)
      return
    }
    try {
      await completeMutation.mutateAsync({
        tenantId: org.tenantId,
        tv: termsVersion,
        termsDocumentHash,
      })
    } finally {
      setLoading(false)
    }
  }

  if (!hasPendingOrg && !hasCompletedOrg && step === 'welcome') {
    return (
      <div className="max-w-2xl mx-auto">
        <Card className="animate-fade-in">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LayoutDashboard className="h-5 w-5" /> Bem-vindo ao Comprova Verifier
            </CardTitle>
            <CardDescription>
              Cadastre sua organização para começar a usar a infraestrutura de verificação de evidências do
              Comprova.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <Mail className="h-5 w-5 shrink-0 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium">E-mail responsável</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 shrink-0 text-primary mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Isolamento de dados</p>
                  <p className="text-xs text-muted-foreground">
                    Sua organização terá dados isolados de outras organizações
                  </p>
                </div>
              </div>
            </div>
            <Separator />
            <Button onClick={() => setStep('create')} className="w-full" disabled={loading}>
              {loading ? <Spinner className="mr-2" /> : <ArrowRight className="mr-2 h-4 w-4" />}
              Criar organização
            </Button>
          </CardContent>
        </Card>

        {error && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
      </div>
    )
  }

  if (step === 'create') {
    if (termsVersionError) {
      return (
        <div className="max-w-2xl mx-auto">
          <Card className="animate-fade-in">
            <CardContent className="text-center p-10">
              <AlertCircle className="h-8 w-8 text-amber-600 mb-3" />
              <h2 className="text-lg font-semibold">Erro ao carregar termos</h2>
              <p className="mt-2 text-sm text-muted-foreground">{termsVersionError.message}</p>
              <Button
                onClick={() => {
                  setTermsVersionError(null)
                  void getTermsVersion()
                    .then(({ version }) => {
                      setTermsVersion(version)
                      setTermsVersionError(null)
                    })
                    .catch((err) => {
                      setTermsVersionError(err instanceof Error ? err : new Error(String(err)))
                    })
                }}
                className="mt-4"
              >
                Tentar novamente
              </Button>
            </CardContent>
          </Card>
        </div>
      )
    }
    if (!termsApproved) {
      return (
        <div className="max-w-2xl mx-auto">
          <Card className="animate-fade-in">
            <CardContent className="text-center p-10">
              <AlertCircle className="h-8 w-8 text-amber-600 mb-3" />
              <h2 className="text-lg font-semibold">Termos não aprovados</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                O conteúdo jurídico dos termos de onboarding ainda não foi aprovado. A criação de organização
                está bloqueada até que os termos oficiais estejam disponíveis.
              </p>
            </CardContent>
          </Card>
        </div>
      )
    }
    if (!termsDocumentHash) {
      return (
        <div className="max-w-2xl mx-auto">
          <Card className="animate-fade-in">
            <CardContent className="text-center p-10">
              <AlertCircle className="h-8 w-8 text-amber-600 mb-3" />
              <h2 className="text-lg font-semibold">Documento oficial não disponível</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Não há um documento oficial de termos publicado. A criação de organização está bloqueada até
                que o documento jurídico esteja disponível.
              </p>
            </CardContent>
          </Card>
        </div>
      )
    }
    return (
      <div className="max-w-xl mx-auto">
        <Card className="animate-fade-in">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" /> Dados da organização
            </CardTitle>
            <CardDescription>
              Informe os dados da sua organização Verifier. O CPF/CNPJ é usado apenas como dado
              organizacional, nunca como identificador interno.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="name">
                    Nome da organização
                  </label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Banco Exemplo S.A."
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="legalName">
                    Nome legal (opcional)
                  </label>
                  <Input
                    id="legalName"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Ex: Banco Exemplo S.A."
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="document">
                    Documento (CPF/CNPJ sem máscara, opcional)
                  </label>
                  <Input
                    id="document"
                    value={document}
                    onChange={(e) => setDocument(e.target.value.replace(/\D/g, ''))}
                    placeholder="Ex: 12345678000199"
                    maxLength={20}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="termsVersion">
                    Versão dos termos (definida pelo servidor)
                  </label>
                  <Input id="termsVersion" value={termsVersion} readOnly placeholder="1.0.0" required />
                  <p className="text-xs text-muted-foreground">
                    A versão é definida pelo servidor e registrada no aceite; o conteúdo jurídico depende de
                    aprovação jurídica.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <Button type="button" variant="outline" onClick={() => setStep('welcome')}>
                  Voltar
                </Button>
                <Button type="submit" className="w-auto" disabled={loading || !name.trim()}>
                  {loading ? <Spinner className="mr-2" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                  Próximo
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {error && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
      </div>
    )
  }

  if (step === 'terms') {
    return (
      <div className="max-w-xl mx-auto">
        <Card className="animate-fade-in">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" /> Aceite dos termos
            </CardTitle>
            <CardDescription>
              Antes de concluir o onboarding, leia e aceite os termos e políticas aplicáveis à sua
              organização.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!termsApproved ? (
              <div className="border border-border rounded-lg p-4 bg-muted/50">
                <p className="text-xs text-muted-foreground mb-2">Termos de Uso — Versão {termsVersion}</p>
                <p className="text-sm text-foreground">
                  <strong>Conteúdo jurídico pendente de aprovação.</strong>
                  Este é um espaço reservado para os termos oficiais de onboarding da organização. O texto
                  exibido não é um documento jurídico oficial e não deve ser interpretado como tal.
                </p>
                <p className="text-sm text-muted-foreground">
                  A versão dos termos é definida exclusivamente pelo servidor. O aceite não pode ser
                  registrado enquanto o conteúdo jurídico não estiver aprovado.
                </p>
              </div>
            ) : !termsDocumentHash ? (
              <div className="border border-border rounded-lg p-4 bg-muted/50">
                <p className="text-xs text-muted-foreground mb-2">Termos de Uso — Versão {termsVersion}</p>
                <p className="text-sm text-foreground">
                  <strong>Documento oficial não disponível.</strong>
                  Os termos foram aprovados, mas o documento jurídico ainda não foi publicado. O aceite não
                  pode ser registrado sem um documento verificável.
                </p>
              </div>
            ) : (
              <div className="border border-border rounded-lg p-4 bg-muted/50">
                <p className="text-xs text-muted-foreground mb-2">Termos de Uso — Versão {termsVersion}</p>
                <p className="text-sm text-foreground">
                  O documento oficial dos termos está disponível sob o hash abaixo. O conteúdo do documento
                  não é exibido nesta interface; consulte o documento oficial antes de prosseguir com o
                  aceite.
                </p>
                <p className="text-xs font-mono text-muted-foreground">
                  Hash do documento: {termsDocumentHash}
                </p>
                <p className="text-xs text-muted-foreground">
                  O aceite só pode ser registrado após a leitura do documento oficial em outro canal.
                </p>
              </div>
            )}

            <div className="flex items-start gap-3">
              <input
                id="terms"
                type="checkbox"
                checked={termsAccepted && termsApproved && termsDocumentHash !== null}
                onChange={
                  termsApproved && termsDocumentHash ? (e) => setTermsAccepted(e.target.checked) : undefined
                }
                className="w-4 h-4 rounded border border-input bg-card text-primary focus:ring-0"
                disabled={!termsApproved || !termsDocumentHash}
              />
              <label htmlFor="terms" className="text-sm text-foreground cursor-pointer select-none">
                Li e concordo com os termos e políticas aplicáveis (versão{' '}
                <span className="font-medium">{termsVersion}</span>)
                {!termsApproved && ' — pendente de aprovação jurídica'}
                {!termsDocumentHash && ' — sem documento oficial'}
              </label>
            </div>

            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('create')}>
                Voltar
              </Button>
              <Button
                onClick={handleComplete}
                disabled={loading || !termsAccepted || !termsApproved || !termsDocumentHash}
                className="w-auto"
              >
                {loading ? <Spinner className="mr-2" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Concluir onboarding
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
      </div>
    )
  }

  if (step === 'complete') {
    return (
      <div className="max-w-2xl mx-auto text-center">
        <Card className="animate-fade-in">
          <CardContent className="p-10 text-center">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-100 text-emerald-600 mb-4">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-semibold">Onboarding concluído</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Sua organização está pronta. Você já pode gerenciar membros e integrações.
            </p>
            <div className="mt-8">
              <Button
                onClick={() => {
                  setStep('welcome')
                  onComplete()
                }}
              >
                <LayoutDashboard className="mr-2 h-4 w-4" />
                Ir para o painel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Se já tem org concluída, redireciona. Considera apenas a organização ativa.
  const pendingOrg = organizations.find((o) => o.tenantId === activeOrgId && o.onboardingStatus === 'pending')
  if (pendingOrg) {
    if (pendingOrg.role !== 'owner') {
      return (
        <div className="max-w-2xl mx-auto">
          <Card className="animate-fade-in">
            <CardContent className="text-center p-10">
              <ShieldCheck className="h-8 w-8 text-amber-600 mb-3" />
              <h2 className="text-lg font-semibold">Onboarding em andamento</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                O proprietário da organização ainda precisa concluir o aceite dos termos. Você será notificado
                quando estiver disponível.
              </p>
            </CardContent>
          </Card>
        </div>
      )
    }
    setStep('terms')
    return null
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Card className="animate-fade-in">
        <CardContent className="text-center p-10">
          <ShieldCheck className="h-8 w-8 text-emerald-600 mb-3" />
          <h2 className="text-lg font-semibold">Organização já configurada</h2>
          <p className="mt-2 text-sm text-muted-foreground">Sua organização já completou o onboarding.</p>
          <Button onClick={() => onComplete()} className="mt-4">
            Ir para o painel
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
