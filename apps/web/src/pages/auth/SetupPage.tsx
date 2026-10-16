import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Loading, Notice } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { api, errorMessage, setCsrfToken } from '../../lib/api';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

/** First-run setup (the very first account) and open sign-up when enabled. */
export default function SetupPage() {
  useDocumentTitle('Create your workspace');
  const { session } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api.auth.setup() });
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (session) return <Navigate to="/" replace />;
  if (setup.isLoading) return <Loading />;
  if (setup.data && !setup.data.signupAllowed) {
    return (
      <AuthLayout title="Sign-up is closed" footer={<Link to="/login" className="font-medium text-accent-text hover:underline">Back to sign in</Link>}>
        <Notice>This Morrow installation only admits people by invitation. Ask a workspace admin to invite you.</Notice>
      </AuthLayout>
    );
  }
  const first = setup.data && !setup.data.hasUsers;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.signup({ ...form, timezone });
      setCsrfToken(res.session.csrfToken);
      qc.setQueryData(['session'], res.session);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={first ? 'Set up Morrow' : 'Create a workspace'}
      subtitle={first ? 'You are the first person here, so this account becomes the owner.' : 'A workspace holds your contacts, templates and automations.'}
      footer={first ? null : <>Already have an account? <Link to="/login" className="font-medium text-accent-text hover:underline">Sign in</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Your name">{(id) => <Input id={id} required autoComplete="name" value={form.name} onChange={set('name')} autoFocus />}</Field>
        <Field label="Work e-mail">{(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 10 characters. A passphrase works well.">
          {(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} />}
        </Field>
        <Field label="Workspace name" hint={`Usually your company. Time zone: ${timezone} (change it later in Settings).`}>
          {(id) => <Input id={id} required placeholder="Cyphen" value={form.workspaceName} onChange={set('workspaceName')} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}
