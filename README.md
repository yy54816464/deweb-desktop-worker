# DeWEB Cloud Worker

Deployed:

```text
https://api.dewebdesk.link
```

## Bindings

- `CLOUD` KV namespace: `2b1ce8cb9f9a437c810f270e30a35461`
- Secret: `SESSION_SECRET`

## Endpoints

```text
POST /api/auth/nonce
POST /api/auth/verify
GET  /api/membership
GET  /api/profile
PUT  /api/profile
GET  /api/wallpaper?mode=desktop|mobile
PUT  /api/wallpaper?mode=desktop|mobile
GET  /api/health
```

## Auth

1. Client requests nonce.
2. Client signs the returned message with `personal_sign`.
3. Worker recovers address and checks BSC `expiryOf(address)`.
4. Worker issues HMAC session token (1 hour).

## Storage

- profile JSON in KV
- wallpaper binary in KV (8 MB limit; R2 not enabled on this account)
- membership cache in KV (5 minutes)

## Tested

- nonce
- signature recovery
- membership rejection for a non-member
- mock active membership login
- profile read/write
- wallpaper upload/download
- CORS for `https://app.dewebdesk.link`
- mock test data removed
