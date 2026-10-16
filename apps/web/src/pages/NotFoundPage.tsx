import { Compass } from 'lucide-react';
import { ButtonLink } from '../components/ui/button';
import { EmptyState } from '../components/ui/display';
import { useDocumentTitle } from '../lib/hooks';

export default function NotFoundPage() {
  useDocumentTitle('Not found');
  return <EmptyState icon={<Compass className="size-5" />} title="This page does not exist" description="The link may be old, or the item was archived." action={<ButtonLink to="/">Back to overview</ButtonLink>} />;
}
