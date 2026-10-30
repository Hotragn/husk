import type { MetadataRoute } from 'next';

import { allDocs } from '@/lib/content';
import { SITE_URL } from '@/lib/site-url';

/**
 * Every page, derived from the MDX on disk rather than listed here.
 *
 * `apps/web` hardcodes its three routes because it has three. This site has
 * forty-odd and gains one whenever someone adds a file, so a hand-written list
 * is a list that is already wrong.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'weekly' as const, priority: 1 },
    ...allDocs().map((doc) => ({
      url: `${SITE_URL}${doc.href}`,
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
