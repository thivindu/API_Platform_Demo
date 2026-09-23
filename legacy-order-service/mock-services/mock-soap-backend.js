/*
 * Minimal mock SOAP backend -- the SOAP counterpart of mock-backend.js.
 * Same idea: parameterized by env vars, so each issuer/org can be routed to
 * a visibly distinct destination when testing dynamic-endpoint routing, but
 * speaking SOAP 1.1/1.2 instead of JSON.
 *
 * No dependencies -- the envelope is parsed with regexes, which is plenty
 * for a mock (it is not a conformant SOAP stack, and is not meant to be).
 *
 * Usage: NAME=railco_soap_backend PORT=7196 node mock-soap-backend.js
 *
 * Endpoints:
 *   GET  /OrderService?wsdl   -> the WSDL (also served at /?wsdl)
 *   POST /OrderService        -> SOAP request (any path is accepted)
 *
 * Operations (dispatched on the first child of <soap:Body>, falling back to
 * the SOAPAction header):
 *   GetOrder    { orderId }                 -> one order
 *   ListOrders  { }                         -> all orders for this backend
 *   CreateOrder { customer, item, quantity} -> the created order
 *
 * Unknown operation, or a request with no parsable Body, gets a SOAP Fault
 * (500) rather than a 200 -- so routing failures are obvious in a capture.
 */
'use strict';

const http = require('http');

const NAME = process.env.NAME || 'mock_soap_backend';
const PORT = parseInt(process.env.PORT || '7190', 10);
const TNS = process.env.TARGET_NAMESPACE || 'http://wso2.com/demo/order-management';

const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* Strip the namespace prefix off an element name: "ord:GetOrder" -> "GetOrder". */
function localName(qname) {
  return qname.includes(':') ? qname.split(':').pop() : qname;
}

/* First child element of <Body>, i.e. the operation element. */
function operationOf(xml) {
  const body = xml.match(/<\s*(?:[\w.-]+:)?Body[^>]*>([\s\S]*?)<\s*\/\s*(?:[\w.-]+:)?Body\s*>/i);
  if (!body) return null;
  const first = body[1].match(/<\s*([\w.:-]+)[\s>/]/);
  return first ? localName(first[1]) : null;
}

