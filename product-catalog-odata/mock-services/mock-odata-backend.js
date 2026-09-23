/*
 * Minimal mock OData v4 service -- the OData counterpart of
 * mock-soap-backend.js in ../../legacy-order-service. Zero dependencies,
 * parameterized by env vars.
 *
 * Usage: NAME=catalog_odata_backend PORT=7194 node mock-odata-backend.js
 *
 * SERVICE_ROOT is the important one. OData responses embed ABSOLUTE URLs
 * (@odata.context, @odata.nextLink, navigation links), and by default they
 * point at this process -- which means a client behind a gateway would
 * follow them straight back to the backend, bypassing the gateway, or fail
 * outright when the backend is not reachable from the client's network.
 * Setting SERVICE_ROOT to the gateway's public URL makes this service emit
 * gateway URLs instead:
 *
 *   SERVICE_ROOT=http://localhost:8080/product-catalog/v1.0 \
 *   NAME=catalog_odata_backend PORT=7194 node mock-odata-backend.js
 *
 * Real OData stacks (SAP Gateway, Apache Olingo, WCF Data Services) expose
 * the same knob. It is the cheap, correct fix for the URL-leak problem --
 * the alternative is rewriting response bodies in an interceptor-service.
 *
 * Endpoints:
 *   GET  /                    service document
 *   GET  /$metadata           EDMX metadata (XML)
 *   GET  /Products            collection
 *   GET  /Products(1)         entity by key
 *   GET  /Products(1)/Name    property value
 *   GET  /Products(1)/Supplier   navigation property
 *   GET  /Suppliers, /Suppliers(1)
 *   POST /Products            create        (201 + Location)
 *   PATCH  /Products(1)       partial update (200)
 *   DELETE /Products(1)       delete         (204)
 *
 * Query options implemented, on collections:
 *   $select, $top, $skip, $count, $orderby (asc|desc), $expand=Supplier,
 *   $filter -- a deliberate SUBSET: <prop> <op> <literal> where op is one
 *   of eq ne gt ge lt le, optionally joined by a single `and`/`or`, plus
 *   contains(<prop>,'<text>') and startswith(<prop>,'<text>'). Anything
 *   else returns 501 with an OData error rather than silently ignoring the
 *   filter -- a mock that quietly returns unfiltered data is worse than one
 *   that admits the gap.
 */
'use strict';

const http = require('http');

const NAME = process.env.NAME || 'catalog_odata_backend';
const PORT = parseInt(process.env.PORT || '7194', 10);
const SERVICE_ROOT = (process.env.SERVICE_ROOT || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '2', 10);

const SUPPLIERS = [
  { ID: 1, Name: 'Northwind Parts', City: 'Colombo' },
  { ID: 2, Name: 'Acme Supply Co',  City: 'Singapore' },
];

let PRODUCTS = [
  { ID: 1, Name: 'Brake Pad Set',   Price: 49.99,  Category: 'Parts',       SupplierID: 1 },
  { ID: 2, Name: 'Axle Bearing',    Price: 129.5,  Category: 'Parts',       SupplierID: 1 },
  { ID: 3, Name: 'Service Kit',     Price: 15.0,   Category: 'Consumables', SupplierID: 2 },
  { ID: 4, Name: 'Coupler Pin',     Price: 8.75,   Category: 'Parts',       SupplierID: 2 },
  { ID: 5, Name: 'Hydraulic Fluid', Price: 32.4,   Category: 'Consumables', SupplierID: 2 },
];

const ENTITY_SETS = {
  Products:  { rows: () => PRODUCTS,  type: 'Demo.Product'  },
  Suppliers: { rows: () => SUPPLIERS, type: 'Demo.Supplier' },
};

/* ---------- helpers ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json;odata.metadata=minimal',
    'OData-Version': '4.0',
    ...headers,
  });
  res.end(body);
}

/* OData errors have a prescribed shape -- clients parse it. */
function fail(res, status, code, message) {
  send(res, status, { error: { code: String(code), message } });
}

function expandSupplier(p) {
  const s = SUPPLIERS.find((x) => x.ID === p.SupplierID) || null;
  return { ...p, Supplier: s };
}

function pick(obj, csv) {
  const keys = csv.split(',').map((k) => k.trim()).filter(Boolean);
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

/* ---------- $filter: a documented subset, not a real parser ---------- */

const COMPARATORS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
};

function literal(raw) {
  const t = raw.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  return t;
}

