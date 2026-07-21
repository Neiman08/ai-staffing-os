import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Lock, Mail, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { mockLogin } from "@/lib/mock-auth";

/**
 * TEMPORAL -- ver mock-auth.ts. Pantalla de login real (no un redirect
 * directo) para poder probar la app con una cuenta de prueba mientras
 * el sistema de auth definitivo no está integrado.
 */
export default function MockLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    // F14: sin llamada de red real -- la validación es puramente local
    // contra la única cuenta de prueba (ver mock-auth.ts). Un pequeño
    // delay artificial evita que el submit se sienta instantáneo/falso.
    setTimeout(() => {
      const ok = mockLogin(email, password);
      if (!ok) {
        setError("Invalid email or password.");
        setSubmitting(false);
        return;
      }
      const redirectTo = (location.state as { from?: string } | null)?.from ?? "/";
      navigate(redirectTo, { replace: true });
    }, 300);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <img src="/logo-full.png" alt="DreiStaff" className="h-20 w-auto sm:h-24" />
          <p className="text-xs font-medium tracking-wide text-muted-foreground">AI Staffing OS</p>
        </div>

        <Card>
          <CardContent className="pt-6">
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">Use your account to access the platform.</p>

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="pl-9"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    onClick={() => setError("Password reset isn't available yet — contact your administrator.")}
                    className="mb-1 text-xs font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-9"
                  />
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={submitting} className="mt-2 w-full">
                {submitting ? "Signing in…" : "Login"} <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">Temporary authentication — for internal testing only.</p>
      </div>
    </div>
  );
}
