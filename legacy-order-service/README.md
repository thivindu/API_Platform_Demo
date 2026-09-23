# LegacyOrderServiceAPI — SOAP-to-REST Demo

A legacy SOAP Order Management service exposed as a plain JSON/REST API on
the WSO2 API Platform Gateway. Callers send and receive JSON; the backend
only ever sees SOAP/XML. The conversion is done entirely by the stock
[`json-xml-mediator`](https://wso2.com/api-platform/policy-hub/policies/json-xml-mediator)
policy — no custom policy, no interceptor, no code in the gateway.

This API is deliberately minimal: **no auth, no rate limiting, no dynamic
routing**. It exists only to show SOAP proxying via REST.

```
REST caller                 Gateway                        SOAP backend
-----------                 -------                        ------------
POST /orders/get      -->   set-headers: SOAPAction   -->
{"Envelope":{"Body":        request-rewrite: /OrderService
  {"GetOrder":{...}}}}      json-xml-mediator (json->xml)  <root><Envelope>
                                                             <Body><GetOrder>
                      <--   json-xml-mediator (xml->json) <--  SOAP response
{"Envelope":{"Body":
  {"GetOrderResponse":...}}}
```

## Contents

```
legacy-order-service/
├── LegacyOrderServiceAPI-v1.0.yaml  # API definition (deploy to the gateway)
├── api-portal/                       # Developer Portal manifest + OpenAPI
│   ├── api.yaml
│   └── definition.yaml
└── mock-services/
    └── mock-soap-backend.js          # Standalone Node.js SOAP service
```

## 1. Start the mock SOAP backend

Plain Node.js, no dependencies:

```bash
cd mock-services
NAME=order_soap_backend PORT=7196 node mock-soap-backend.js &
```

Verify, and read its WSDL:

```bash
curl "http://localhost:7196/OrderService?wsdl"
```

Call it directly as SOAP, bypassing the gateway. `GetOrder` over SOAP 1.1,
with the action in the `SOAPAction` header:

```bash
curl -X POST "http://localhost:7196/OrderService" \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: "http://wso2.com/demo/order-management/GetOrder"' \
  -d '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ord="http://wso2.com/demo/order-management">
  <soapenv:Body>
    <ord:GetOrder><ord:OrderId>1001</ord:OrderId></ord:GetOrder>
  </soapenv:Body>
</soapenv:Envelope>'
```

`ListOrders`, which takes no parameters:

```bash
curl -X POST "http://localhost:7196/OrderService" \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: "http://wso2.com/demo/order-management/ListOrders"' \
  -d '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ord="http://wso2.com/demo/order-management">
  <soapenv:Body><ord:ListOrders/></soapenv:Body>
</soapenv:Envelope>'
```

`CreateOrder` over SOAP 1.2, where the action rides inside `Content-Type`
instead of its own header:

```bash
curl -X POST "http://localhost:7196/OrderService" \
  -H 'Content-Type: application/soap+xml; charset=utf-8; action="http://wso2.com/demo/order-management/CreateOrder"' \
  -d '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ord="http://wso2.com/demo/order-management">
  <soap:Body>
    <ord:CreateOrder>
      <ord:Customer>Railco Logistics</ord:Customer>
      <ord:Item>Brake Pad Set</ord:Item>
      <ord:Quantity>12</ord:Quantity>
    </ord:CreateOrder>
  </soap:Body>
</soap:Envelope>'
```

It exposes three operations — `GetOrder`, `ListOrders` and `CreateOrder` —
and returns a SOAP Fault (500) for anything else. Every response carries
`<ord:Backend>` naming the backend, so you can see which upstream answered.

## 2. Deploy the API

```bash
curl -X POST "http://localhost:9090/api/management/v1/rest-apis" \
  -u "admin:<GW_ADMIN_PASSWORD>" -H "Content-Type: application/yaml" \
  --data-binary @LegacyOrderServiceAPI-v1.0.yaml
```

Use `PUT .../rest-apis/LegacyOrderServiceAPI-v1.0` for subsequent updates —
a repeated POST returns `409 Conflict`.

## 3. Call it as REST

No token needed — this API has no auth policy attached.
`Content-Type: application/json` is mandatory; the mediator rejects
anything else with a 500.

```bash
BASE=http://localhost:8080/legacy-order-service/v1.0
```

**Create an order** — `POST /orders` → `CreateOrder`:

```bash
curl -X POST "$BASE/orders" -H 'Content-Type: application/json' \
  -d '{"Envelope":{"Body":{"CreateOrder":{
        "Customer":"Railco Logistics","Item":"Brake Pad Set","Quantity":12}}}}'
```

```json
{"Envelope":{"@ord":"http://wso2.com/demo/order-management",
 "@soap":"http://schemas.xmlsoap.org/soap/envelope/",
 "Body":{"CreateOrderResponse":{"Backend":"order_soap_backend",
   "Order":{"Customer":"Railco Logistics","Item":"Brake Pad Set",
            "OrderId":9171,"Quantity":12,"Status":"CREATED"}}}}}
```

**Fetch one order** — `POST /orders/get` → `GetOrder`:

```bash
curl -X POST "$BASE/orders/get" -H 'Content-Type: application/json' \
  -d '{"Envelope":{"Body":{"GetOrder":{"OrderId":"1001"}}}}'
```

**List orders** — `POST /orders/list` → `ListOrders`:

```bash
curl -X POST "$BASE/orders/list" -H 'Content-Type: application/json' \
  -d '{"Envelope":{"Body":{"ListOrders":{}}}}'
```

Repeated XML elements become a JSON array on the way back:

```json
"Orders":{"Order":[{"OrderId":1001,"Status":"CONFIRMED", ...},
                   {"OrderId":1002,"Status":"SHIPPED", ...}]}
```

**Fault path** — an unknown operation comes back as the SOAP Fault converted
to JSON, with HTTP 500:

```bash
curl -X POST "$BASE/orders" -H 'Content-Type: application/json' \
  -d '{"Envelope":{"Body":{"DeleteEverything":{}}}}'
```

```json
{"Envelope":{"Body":{"Fault":{"faultcode":"soap:Client",
  "faultstring":"Unknown operation: DeleteEverything",
  "detail":{"Backend":"order_soap_backend"}}}}}
```

### The same operation, both ways

```
Direct  →  <ord:GetOrderResponse>
             <ord:Backend>order_soap_backend</ord:Backend>
             <ord:Order>
               <ord:OrderId>1001</ord:OrderId>
               <ord:Status>CONFIRMED</ord:Status> …

Via API →  {"Envelope":{"Body":{"GetOrderResponse":{
             "Backend":"order_soap_backend",
             "Order":{"OrderId":1001,"Status":"CONFIRMED", …}}}}}
```

Note that `OrderId` comes back as the JSON number `1001` rather than the
string that was sent: XML is untyped text, so the conversion coerces
numeric-looking values.

To show what the gateway actually sends upstream, `tail -f` the backend's
output and watch the `<root><Envelope>…` line appear as each REST call
fires.

## How it works

Three policies, each doing one job.

| Policy | Scope | Job |
|---|---|---|
| `json-xml-mediator` | API | JSON→XML on the request, XML→JSON on the response |
| `request-rewrite` | API | Rewrites every REST path to the backend's single `/OrderService` endpoint |
| `set-headers` | Operation | Sets the `SOAPAction` that operation's SOAP call needs |

`set-headers` is attached **per operation**, not API-wide, because the
`SOAPAction` value differs per operation — that is what maps one REST path
to one SOAP operation.

### Things worth knowing about json-xml-mediator

All of these were verified against this gateway (`json-xml-mediator
v1.0.4`), not assumed.

**The parameter name has a typo, and you must reproduce it.** The schema
says `downsteamPayloadFormat` — no `r`. Spelling it correctly fails
validation. See `/app/policies/json-xml-mediator-v1.0.4.yaml` inside the
`gateway-controller` image for the authoritative schema.

**Use a major-only policy version.** `version: v1`, not `v1.0.4`; the
gateway rejects a full semantic version.

**Generated XML is wrapped in a synthetic `<root>`.** The backend actually
receives:

```xml
<root><Envelope><Body><GetOrder><OrderId>1001</OrderId></GetOrder></Body></Envelope></root>
```

This is *not* a strictly valid SOAP envelope — `Envelope` has to be the
document root. `mock-soap-backend.js` dispatches on the first child of
`<Body>` (falling back to `SOAPAction`), so it accepts this; a strict SOAP
stack such as Axis2 or .NET WCF would not. For a real legacy backend, add
an `interceptor-service` or a custom policy after the mediator to unwrap
`<root>`.

**The conversion is not namespace-aware.** A colon in a JSON key does not
become a namespace prefix: `"soap:Envelope"` becomes
`<soap_Envelope originalKey="soap:Envelope">`, and `"@xmlns:soap"` becomes
an element rather than an attribute. That is why the request JSON above is
deliberately prefix-free and namespace-free.

**Don't set `Content-Type` with `set-headers`.** The mediator requires the
incoming `Content-Type` to be exactly `application/json`, and `set-headers`
runs *before* it. Overwriting the caller's `application/json` fails the
request with `500 Content-Type must be application/json for downstream
payload format json`. The mediator sets the upstream `Content-Type` to
`application/xml` itself.

**The envelope structure comes from the caller's JSON.** No policy here can
synthesize it, so each REST operation is a `POST` whose body mirrors the
SOAP envelope. This is also why there are no `GET` operations: a GET has no
request body, so there is nothing for the mediator to convert into an
envelope, and the backend would answer with a SOAP Fault.

**Numbers are coerced.** `"OrderId":"1001"` goes out as XML text and comes
back as the JSON number `1001`.

## 4. (Optional) Publish to the Developer Portal

```bash
curl -sk -X POST https://localhost:9543/api-portal/api/v0.9/apis \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@api-portal/api.yaml;type=application/yaml" \
  -F "definition=@api-portal/definition.yaml;type=application/yaml"
```

Set `referenceId` in `api-portal/api.yaml` to the id the Platform API
assigns this API first.
