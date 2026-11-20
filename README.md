# whomemc-sites

Cloudflare Workers behind tech.whomemc.com and deals.whomemc.com. Each folder is one single-file Worker.

- `tech/` – Apple Tech News (RSS reader, 7-day history in KV, hourly cron)
- `deals/` – Deals (Slickdeals, DealNews and more)

Both sit behind Cloudflare Access and email a sign-in alert (via Email Routing) when someone visits.

## Settings that live in Cloudflare, not in this repo
- Worker variables `ALERT_TO` (where alerts go) and `ME_EMAILS` (your own sign-in addresses, to label "you" vs "guest")
- Access policies, custom domains and the verified alert address in Email Routing

Deploy with `npx wrangler deploy --keep-vars` from inside a Worker's folder (this keeps the variables above).
Set each Worker's Build root directory to `tech` or `deals` and its deploy command to `npx wrangler deploy --keep-vars`.


Deploys run automatically from Cloudflare Workers Builds on every push to main (tech and deals Workers, connected Nov 19, 2026).
