const express = require('express');
const app = express();

app.get('/api/info/:id', (req, res) => {
  console.log('MATCHED! ID:', req.params.id);
  res.send('Matched: ' + req.params.id);
});

app.listen(3001, async () => {
  const url = encodeURIComponent('https://soundcloud.com/test/track?a=1&b=2');
  console.log('Fetching:', `/api/info/${url}`);
  try {
    const res = await fetch(`http://localhost:3001/api/info/${url}`);
    const text = await res.text();
    console.log('Response:', res.status, text);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
});
