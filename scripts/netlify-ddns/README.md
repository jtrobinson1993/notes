# Netlify dynamic-DNS updater

Home servers usually have a **changing public IP**, which breaks a static DNS
record. This is a tiny updater that keeps a Netlify-managed DNS `A` record
pointed at the host's current public IPv4, so `notes.yourdomain.com` keeps
resolving to your box.

It only applies if your domain's DNS is hosted on **Netlify DNS** (you manage
the zone there). It's cheap to run every minute — it only calls the Netlify API
when your IP actually changes (it caches the last IP in a state file).

> **Heads-up:** Netlify's DNS API has no "update record" operation, so the script
> deletes the old `A` record and creates a new one. And a Netlify personal access
> token is account-wide (no DNS-only scope) — treat it as a sensitive secret.

## Files

| File | Goes to |
|------|---------|
| `netlify-ddns.sh` | `/usr/local/bin/netlify-ddns.sh` (mode 755) |
| `netlify-ddns.env.example` | `/etc/netlify-ddns.env` (mode 600 — edit it) |
| `netlify-ddns.service` | `/etc/systemd/system/netlify-ddns.service` |
| `netlify-ddns.timer` | `/etc/systemd/system/netlify-ddns.timer` |

## Install (on the server)

```sh
# 1. dependencies
sudo apt update && sudo apt install -y jq curl

# 2. script
sudo install -m 755 netlify-ddns.sh /usr/local/bin/netlify-ddns.sh

# 3. config + token (root-only). Edit NETLIFY_TOKEN, DOMAIN, RECORD first.
sudo install -m 600 netlify-ddns.env.example /etc/netlify-ddns.env
sudo nano /etc/netlify-ddns.env

# 4. systemd timer (runs every minute)
sudo install -m 644 netlify-ddns.service /etc/systemd/system/netlify-ddns.service
sudo install -m 644 netlify-ddns.timer   /etc/systemd/system/netlify-ddns.timer
sudo systemctl daemon-reload
sudo systemctl enable --now netlify-ddns.timer
```

Get the token at Netlify → avatar → **User settings → Applications → Personal
access tokens → New access token**.

## Verify

```sh
sudo systemctl start netlify-ddns.service                 # run once now
sudo journalctl -u netlify-ddns.service -n 20 --no-pager  # look for "updated …"
systemctl list-timers netlify-ddns.timer --no-pager       # next fire time
dig +short notes.yourdomain.com                           # should show your public IP
```

On the first run the script **creates** the record if it doesn't exist yet, so
you don't have to add it by hand in Netlify. After that, runs with no IP change
exit silently (no "updated" log line) — that's the normal idle state.

Prefer cron over systemd? Drop this in `/etc/cron.d/netlify-ddns`:

```cron
* * * * * root . /etc/netlify-ddns.env; /usr/local/bin/netlify-ddns.sh >> /var/log/netlify-ddns.log 2>&1
```
