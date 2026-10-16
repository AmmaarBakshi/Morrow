import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Loading, Notice } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { api, errorMessage, setCsrfToken } from '../../lib/api';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export default function InvitePage() {
  useDocumentTitle('Join workspace');
  const { token = '' } = useParams();
  const { session } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.auth.invitation(token), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (invite.isLoading) return <Loading />;
  if (invite.isError || !invite.data) {
    return (
      <AuthLayout title="Invitation not valid" footer={<Link to="/login" className="font-medium text-accent-text hover:underline">Go to sign in</Link>}>
        <Notice tone="warn">{errorMessage(invite.error) || 'This invitation is invalid or has expired. Ask for a new one.'}</Notice>
      </AuthLayout>
    );
  }
  const inv = invite.data;
  const needsAccount = !session && !inv.userExists;
  const wrongAccount = session && session.user.email !== inv.email;

  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.acceptInvitation(token, needsAccount ? { name, password } : {});
      setCsrfToken(res.session.csrfToken);
      qc.clear();
      qc.setQueryData(['session'], res.session);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={`Join ${inv.workspaceName}`} subtitle={<>You were invited as <strong>{inv.role}</strong> ({inv.email}).</>}>
      {error ? (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}
      {wrongAccount ? (
        <Notice tone="warn">You are signed in as {session.user.email}. Sign out and sign in as {inv.email} to accept.</Notice>
      ) : session ? (
        <Button variant="primary" className="w-full" loading={busy} onClick={() => accept()}>
          Accept invitation
        </Button>
      ) : inv.userExists ? (
        <Notice>
          You already have an account. <Link to={`/login?next=/invite/${encodeURIComponent(token)}`} className="font-medium underline">Sign in</Link> to accept.
        </Notice>
      ) : (
        <form onSubmit={accept} className="flex flex-col gap-4">
          <Field label="Your name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label="Choose a password" hint="At least 10 characters.">
            {(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Create account and join
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
