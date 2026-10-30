import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from '@/lib/og-card';
import { SITE_DESCRIPTION } from '@/lib/site';

export const alt = 'Husk documentation';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function DocsOpengraphImage() {
  return ogCard({
    title: 'Give your agent a computer.',
    lead: SITE_DESCRIPTION,
    note: 'Every claim on this site was checked against the source in the repository',
  });
}
