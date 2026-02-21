# SuperBased Provider Discovery (Draft)

Status: Draft
Last updated: 2026-02-21

## Purpose

Define how SuperBased providers can broadcast connection information and commercial terms over Nostr so users can quickly adopt a provider.

## Event Kind

Recommended: `kind: 30257` (addressable event)

Use `d` tag as provider profile identifier, for example:
- `d: provider.main`
- `d: provider.eu-west`

## Content Model

Event `content` should be JSON.

Example:

```json
{
  "name": "Acme SuperBased",
  "operator": "Acme Inc",
  "description": "Managed SuperBased service",
  "http": "https://superbased.acme.com",
  "relay": "wss://relay.acme.com",
  "server_npub": "npub1...",
  "pricing": {
    "currency": "USD",
    "record_storage": "0.10 per 10k records / month",
    "bandwidth": "included up to 5 GB"
  },
  "rate_limits": {
    "sync_per_minute": 240,
    "fetch_per_minute": 600,
    "max_payload_bytes": 1048576
  },
  "terms_url": "https://acme.com/superbased/terms",
  "status_url": "https://status.acme.com",
  "support": "support@acme.com"
}
```

Recommended tags:
- `d`: addressable profile id
- `t`: `superbased-provider`
- `t`: region tag(s), optional
- `r`: provider website or docs URL, optional

## Connection Key Format

Connection key is intentionally simple and unsigned:
- base64-encoded JSON payload
- metadata only, not an auth credential

Recommended payload shape:

```json
{
  "type": "superbased_connection",
  "version": 1,
  "server_npub": "npub1...",
  "http": "https://superbased.acme.com",
  "relay": "wss://relay.acme.com",
  "issued_at": 1700000000,
  "expires_at": 1702592000,
  "scopes": ["records:rw", "schemas:r"]
}
```

Important:
- Apps must still sign API calls with NIP-98.
- Connection keys are just importable endpoint metadata.

## UX Flow

1. User discovers provider event (`kind 30257`) in a client.
2. User clicks "Use this SuperBased".
3. App imports provider metadata into connection key format.
4. App stores selected connection key locally.
5. All requests continue to use user NIP-98 signing.
