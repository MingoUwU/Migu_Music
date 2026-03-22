const fetch = require('node-fetch');
const http = require('http');

async function test() {
  const videoId = '5d7tyklgwdI'; // Example YouTube ID
  const url = `http://localhost:3000/api/info/${videoId}`;
  
  console.log('Fetching info...');
  const resInfo = await fetch(url);
  const info = await resInfo.json();
  console.log('Stream URL:', info.proxyStreamUrl);

  console.log('Testing stream proxy...');
  const resStream = await fetch(`http://localhost:3000${info.proxyStreamUrl}`, {
    headers: { 'Range': 'bytes=0-' }
  });
  
  console.log('Status:', resStream.status);
  console.log('Headers:', JSON.stringify(resStream.headers.raw(), null, 2));
  
  const chunk = await resStream.buffer();
  console.log('Chunk received, size:', chunk.length);
  process.exit(0);
}

test().catch(console.error);
