// test_endpoints.js
// Simple script to verify MCP GET endpoints and JSON-RPC on your Bio MCP server.
//
// Usage:
//   1. Ensure your MCP server is running (e.g. node dist/main.js or ts-node bio-mcp.ts).
//   2. Install node-fetch if using Node < 18:
//        npm install node-fetch
//   3. Run this script with node:
//        node test_endpoints.js
//
// The script will call tools/list via JSON-RPC and then call two GET endpoints
// (PubChem compound search and UniProt search) and print the results.

const fetch = (global.fetch ? global.fetch.bind(global) : (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args)));

async function test() {
  const base = process.env.MCP_BASE || 'http://localhost:8788/mcp';

  // 1) JSON-RPC call to list all tools
  const rpcResponse = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    })
  });
  const rpcJson = await rpcResponse.json();
  console.log('tools/list response:', JSON.stringify(rpcJson, null, 2));

  // 2) GET PubChem compound search
  const pubchemUrl = `${base}/pubchem.compound.search?namespace=name&identifier=caffeine&max=5`;
  const pubchemResponse = await fetch(pubchemUrl);
  const pubchemJson = await pubchemResponse.json();
  console.log('GET pubchem.compound.search:', JSON.stringify(pubchemJson, null, 2));

  // 3) GET UniProt search
  const uniprotUrl = `${base}/uniprot.search?query=TP53&size=5`;
  const uniprotResponse = await fetch(uniprotUrl);
  const uniprotJson = await uniprotResponse.json();
  console.log('GET uniprot.search:', JSON.stringify(uniprotJson, null, 2));
}

// Run the test and catch any errors
if (require.main === module) {
  test().catch((err) => {
    console.error('Error during test:', err);
    process.exit(1);
  });
}
