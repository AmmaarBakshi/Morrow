import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Notice } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { api, errorMessage, setCsrfToken } from '../../lib/api';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export default function LoginPage() {
  useDocumentTitle('Sign in');
  const { session } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api.auth.setup() });

  if (session) return <Navigate to={params.get('next') ?? '/'} replace />;
  if (setup.data && !setup.data.hasUsers) return <Navigate to="/setup" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.login({ email, password });
      setCsrfToken(res.session.csrfToken);
      qc.setQueryData(['session'], res.session);
      navigate(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Your relationships kept warm while you were away."
      footer={setup.data?.signupAllowed ? <>New here? <Link to="/setup" className="font-medium text-accent-text hover:underline">Create a workspace</Link></> : <>Need access? Ask a workspace admin for an invitation.</>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
