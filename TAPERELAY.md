# TapeRelay storage backend

The Worker keeps cloud-sync control-plane metadata in D1. When a TapeRelay
developer key is configured, encrypted profile and wallpaper bytes are stored
as public TapeRelay objects; D1 stores only revisions, manifests, byte counts,
and pointers.

## Configuration

Set the key as a Cloudflare secret; never put it in `wrangler.toml` or source:

```bash
cd deweb-cloud-worker
npx wrangler secret put TAPERELAY_KEY
npx wrangler deploy
```

Relevant variables:

```text
TAPERELAY_KEY          TapeRelay developer key (secret)
TAPERELAY_WALLPAPER    0 = keep wallpaper on the legacy path; 1 = enable relay
```

If the secret is absent, the Worker keeps the legacy storage path.

## API shape

```text
POST /api/tape/register   authenticate, membership, quota, object allow-list
POST /api/tape/sign       remote upload/claim signing; no file body through Worker
POST /api/tape/finish     write profile/wallpaper pointer
GET  /api/tape/status     relay availability
GET  /api/tape/wallpaper  wallpaper manifest metadata
```

The Worker never receives plaintext profile or wallpaper content. The client
encrypts it end-to-end with AES-GCM before upload.

## Quota and safety

- Cloud storage quota: 25 MB per user across profile and wallpapers.
- Pending registrations expire; finish re-checks quota against actual bytes.
- Release old objects only after the new pointer is written.
- Keep the Worker's D1 write budget in place; it is a cost/abuse backstop, not a
  replacement for per-user rate limits.

## Notes

Large wallpaper uploads should be tested separately from profile uploads. Do
not put developer keys, user addresses, node details, or deployment-specific
test data in this document.
