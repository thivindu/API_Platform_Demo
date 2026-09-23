# ProductCatalogAPI — OData-to-REST Demo

An OData v4 Product Catalog service exposed through the WSO2 API Platform
Gateway. The companion to `../legacy-order-service`, and a deliberate
contrast with it: **this one needs no mediation policy at all.**

OData v4 is already REST over HTTP with JSON payloads, so there is nothing
to transcode. The gateway's job is routing — plus whatever auth and quotas
you choose to add later. The whole API definition is an upstream and four
operations.

The interesting part is not the conversion (there isn't one). It is the two
things that actually bite when you put OData behind a gateway: **path
matching** and **embedded absolute URLs**.

## Contents

```
product-catalog-odata/
├── ProductCatalogAPI-v1.0.yaml   # API definition (deploy to the gateway)
├── api-portal/                   # Developer Portal manifest + OpenAPI
│   ├── api.yaml
│   └── definition.yaml
└── mock-services/
    └── mock-odata-backend.js     # Standalone Node.js OData v4 service
```

## 1. Start the mock OData backend

Plain Node.js, no dependencies. Point `SERVICE_ROOT` at the gateway — see
[The URL-leak problem](#the-url-leak-problem) for why this matters:

```bash
cd mock-services
SERVICE_ROOT=http://localhost:8080/product-catalog/v1.0 \
  NAME=catalog_odata_backend PORT=7194 node mock-odata-backend.js &
```

It serves two entity sets, `Products` and `Suppliers`, with a navigation
property from product to supplier. Every response carries `"backend"`
naming the service that answered.

## 2. Deploy the API

```bash
curl -X POST "http://localhost:9090/api/management/v1/rest-apis" \
  -u "admin:<GW_ADMIN_PASSWORD>" -H "Content-Type: application/yaml" \
  --data-binary @ProductCatalogAPI-v1.0.yaml
```

Use `PUT .../rest-apis/ProductCatalogAPI-v1.0` for subsequent updates — a
repeated POST returns `409 Conflict`.

## 3. Call it

No token needed — this API has no auth policy attached.

```bash
BASE=http://localhost:8080/product-catalog/v1.0
```

### Reads

```bash
curl "$BASE/"                       # service document
curl "$BASE/\$metadata"              # EDMX model (XML)
curl "$BASE/Products"               # collection
curl "$BASE/Products(2)"            # entity by key
curl "$BASE/Products(2)/Name"       # property value
curl "$BASE/Products(2)/Supplier"   # navigation property
curl "$BASE/Suppliers(1)"
```

### Query options

These need no gateway configuration whatsoever — they are ordinary query
strings and pass through untouched. Quote or escape `$` so your shell
doesn't eat it.

```bash
curl "$BASE/Products?\$filter=Category eq 'Parts'&\$select=ID,Name" -G
curl "$BASE/Products?\$count=true&\$orderby=Price desc" -G
curl "$BASE/Products?\$top=2&\$skip=2" -G
curl "$BASE/Products(3)?\$expand=Supplier" -G
curl "$BASE/Products?\$filter=contains(Name,'Pad')" -G
```

### Writes

```bash
# create -> 201 with a Location header
curl -X POST "$BASE/Products" -H 'Content-Type: application/json' \
  -d '{"Name":"Coupling Rod","Price":76.25,"Category":"Parts","SupplierID":2}'

# partial update -> 200
curl -X PATCH "$BASE/Products(6)" -H 'Content-Type: application/json' \
  -d '{"Price":80.0}'

# delete -> 204
curl -X DELETE "$BASE/Products(6)"
```

## Why there are no policies

| Concern | What it needs |
|---|---|
| JSON payloads | Nothing. OData v4 is JSON already. |
| `$filter`, `$select`, `$expand`, `$top`, `$orderby`, `$count` | Nothing. Ordinary query strings. |
| Open-ended URL shapes | A catch-all path — see below. |
| Embedded absolute URLs | `SERVICE_ROOT` on the backend — see below. |
| Auth, quotas | `jwt-auth` / `api-key-auth` and a rate-limit policy, if you want them. Nothing OData-specific. |

Contrast with `../legacy-order-service`, where SOAP needs
`json-xml-mediator` to transcode, `request-rewrite` to reach the single
SOAP endpoint, and a per-operation `set-headers` for `SOAPAction`.

**OData v2 and v3** are the exception. They default to Atom/XML, so add one
`set-headers` sending `Accept: application/json`, or a `request-rewrite`
appending `$format=json`. Reach for `json-xml-mediator` only if the backend
genuinely cannot emit JSON.

## Path matching: use `/*`

OData URLs are open-ended — `/Products(3)/Supplier` is as valid as
`/Products`. You cannot enumerate them as operations. Verified against this
gateway (1.2.1):

| `path:` value | Behaviour |
|---|---|
| `/*` | **True multi-segment catch-all.** Matches `/Products(3)/Supplier`. This is what OData needs. |
| `/{path}` | Single segment only. `/Products(3)` matches, `/Products(3)/Name` returns 404. |
| `/Products({id})` | Works and is templated (`(2)` and `(3)` both match), but you would have to enumerate every shape. |

So each HTTP method is declared once against `/*`.

Be aware what that exposes: a catch-all publishes the **whole** OData
service through the gateway, including `$metadata` — which publishes your
entity model — and every entity set the backend serves. That is usually the
point of an OData proxy. To restrict it instead, replace the `/*`
operations with explicit ones such as `GET /Products` and
`GET /Products({id})`, and the rest of the service stops being reachable.

## The URL-leak problem

OData responses embed **absolute** URLs: `@odata.context`,
`@odata.nextLink`, and `Location` on create. By default they name the
backend, so a client paging through results via `@odata.nextLink` would
leave the gateway entirely — or fail outright when the backend isn't
reachable from its network.

```
SERVICE_ROOT unset:
  @odata.nextLink = http://localhost:7194/Products?$skip=2        ← the backend

SERVICE_ROOT=http://localhost:8080/product-catalog/v1.0:
  @odata.nextLink = http://localhost:8080/product-catalog/v1.0/Products?$skip=2
```

**No stock policy rewrites a response body.** `host-rewrite` only sets the
upstream `Host` *request* header, which is a different thing entirely. Two
real fixes:

1. **Tell the OData service its own public root.** Every real OData stack
   supports this — SAP Gateway, Apache Olingo, WCF Data Services — and the
   mock here takes it as `SERVICE_ROOT`. Costs nothing at the gateway, so
   prefer it.
2. **An `interceptor-service` on the response phase** with
   `includeResponseBody: true`, rewriting the URLs. Works, but it is a
   network hop on every response and a service you have to run. Use it only
   when a backend genuinely cannot be told its public root.

## About the mock

It implements a useful subset of OData v4, not the whole spec:

- `$select`, `$top`, `$skip`, `$count`, `$orderby` (asc/desc),
  `$expand=Supplier`
- `$filter` — `<prop> <op> <literal>` for `eq ne gt ge lt le`, joined by a
  single `and`/`or`, plus `contains(...)` and `startswith(...)`
- Server-driven paging via `@odata.nextLink`, `PAGE_SIZE=2` by default so
  paging is visible with only five rows
- CRUD on `Products`: `POST` (201 + `Location`), `PATCH` (200),
  `DELETE` (204)

Anything outside that `$filter` subset returns **501 with an OData error**
rather than silently ignoring the filter — a mock that quietly returns
unfiltered data is worse than one that admits the gap.

## 4. (Optional) Publish to the Developer Portal

```bash
curl -sk -X POST https://localhost:9543/api-portal/api/v0.9/apis \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@api-portal/api.yaml;type=application/yaml" \
  -F "definition=@api-portal/definition.yaml;type=application/yaml"
```

Set `referenceId` in `api-portal/api.yaml` to the id the Platform API
assigns this API first.
