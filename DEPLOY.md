# Deploy to Render

## Render settings

- Service type: Web Service, runtime Docker, Dockerfile path `./Dockerfile` (`render.yaml` sets this up)
- Health check path: `/api/public/health`
- Port: Render sets `PORT`; the container listens on 10000 by default

## Environment variables to set in Render

| Name | Value | Notes |
|---|---|---|
| `API_KEYS` | one or more keys, comma-separated | each key 16+ characters; generate with a password manager |
| `UI_PASSWORD` | the password for the homepage | 12+ characters |
| `SESSION_SECRET` | a random string | 32+ characters; keep it private |
| `CORS_ORIGINS` | your allowed website origins, comma-separated | optional |
| `FETCH_MODE` | `http` | leave as `http`; `browser` is optional and low-volume |
| `ENABLE_DEBUG_ENDPOINT` | `false` | keep false in production |

The service refuses to start in production if `API_KEYS`, `UI_PASSWORD` or `SESSION_SECRET` is missing or too short. Render shows the reason in its logs.

## Build and start

- Render uses the Dockerfile. There is no separate build or start command.
- The image builds the app with `NITRO_PRESET=node-server` and starts with `node scripts/start.mjs`.

## Local Docker commands (run on a machine with Docker)

```bash
docker build -t flipkart-product-api .
docker run --rm -p 10000:10000 \
  -e API_KEYS="replace-with-a-key-of-16-plus-chars" \
  -e UI_PASSWORD="replace-with-12-plus-chars" \
  -e SESSION_SECRET="replace-with-a-random-string-of-32-plus-chars" \
  flipkart-product-api
```

## Check the deployment

```bash
curl -s https://YOUR-SERVICE.onrender.com/api/public/health
curl -s https://YOUR-SERVICE.onrender.com/api/public/ready
curl -s -H "X-API-Key: YOUR_KEY" --get \
  --data-urlencode "url=https://www.flipkart.com/PRODUCT/p/ITMID" \
  https://YOUR-SERVICE.onrender.com/api/public/product
```

- `health` returns 200 and never contacts Flipkart.
- `ready` returns 200 when keys are configured.
- `product` returns 401 without a key. Do not put the key in the URL; it is rejected.

## Local run without Docker

```bash
NITRO_PRESET=node-server npm run build
NODE_ENV=production PORT=10000 API_KEYS=... UI_PASSWORD=... SESSION_SECRET=... node scripts/start.mjs
```

Verified in this sandbox. The Docker image itself has not been built here.