/* Value of the first <...:field>...</...:field> anywhere in the envelope. */
function field(xml, name, fallback) {
  // The (?=[\\s/>]) stops a lookup for "Item" from matching an <Items> wrapper.
  const m = xml.match(new RegExp(`<\\s*(?:[\\w.-]+:)?${name}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\s*/`, 'i'));
  return m ? m[1].trim() : fallback;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* Orders are synthesized from NAME, so a response identifies its backend at
 * a glance -- the SOAP equivalent of mock-backend.js's {"backend": NAME}. */
function ordersFor(name) {
  return [
    { id: '1001', customer: `Customer of ${name}`, item: `Widget served by ${name}`, quantity: 2, status: 'CONFIRMED' },
    { id: '1002', customer: `Customer of ${name}`, item: `Gadget served by ${name}`, quantity: 5, status: 'SHIPPED' },
  ];
}

function orderXml(order) {
  return `        <ord:Order>
          <ord:OrderId>${escapeXml(order.id)}</ord:OrderId>
          <ord:Customer>${escapeXml(order.customer)}</ord:Customer>
          <ord:Item>${escapeXml(order.item)}</ord:Item>
          <ord:Quantity>${escapeXml(order.quantity)}</ord:Quantity>
          <ord:Status>${escapeXml(order.status)}</ord:Status>
        </ord:Order>`;
}

function envelope(ns, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${ns}" xmlns:ord="${TNS}">
  <soap:Body>
${inner}
  </soap:Body>
</soap:Envelope>
`;
}

function faultXml(ns, code, reason) {
  const inner = ns === SOAP12
    ? `    <soap:Fault>
      <soap:Code><soap:Value>soap:${code}</soap:Value></soap:Code>
      <soap:Reason><soap:Text xml:lang="en">${escapeXml(reason)}</soap:Text></soap:Reason>
      <soap:Detail><ord:Backend>${escapeXml(NAME)}</ord:Backend></soap:Detail>
    </soap:Fault>`
    : `    <soap:Fault>
      <faultcode>soap:${code === 'Sender' ? 'Client' : 'Server'}</faultcode>
      <faultstring>${escapeXml(reason)}</faultstring>
      <detail><ord:Backend>${escapeXml(NAME)}</ord:Backend></detail>
    </soap:Fault>`;
  return envelope(ns, inner);
}

function responseFor(operation, xml, ns) {
  switch (operation) {
    case 'GetOrder': {
      const orderId = field(xml, 'OrderId', '1001');
      const order = { ...ordersFor(NAME)[0], id: orderId };
      return envelope(ns, `    <ord:GetOrderResponse>
      <ord:Backend>${escapeXml(NAME)}</ord:Backend>
${orderXml(order)}
    </ord:GetOrderResponse>`);
    }
    case 'ListOrders': {
      const orders = ordersFor(NAME).map(orderXml).join('\n');
      return envelope(ns, `    <ord:ListOrdersResponse>
      <ord:Backend>${escapeXml(NAME)}</ord:Backend>
      <ord:Orders>
${orders}
      </ord:Orders>
    </ord:ListOrdersResponse>`);
    }
    case 'CreateOrder': {
      const order = {
        id: String(Math.floor(Math.random() * 9000) + 1000),
        customer: field(xml, 'Customer', `Customer of ${NAME}`),
        item: field(xml, 'Item', `Widget served by ${NAME}`),
        quantity: field(xml, 'Quantity', '1'),
        status: 'CREATED',
      };
      return envelope(ns, `    <ord:CreateOrderResponse>
      <ord:Backend>${escapeXml(NAME)}</ord:Backend>
${orderXml(order)}
    </ord:CreateOrderResponse>`);
    }
    default:
      return null;
  }
}

const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="OrderService"
    targetNamespace="${TNS}"
    xmlns:tns="${TNS}"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">

  <wsdl:types>
    <xsd:schema targetNamespace="${TNS}" elementFormDefault="qualified">
      <xsd:complexType name="Order">
        <xsd:sequence>
          <xsd:element name="OrderId"  type="xsd:string"/>
          <xsd:element name="Customer" type="xsd:string"/>
          <xsd:element name="Item"     type="xsd:string"/>
          <xsd:element name="Quantity" type="xsd:int"/>
          <xsd:element name="Status"   type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>

      <xsd:element name="GetOrder">
        <xsd:complexType>
          <xsd:sequence><xsd:element name="OrderId" type="xsd:string"/></xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="GetOrderResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="Backend" type="xsd:string"/>
            <xsd:element name="Order"   type="tns:Order"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="ListOrders">
        <xsd:complexType><xsd:sequence/></xsd:complexType>
      </xsd:element>
      <xsd:element name="ListOrdersResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="Backend" type="xsd:string"/>
            <xsd:element name="Orders">
              <xsd:complexType>
                <xsd:sequence>
                  <xsd:element name="Order" type="tns:Order" maxOccurs="unbounded"/>
                </xsd:sequence>
              </xsd:complexType>
            </xsd:element>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="CreateOrder">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="Customer" type="xsd:string"/>
            <xsd:element name="Item"     type="xsd:string"/>
            <xsd:element name="Quantity" type="xsd:int"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="CreateOrderResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="Backend" type="xsd:string"/>
            <xsd:element name="Order"   type="tns:Order"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>

  <wsdl:message name="GetOrderRequest"><wsdl:part name="parameters" element="tns:GetOrder"/></wsdl:message>
  <wsdl:message name="GetOrderResponse"><wsdl:part name="parameters" element="tns:GetOrderResponse"/></wsdl:message>
  <wsdl:message name="ListOrdersRequest"><wsdl:part name="parameters" element="tns:ListOrders"/></wsdl:message>
  <wsdl:message name="ListOrdersResponse"><wsdl:part name="parameters" element="tns:ListOrdersResponse"/></wsdl:message>
  <wsdl:message name="CreateOrderRequest"><wsdl:part name="parameters" element="tns:CreateOrder"/></wsdl:message>
  <wsdl:message name="CreateOrderResponse"><wsdl:part name="parameters" element="tns:CreateOrderResponse"/></wsdl:message>

  <wsdl:portType name="OrderPortType">
    <wsdl:operation name="GetOrder">
      <wsdl:input message="tns:GetOrderRequest"/>
      <wsdl:output message="tns:GetOrderResponse"/>
    </wsdl:operation>
    <wsdl:operation name="ListOrders">
      <wsdl:input message="tns:ListOrdersRequest"/>
      <wsdl:output message="tns:ListOrdersResponse"/>
    </wsdl:operation>
    <wsdl:operation name="CreateOrder">
      <wsdl:input message="tns:CreateOrderRequest"/>
      <wsdl:output message="tns:CreateOrderResponse"/>
    </wsdl:operation>
  </wsdl:portType>

  <wsdl:binding name="OrderServiceSoapBinding" type="tns:OrderPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetOrder">
      <soap:operation soapAction="${TNS}/GetOrder" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="ListOrders">
      <soap:operation soapAction="${TNS}/ListOrders" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="CreateOrder">
      <soap:operation soapAction="${TNS}/CreateOrder" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>

  <wsdl:service name="OrderService">
    <wsdl:port name="OrderPort" binding="tns:OrderServiceSoapBinding">
      <soap:address location="http://localhost:${PORT}/OrderService"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;

const server = http.createServer(async (req, res) => {
  console.log(`[${NAME}] ${req.method} ${req.url}`);
  console.log(`[${NAME}] headers: ${JSON.stringify(req.headers)}`);

  if (req.method === 'GET') {
    if (/[?&]wsdl\b/i.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(WSDL);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${NAME}: SOAP endpoint at POST /OrderService, WSDL at GET /OrderService?wsdl\n`);
    }
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }

  const xml = await readBody(req);
  console.log(`[${NAME}] body: ${xml}`);
  // SOAP 1.2 carries the action inside Content-Type; 1.1 uses the SOAPAction header.
  const contentType = req.headers['content-type'] || '';
  const ns = contentType.includes('application/soap+xml') ? SOAP12 : SOAP11;
  const soapAction = (req.headers.soapaction || '').replace(/"/g, '').trim();
  const operation = operationOf(xml) || (soapAction ? localName(soapAction.split('/').pop()) : null);

  console.log(`[${NAME}] soap operation: ${operation || '<none>'} (soapAction: ${soapAction || '<none>'})`);

  const soapContentType = ns === SOAP12
    ? 'application/soap+xml; charset=utf-8'
    : 'text/xml; charset=utf-8';

  if (!operation) {
    res.writeHead(500, { 'Content-Type': soapContentType });
    res.end(faultXml(ns, 'Sender', 'Could not determine the operation: no parsable soap:Body'));
    return;
  }

  const body = responseFor(operation, xml, ns);
  if (!body) {
    res.writeHead(500, { 'Content-Type': soapContentType });
    res.end(faultXml(ns, 'Sender', `Unknown operation: ${operation}`));
    return;
  }

  res.writeHead(200, { 'Content-Type': soapContentType });
  res.end(body);
});

server.listen(PORT, () => console.log(`[${NAME}] mock SOAP backend listening on :${PORT} (WSDL: http://localhost:${PORT}/OrderService?wsdl)`));
