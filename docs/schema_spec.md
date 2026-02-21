# SuperBased Schema and Collection Spec (Draft)

Status: Draft
Last updated: 2026-02-21

## 1. Goals

This spec defines how SuperBased models application data schemas without strict backend enforcement.

Design goals:
- Keep storage flexible: encrypted payloads remain opaque to the server.
- Make data understandable across apps through signed schema guides.
- Allow fast schema evolution without breaking old clients.
- Support both app-specific data and shared cross-app data.
- Allow storing native Nostr events alongside custom app data.

## 2. Core Concepts

### 2.1 Schema ID (immutable)

A `schema_id` is a stable identifier for one schema definition snapshot.

Rules:
- `schema_id` meaning is immutable once published.
- If structure changes materially, publish a new `schema_id`.
- No server-side strict validation is required.

Examples:
- `todo13346`
- `doc3787489`

### 2.2 Collection Definition Event

A Collection Definition is a signed Nostr event that documents a schema.
Recommended kind: `30256` (or another addressable app-defined kind if changed later).

A definition event should include:
- `schema_id`
- `name` (human-readable, e.g. `tasks`, `docs`)
- `description`
- `fields` (guide-level shape)
- `examples` (optional)
- `compat` notes (optional)

Important:
- Definition events are guidance for clients.
- SuperBased does not enforce payload conformance.

### 2.3 Schema Alias / Supersedes Event

When evolving a schema:
- Do not mutate old `schema_id` meaning.
- Publish a new `schema_id` and optionally a mapping event indicating replacement.

Example mapping:
- `todo13346` superseded by `todo411256`

This allows:
- old apps to keep reading old data
- new apps to follow latest recommendations
- gradual migrations

### 2.4 App Profile (grouping/discovery)

`app_npub` remains useful as a grouping mechanism.

An app profile event (published by app key) may list:
- schemas used by the app
- optional aliases like `tasks`, `docs`, `notes`
- whether the app is a skin/client for an existing schema set

This keeps app-level UX discoverability without forcing app keys to be the namespace boundary.

## 3. Data Model in SuperBased

### 3.1 Record metadata

Each stored record SHOULD include:
- `collection` (logical bucket name, e.g. `tasks`)
- `schema_id` (immutable schema definition ID)
- `schema_version_hint` (optional, client-managed)

Notes:
- `collection` is for simple grouping/filtering.
- `schema_id` is the true semantic contract pointer.
- `schema_version_hint` is informational only.

### 3.2 Strictness

SuperBased treats payloads as encrypted blobs and cannot enforce schema correctness.

Therefore:
- Schema definitions are advisory contracts between clients.
- Validation, migration, and tolerance are client responsibilities.

## 4. Versioning Strategy

Recommended policy:
- Additive changes can reuse same schema only if semantics are unchanged.
- If field meaning changes or old clients could misread data, mint a new `schema_id`.
- Publish supersedes mapping for discoverability.

Client behavior:
- Read records by `schema_id`.
- Optionally resolve latest schema via mapping events.
- Migrate lazily on read/write when desired.

## 5. Shared vs Private Schemas

Both are supported:
- Shared schemas: published for ecosystem reuse.
- Private schemas: app-specific, still signed and discoverable if desired.

Borrowing/forking flow:
- Reuse another schema_id if compatible.
- If diverging, publish a new schema_id and optionally include `forks_from` metadata.

## 6. Native Nostr Event Storage

SuperBased can also store native Nostr events for app use and recovery workflows.

Use cases:
- Backup of encrypted DM/message events used by clients (e.g. Marmot encrypted messages) for future recovery.
- App-local indexing of selected kinds for offline-first UX.
- Cross-device state restore.

Recommended metadata for native event storage:
- `nostr_event_kind` (e.g. 4, 14, 1059, etc. depending on protocol/client usage)
- `nostr_event_id`
- `nostr_pubkey`
- `schema_id` may be omitted or set to a dedicated event-schema ID (e.g. `nostr_event_backup_v1`).

Notes:
- SuperBased storage is not a relay replacement.
- It is a user-owned encrypted persistence layer that can complement relay retention.

## 7. Suggested Event Shapes (Non-Normative)

### 7.1 Collection Definition (`kind: 30256` suggested)

Content JSON (example):

```json
{
  "schema_id": "todo13346",
  "name": "tasks",
  "description": "Task items used by Todo-compatible apps",
  "fields": {
    "title": "string",
    "done": "boolean",
    "due_at": "unix_seconds|null"
  },
  "examples": [
    { "title": "Ship v1", "done": false, "due_at": null }
  ]
}
```

Suggested tags:
- `d`: stable addressable slug (e.g. `schema.todo13346`)
- `t`: `superbased-schema`

### 7.2 Supersedes Mapping Event

Content JSON (example):

```json
{
  "from_schema_id": "todo13346",
  "to_schema_id": "todo411256",
  "reason": "Added recurring rule model"
}
```

Suggested tags:
- `t`: `superbased-schema-supersedes`

### 7.3 App Profile Event

Content JSON (example):

```json
{
  "app": "todo-skin-mobile",
  "uses": ["todo13346", "doc3787489"],
  "role": "skin"
}
```

Suggested tags:
- `t`: `superbased-app-profile`

## 8. Backward Compatibility

Implementations should remain compatible with existing `collection`-only records.

If `schema_id` is missing:
- Treat record as legacy.
- Resolve using app defaults or user-selected mapping.
- Avoid destructive rewrites unless explicitly requested.

## 9. Open Questions

- Final event kinds for definition/mapping/profile (single kind with tags vs separate kinds).
- Canonical tag vocabulary (`supersedes`, `forks_from`, `compat_with`).
- Whether to expose a resolver API endpoint for `schema_id -> latest` in HTTP/CVM.

See also: `docs/provider_discovery_spec.md` for provider discovery and connection-key distribution via Nostr (`kind: 30257` suggested).

---

This spec is intentionally guide-oriented. It prioritizes practical interoperability and rapid evolution over strict protocol enforcement, matching SuperBased's encrypted-blob storage model.
