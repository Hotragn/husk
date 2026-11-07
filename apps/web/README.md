# huskai.dev

The marketing site, served at https://www.huskai.dev. huskai.dev redirects there.

```bash
npm ci
npm run dev      # http://localhost:3000
npm run build    # static export to out/
```

Hosted on Cloudflare as static files: `wrangler.jsonc` names the Worker and its
domain, and `public/_headers` sets the security headers. `npx wrangler deploy`
after a build publishes `out/`. A production build names https://www.huskai.dev in every
canonical URL; set `NEXT_PUBLIC_SITE_URL` to build for another host.
