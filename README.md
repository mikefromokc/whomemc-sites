# whomemc-sites

Cloudflare Workers behind tech.whomemc.com and deals.whomemc.com. Each folder is one single-file Worker.

- `tech/` – Apple Tech News (RSS reader, 7-day history in KV, hourly cron)
- `deals/` – Deals (Slickdeals, DealNews and more), with likes, hides, a watchlist and a "For you" tab

Both sites are public (no login). Picks on the deals site are saved in the visitor's browser. If Cloudflare Access is ever put in front of
deals.whomemc.com, the picks also sync to the signed-in person's account (KV namespace `PREFS`) automatically.

Deploys run automatically from Cloudflare Workers Builds on every push to `main`. Each Worker's build root directory is `tech` or `deals`,
and the deploy command is `npx wrangler deploy --keep-vars`.
