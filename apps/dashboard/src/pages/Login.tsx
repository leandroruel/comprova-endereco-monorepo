import { useMemo, useState } from 'react'
import { authClient } from '@/api/auth'
import { Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'
import { CheckCircle2, XCircle } from 'lucide-react'

interface PasswordCheck {
  readonly label: string
  readonly passed: boolean
}

const checkPassword = (pwd: string): readonly PasswordCheck[] => [
  { label: 'Mínimo 8 caracteres', passed: pwd.length >= 8 },
  { label: 'Uma letra maiúscula', passed: /[A-Z]/.test(pwd) },
  { label: 'Uma letra minúscula', passed: /[a-z]/.test(pwd) },
  { label: 'Um número', passed: /\d/.test(pwd) },
  { label: 'Um caractere especial', passed: /[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(pwd) },
]

function PasswordStrength({ password }: { password: string }) {
  const checks = useMemo(() => checkPassword(password), [password])
  const score = checks.filter((c) => c.passed).length
  const strength = score === 0 ? 0 : score <= 2 ? 1 : score <= 4 ? 2 : 5

  const barColor =
    strength === 0
      ? 'bg-muted'
      : strength === 1
        ? 'bg-red-500'
        : strength === 2
          ? 'bg-amber-500'
          : 'bg-emerald-500'
  const label = strength === 0 ? '—' : strength === 1 ? 'Fraca' : strength === 2 ? 'Média' : 'Forte'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all duration-300', barColor)}
            style={{ width: password.length === 0 ? 0 : `${(score / 5) * 100}%` }}
          />
        </div>
        <span
          className={cn(
            'text-[10px] font-medium',
            strength <= 1 && 'text-red-500',
            strength === 2 && 'text-amber-500',
            strength >= 3 && 'text-emerald-500',
          )}
        >
          {label}
        </span>
      </div>
      {password.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {checks.map((check) => (
            <div key={check.label} className="flex items-center gap-1.5 text-[10px]">
              {check.passed ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              )}
              <span className={check.passed ? 'text-foreground' : 'text-muted-foreground/60'}>
                {check.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const canSubmit = email.trim().length > 0 && password.length > 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = await authClient.signIn.email({ email, password })
      if (result.error) throw new Error(result.error.message ?? 'Login failed')
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm border-border/60 shadow-lg">
        <CardContent className="p-8">
          <div className="mb-8 text-center">
            <span className="text-2xl font-bold tracking-tight">comprova</span>
            <span className="ml-1 text-sm text-muted-foreground">.endereco</span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="password">
                Senha
              </label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

            <p className="text-[10px] text-muted-foreground text-center">
              Cadastro não disponível. Solicite acesso ao administrador.
            </p>

            <Button type="submit" className="w-full" disabled={loading || !canSubmit}>
              {loading ? <Spinner /> : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
