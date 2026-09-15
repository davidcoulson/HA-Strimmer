# Client status API

`GET /stripper/client.json` on the proxy port (default 9123).

Lets a panel — ha-paneld, Kiosk Satellite — render an admin screen saying whether the trimmer is
in front of it, what it is cutting, and what that is worth on its own connection.

## Detection

The path is served by the proxy and never forwarded, so reaching it is the signal:

- `200` — the Stripper is running **and in the path** for this client.
- `404` — the client is talking to Home Assistant directly.
- connection error — neither is reachable; a network fault, not a Stripper one.

No header is added to dashboard loads. A header would put bytes on every page fetch to carry a
snapshot taken before the websocket exists, for a screen that is read occasionally.

## Boundary

The proxy port is reachable by anything on the network and is unauthenticated, so the reply
carries only what that network may read: booleans for what is trimmed, and the **caller's own**
numbers. It never returns override rules, allowlist contents, entity ids, Home Assistant user
identities, or any other client's data — and there is no way to name a different subject, which
would let any device enumerate every panel. `test/client_info.test.mjs` fails if that changes.

Advisory only. Render it; do not gate behaviour on it, and do not relay it off the local network.

## Shape

See `test/client_info.test.mjs` for the guarantees, and the integration guide for field-by-field
documentation. Summary:

```
stripper  { running, version, uptime_sec }
trimming  { entities, by_dashboard, registries, resources, extra_modules,
            services, repairs, themes, translations, compress_websocket }   // booleans only
client    { ip, connections, dashboard, attributed_via, entities_served,
            first_payload { entities, bytes, ms_to_data, drain_ms },
            traffic { from_ha_bytes, to_browser_bytes, not_sent_bytes,
                      not_sent_pct, update_bytes_per_min },
            connected_sec }
```

Every field under `client` may be `null`, and `null` means "not known", never zero.
`connections: 0` is meaningful: the proxy IS in the path, but has no websocket from this address.

The schema is additive — consumers must ignore unknown fields rather than validate strictly.
