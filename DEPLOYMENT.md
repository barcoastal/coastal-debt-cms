# Deployment Guide - Coastal Debt CMS

## Quick Deploy to Railway + Cloudflare

### Step 1: Push to GitHub

```bash
cd coastal-debt-cms
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/coastal-debt-cms.git
git push -u origin main
```

### Step 2: Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click **"Start a New Project"**
3. Select **"Deploy from GitHub repo"**
4. Authorize GitHub and select `coastal-debt-cms`
5. Railway will auto-detect and deploy

### Step 3: Add Environment Variables in Railway

Go to your project → **Variables** tab → Add:

```
ENCRYPTION_KEY=generate-a-random-32-character-string
GOOGLE_ADS_CLIENT_ID=your-google-client-id
GOOGLE_ADS_CLIENT_SECRET=your-google-client-secret
GOOGLE_ADS_REDIRECT_URI=https://YOUR-APP.railway.app/api/google-ads/callback
BASE_URL=https://YOUR-APP.railway.app
```

### Step 4: Get Your Railway URL

1. Go to **Settings** → **Domains**
2. Click **"Generate Domain"** to get a `.railway.app` URL
3. Or add your custom domain

### Step 5: Setup Cloudflare (for speed)

1. Go to [cloudflare.com](https://cloudflare.com) → Add site
2. Enter your domain (e.g., `coastaldebt.com`)
3. Select **Free** plan
4. Update nameservers at your domain registrar

### Step 6: Cloudflare DNS Settings

Add these DNS records:

| Type  | Name | Content                    | Proxy |
|-------|------|----------------------------|-------|
| CNAME | @    | your-app.railway.app       | ✅ On |
| CNAME | www  | your-app.railway.app       | ✅ On |

### Step 7: Cloudflare Cache Rules (Important!)

Go to **Rules** → **Page Rules** → Create:

**Rule 1: Cache Landing Pages**
- URL: `yourdomain.com/lp/*`
- Settings:
  - Cache Level: **Cache Everything**
  - Edge Cache TTL: **1 day**
  - Browser Cache TTL: **1 hour**

**Rule 2: Bypass Cache for Admin/API**
- URL: `yourdomain.com/admin/*`
- Settings:
  - Cache Level: **Bypass**

- URL: `yourdomain.com/api/*`
- Settings:
  - Cache Level: **Bypass**

### Step 8: Cloudflare SSL Settings

Go to **SSL/TLS**:
- Mode: **Full (strict)**
- Always Use HTTPS: **On**
- Auto Minify: **HTML, CSS, JS** ✅

---

## Performance Results

With this setup:
- Landing pages load in **~20-50ms** (served from Cloudflare edge)
- Global CDN with **300+ locations**
- Automatic **Gzip compression** (~70% smaller files)
- **DDoS protection** included
- **Free SSL** certificate

---

## Purge Cache After Updates

When you update a landing page, purge the Cloudflare cache:

**Option 1: Cloudflare Dashboard**
- Go to **Caching** → **Configuration** → **Purge Everything**

**Option 2: API (automate this)**
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

---

## Environment Variables Reference

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (Railway sets this automatically) |
| `ENCRYPTION_KEY` | 32-char string for encrypting tokens |
| `GOOGLE_ADS_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_ADS_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_ADS_REDIRECT_URI` | Your callback URL |
| `BASE_URL` | Your app's public URL |

---

## Troubleshooting

**Landing pages not caching?**
- Check Cloudflare Page Rules are active
- Verify proxy (orange cloud) is enabled in DNS

**Database errors?**
- Railway persists the `/data` folder automatically
- For manual backup: download `data/cms.db`

**Google Ads not connecting?**
- Verify redirect URI matches exactly
- Check client ID/secret are correct
