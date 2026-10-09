# docs.huskai.dev

The documentation site, served at https://docs.huskai.dev. Pages are MDX in `content/`.

```bash
npm ci
npm run dev      # http://localhost:3001
npm run build    # static export to out/
```

Hosted on Cloudflare as static files: `wrangler.jsonc` names the Worker and its
domain, and `public/_headers` sets the security headers. `npx wrangler deploy`
after a build publishes `out/`. A production build names https://docs.huskai.dev in every
canonical URL; set `NEXT_PUBLIC_SITE_URL` to build for another host.
