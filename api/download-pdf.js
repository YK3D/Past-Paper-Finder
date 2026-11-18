export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.startsWith('https://pastpapers.papacambridge.com/')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual'
    });

    if (!response.ok || response.status !== 200) {
      return res.status(404).json({ error: 'File not found' });
    }

    // header-safe filename: drop query/hash and anything outside a conservative charset
    const filename = (url.split(/[?#]/)[0].split('/').pop() || 'paper.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
    const type = /\.mp3$/i.test(filename) ? 'audio/mpeg' : 'application/pdf';
    const buffer = await response.arrayBuffer();

    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    return res.status(200).send(Buffer.from(buffer));

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
