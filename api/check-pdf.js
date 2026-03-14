export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.startsWith('https://pastpapers.papacambridge.com/')) {
    return res.status(400).json({ exists: false, error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // Real files return application/pdf or audio/mpeg
    // Soft-404 redirects to homepage return text/html
    const contentType = response.headers.get('content-type') || '';
    const exists = response.ok && (
      contentType.includes('application/pdf') ||
      contentType.includes('audio/mpeg') ||
      contentType.includes('audio/mp3') ||
      contentType.includes('application/octet-stream')
    );

    return res.status(200).json({ exists });
  } catch (e) {
    return res.status(200).json({ exists: false, error: e.message });
  }
}