/* Returns a predicate, or throws with a message the caller turns into 501. */
function compileTerm(term) {
  const t = term.trim().replace(/^\((.*)\)$/s, '$1').trim();

  let m = t.match(/^(contains|startswith)\(\s*([A-Za-z_]\w*)\s*,\s*('(?:[^']|'')*')\s*\)$/i);
  if (m) {
    const [, fn, prop, lit] = m;
    const needle = String(literal(lit));
    return (row) => {
      const v = row[prop];
      if (typeof v !== 'string') return false;
      return fn.toLowerCase() === 'contains' ? v.includes(needle) : v.startsWith(needle);
    };
  }

  m = t.match(/^([A-Za-z_]\w*)\s+(eq|ne|gt|ge|lt|le)\s+(.+)$/i);
  if (m) {
    const [, prop, op, lit] = m;
    const want = literal(lit);
    const cmp = COMPARATORS[op.toLowerCase()];
    return (row) => (prop in row ? cmp(row[prop], want) : false);
  }

  throw new Error(`Unsupported $filter expression: ${term.trim()}`);
}

function compileFilter(expr) {
  // One level of and/or only -- enough for a demo, and it refuses the rest
  // loudly instead of pretending.
  const or = expr.split(/\s+or\s+/i);
  if (or.length > 1) {
    const parts = or.map(compileFilter);
    return (row) => parts.some((f) => f(row));
  }
  const and = expr.split(/\s+and\s+/i);
  if (and.length > 1) {
    const parts = and.map(compileTerm);
    return (row) => parts.every((f) => f(row));
  }
  return compileTerm(expr);
}

/* ---------- collection query pipeline ---------- */

function applyQuery(rows, q, setName, res) {
  let out = rows.slice();

  const filter = q.get('$filter');
  if (filter) {
    let pred;
    try {
      pred = compileFilter(filter);
    } catch (e) {
      fail(res, 501, 'NotImplemented', e.message);
      return null;
    }
    out = out.filter(pred);
  }

  const orderby = q.get('$orderby');
  if (orderby) {
    const [prop, dir = 'asc'] = orderby.trim().split(/\s+/);
    const sign = dir.toLowerCase() === 'desc' ? -1 : 1;
    out.sort((a, b) => (a[prop] > b[prop] ? sign : a[prop] < b[prop] ? -sign : 0));
  }

  // $count is computed AFTER $filter but BEFORE $top/$skip -- per spec.
  const wantCount = q.get('$count') === 'true';
  const total = out.length;

  const skip = parseInt(q.get('$skip') || '0', 10);
  if (skip > 0) out = out.slice(skip);

  // An explicit $top wins; otherwise server-driven paging kicks in.
  const topRaw = q.get('$top');
  const top = topRaw !== null ? parseInt(topRaw, 10) : PAGE_SIZE;
  const more = out.length > top;
  out = out.slice(0, top);

  if (q.get('$expand') === 'Supplier' && setName === 'Products') out = out.map(expandSupplier);

  const select = q.get('$select');
  if (select) out = out.map((r) => pick(r, select));

  const body = { '@odata.context': `${SERVICE_ROOT}/$metadata#${setName}`, backend: NAME };
  if (wantCount) body['@odata.count'] = total;
  body.value = out;

  // Server-driven paging: only when the client did NOT pin $top itself.
  if (more && topRaw === null) {
    const next = new URLSearchParams(q);
    next.set('$skip', String(skip + top));
    // URLSearchParams percent-encodes '$'; real OData services emit it literally.
    const qs = next.toString().replace(/%24/g, '$');
    body['@odata.nextLink'] = `${SERVICE_ROOT}/${setName}?${qs}`;
  }
  return body;
}

/* ---------- metadata ---------- */

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Demo" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="Price" Type="Edm.Decimal"/>
        <Property Name="Category" Type="Edm.String"/>
        <Property Name="SupplierID" Type="Edm.Int32"/>
        <NavigationProperty Name="Supplier" Type="Demo.Supplier"/>
      </EntityType>
      <EntityType Name="Supplier">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="City" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Demo.Product">
          <NavigationPropertyBinding Path="Supplier" Target="Suppliers"/>
        </EntitySet>
        <EntitySet Name="Suppliers" EntityType="Demo.Supplier"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  console.log(`[${NAME}] ${req.method} ${req.url}`);

  const url = new URL(req.url, 'http://placeholder');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  // Service document
  if (path === '/' && req.method === 'GET') {
    return send(res, 200, {
      '@odata.context': `${SERVICE_ROOT}/$metadata`,
      backend: NAME,
      value: Object.keys(ENTITY_SETS).map((n) => ({ name: n, kind: 'EntitySet', url: n })),
    });
  }

  if (path === '/$metadata' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/xml', 'OData-Version': '4.0' });
    return res.end(METADATA);
  }

  // /Set(key)/Property  |  /Set(key)  |  /Set
  const keyed = path.match(/^\/(\w+)\((\d+)\)(?:\/(\w+))?$/);
  if (keyed) {
    const [, setName, rawKey, prop] = keyed;
    const set = ENTITY_SETS[setName];
    if (!set) return fail(res, 404, 'NotFound', `No entity set named '${setName}'`);

    const rows = set.rows();
    const idx = rows.findIndex((r) => r.ID === Number(rawKey));
    if (idx === -1) return fail(res, 404, 'NotFound', `${setName}(${rawKey}) does not exist`);
    const entity = rows[idx];

    if (req.method === 'GET') {
      if (prop === 'Supplier' && setName === 'Products') {
        const s = SUPPLIERS.find((x) => x.ID === entity.SupplierID);
        if (!s) return fail(res, 404, 'NotFound', 'Supplier not found');
        return send(res, 200, { '@odata.context': `${SERVICE_ROOT}/$metadata#Suppliers/$entity`, backend: NAME, ...s });
      }
      if (prop) {
        if (!(prop in entity)) return fail(res, 404, 'NotFound', `No property '${prop}' on ${setName}`);
        return send(res, 200, { '@odata.context': `${SERVICE_ROOT}/$metadata#${setName}(${rawKey})/${prop}`, value: entity[prop] });
      }
      let out = entity;
      if (q.get('$expand') === 'Supplier' && setName === 'Products') out = expandSupplier(out);
      const select = q.get('$select');
      if (select) out = pick(out, select);
      return send(res, 200, { '@odata.context': `${SERVICE_ROOT}/$metadata#${setName}/$entity`, backend: NAME, ...out });
    }

    if (req.method === 'PATCH' && setName === 'Products') {
      let patch;
      try { patch = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'BadRequest', 'Body is not valid JSON'); }
      delete patch.ID;                       // the key is immutable
      PRODUCTS[idx] = { ...entity, ...patch };
      return send(res, 200, { '@odata.context': `${SERVICE_ROOT}/$metadata#Products/$entity`, backend: NAME, ...PRODUCTS[idx] });
    }

    if (req.method === 'DELETE' && setName === 'Products') {
      PRODUCTS.splice(idx, 1);
      res.writeHead(204, { 'OData-Version': '4.0' });
      return res.end();
    }

    return fail(res, 405, 'MethodNotAllowed', `${req.method} not allowed on ${path}`);
  }

  const collection = path.match(/^\/(\w+)$/);
  if (collection) {
    const setName = collection[1];
    const set = ENTITY_SETS[setName];
    if (!set) return fail(res, 404, 'NotFound', `No entity set named '${setName}'`);

    if (req.method === 'GET') {
      const body = applyQuery(set.rows(), q, setName, res);
      if (body === null) return;           // applyQuery already answered (501)
      return send(res, 200, body);
    }

    if (req.method === 'POST' && setName === 'Products') {
      let incoming;
      try { incoming = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'BadRequest', 'Body is not valid JSON'); }
      if (!incoming.Name) return fail(res, 400, 'BadRequest', 'Name is required');
      const created = {
        ID: Math.max(0, ...PRODUCTS.map((p) => p.ID)) + 1,
        Name: incoming.Name,
        Price: incoming.Price ?? 0,
        Category: incoming.Category ?? 'Uncategorized',
        SupplierID: incoming.SupplierID ?? 1,
      };
      PRODUCTS.push(created);
      return send(res, 201,
        { '@odata.context': `${SERVICE_ROOT}/$metadata#Products/$entity`, backend: NAME, ...created },
        { Location: `${SERVICE_ROOT}/Products(${created.ID})` });
    }

    return fail(res, 405, 'MethodNotAllowed', `${req.method} not allowed on ${path}`);
  }

  return fail(res, 404, 'NotFound', `No route for ${path}`);
});

server.listen(PORT, () => {
  console.log(`[${NAME}] mock OData v4 backend listening on :${PORT}`);
  console.log(`[${NAME}] service root in emitted URLs: ${SERVICE_ROOT}`);
});
